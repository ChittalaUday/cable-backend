import type {
  AddSubscriptionBody,
  ChangePlanBody,
  CreateCustomerBody,
  CustomerDetail,
  CustomerPage,
  CustomerProfile,
  ListCustomersQuery,
  Subscription,
} from './customer.schema';
import type { BillingCycle } from '@/constants/crm';
import type { Database, Transaction } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { CUSTOMER_STATUS, SUBSCRIPTION_STATUS } from '@/constants/crm';
import { ERROR_CODES } from '@/errors';
import { badRequest, conflict, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor, requireScope } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { CustomerRepository } from './customer.repository';
import { reachCondition } from './customers.list';

export { CustomerProfileResponse } from './customer.schema';
export { customerWithinNodes } from './customers.list';

const RECENT_TRANSACTIONS = 20;

interface PlannedLine {
  chosen: { id: string; serviceProviderId: string; billingCycle: BillingCycle; price: string };
  input: NonNullable<CreateCustomerBody['connection']>;
}

export interface CustomerAnnouncer {
  (event: { tenantId: string; customerId: string }): void;
}

/** A trimmed value, or null when nothing was actually typed. */
function trimmed(value: string | undefined): string | null {
  const text = value?.trim() ?? '';

  return text === '' ? null : text;
}

export class CustomerService {
  private readonly repo: CustomerRepository;

  constructor(
    repoOrDb: CustomerRepository | Database,
    private readonly announce: CustomerAnnouncer = () => {},
  ) {
    this.repo = 'findDetailRecord' in repoOrDb
      ? repoOrDb
      : new CustomerRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListCustomersQuery): Promise<CustomerPage> {
    return this.repo.list(access, query);
  }

  async detail(access: RequestAccess, id: string): Promise<CustomerDetail> {
    const reach = reachCondition(access);
    const customer = await this.repo.findDetailRecord(access.tenantId, id, reach);

    if (customer === null)
      throw notFound('Customer');

    const record = customer.row;

    const [lines, kit, ledger] = await Promise.all([
      this.subscriptionLines(access.tenantId, record.id),
      this.equipmentOf(access.tenantId, record.id),
      this.ledgerOf(access.tenantId, record.id),
    ]);

    const firstLocationId = lines[0]?.locationId ?? null;
    const paths = await this.repo.getLocationPaths(firstLocationId === null ? [] : [firstLocationId]);
    const active = lines.filter(line => line.status === CUSTOMER_STATUS.ACTIVE);

    return {
      id: record.id,
      customerCode: record.customerCode,
      name: customer.displayName,
      phone: customer.displayPhone,
      alternatePhone: record.alternatePhone,
      whatsappNumber: record.whatsappNumber,
      status: record.status,
      outstandingBalance: record.outstandingBalance,
      userId: record.userId,
      locationId: firstLocationId,
      locationPath: firstLocationId === null ? null : paths.get(firstLocationId) ?? null,
      address: record.address,
      notes: record.notes,
      subscriptions: lines,
      equipment: kit,
      recentTransactions: ledger,
      summary: {
        subscriptions: lines.length,
        activeSubscriptions: active.length,
        services: [...new Set(active.map(line => line.service.name))].sort(),
        monthlyValue: sumMoney(active.map(line => line.price)),
        outstandingBalance: record.outstandingBalance,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  async profileFor(tenantId: string, userId: string): Promise<CustomerProfile | null> {
    const customer = await this.repo.findProfile(tenantId, userId);

    if (customer === null)
      return null;

    const subscribed = await this.subscriptionLines(tenantId, customer.id);
    const active = subscribed.filter(item => item.status === CUSTOMER_STATUS.ACTIVE);

    return {
      id: customer.id,
      customerCode: customer.customerCode,
      status: customer.status,
      outstandingBalance: customer.outstandingBalance,
      alternatePhone: customer.alternatePhone,
      whatsappNumber: customer.whatsappNumber,
      locationId: subscribed[0]?.locationId ?? null,
      address: customer.address,
      subscriptions: subscribed,
      summary: {
        subscriptions: subscribed.length,
        activeSubscriptions: active.length,
        services: [...new Set(active.map(item => item.service.name))].sort(),
        outstandingBalance: customer.outstandingBalance,
      },
    };
  }

  /**
   * Move a line onto a different package.
   *
   * Nothing is prorated, because nothing accrues: `outstanding_balance` is only
   * ever written down by a payment — there is no cycle job that charges the
   * monthly fee. The new price is what the next charge will use, whenever that
   * is built. Add proration here the day accrual exists, not before.
   */
  async changePlan(
    access: RequestAccess,
    customerId: string,
    subscriptionId: string,
    input: ChangePlanBody,
  ): Promise<Subscription> {
    const changed = await this.repo.inTransaction(async (tx) => {
      const line = await this.reachableLine(tx, access, customerId, subscriptionId);
      const chosen = await this.samePackageProvider(tx, access.tenantId, input.packageId, line.serviceProviderId);

      if (chosen.id === line.packageId && input.price === undefined)
        throw conflict('That line is already on this package');

      const after = await this.repo.updateSubscription(tx, access.tenantId, line.id, {
        packageId: chosen.id,
        price: input.price ?? chosen.price,
        billingCycle: chosen.billingCycle,
      });

      await audit.updated(tx, access.audit, {
        entityType: AUDIT_ENTITIES.SUBSCRIPTION,
        entityId: line.id,
        before: line,
        after,
      });

      return this.lineOf(tx, access.tenantId, after.id);
    });

    this.changed(access.tenantId, customerId);
    return changed;
  }

  /**
   * Put another package on the customer as a line of its own.
   *
   * An addon is a subscription rather than a flag on one, because that is the
   * only shape the schema has: one package per line, one balance per line. It
   * also means an addon bills, collects and shows up on every screen that
   * already reads lines, with no new machinery anywhere.
   */
  /**
   * Register a subscriber, and optionally fit their first connection with them.
   *
   * One transaction, because a customer with no line is invisible to every
   * area-scoped screen in the app — half of this landing is worse than none of
   * it. The subscriber code comes from the database sequence rather than from
   * here, so two collectors at two doors cannot mint the same one.
   */
  async create(access: RequestAccess, input: CreateCustomerBody): Promise<CustomerDetail> {
    const scope = requireScope(access, PERMISSIONS.CUSTOMERS_CREATE);

    // An area-scoped caller can only reach customers through a line's location.
    // Letting them register one without a connection would file a subscriber
    // that they themselves could not open again.
    if (scope !== 'ALL' && input.connection === undefined) {
      throw badRequest(
        ERROR_CODES.VALIDATION_FAILED,
        'Registering without a connection needs customers.create at ALL — an area-scoped account must fit the first line',
      );
    }

    const address = trimmed(input.address);

    const id = await this.repo.inTransaction(async (tx) => {
      const line = input.connection === undefined
        ? null
        : await this.plannedLine(tx, access, scope, input.connection);

      const code = await this.repo.nextCustomerCode(tx, access.tenantId);

      const customer = await this.repo.insertCustomer(tx, {
        tenantId: access.tenantId,
        customerCode: code,
        name: input.name.trim(),
        phone: input.phone,
        alternatePhone: input.alternatePhone ?? null,
        whatsappNumber: input.whatsappNumber ?? null,
        address,
        notes: trimmed(input.notes),
        status: input.status ?? CUSTOMER_STATUS.ACTIVE,
        outstandingBalance: '0',
        createdBy: access.userId,
      });

      await audit.created(tx, access.audit, {
        entityType: AUDIT_ENTITIES.CUSTOMER,
        entityId: customer.id,
        after: customer,
      });

      if (line !== null)
        await this.fitFirstLine(tx, access, customer.id, code, address, line);

      return customer.id;
    });

    const created = await this.detail(access, id);
    this.changed(access.tenantId, id);
    return created;
  }

  /** The customer's first line, taking the subscriber code as its account number. */
  private async fitFirstLine(
    tx: Transaction,
    access: RequestAccess,
    customerId: string,
    code: string,
    address: string | null,
    line: PlannedLine,
  ): Promise<void> {
    const created = await this.repo.insertSubscription(tx, {
      tenantId: access.tenantId,
      customerId,
      serviceProviderId: line.chosen.serviceProviderId,
      packageId: line.chosen.id,
      // Addons suffix off this, so one customer's accounts read as a family.
      serviceAccountNumber: code,
      status: SUBSCRIPTION_STATUS.ACTIVE,
      startDate: new Date(),
      billingCycle: line.chosen.billingCycle,
      price: line.input.price ?? line.chosen.price,
      outstandingBalance: '0',
      installationLocationId: line.input.locationId,
      installationAddress: trimmed(line.input.installationAddress) ?? address,
    });

    await audit.created(tx, access.audit, {
      entityType: AUDIT_ENTITIES.SUBSCRIPTION,
      entityId: created.id,
      after: created,
    });
  }

  /** The package and location a first connection asks for, once both check out. */
  private async plannedLine(
    tx: Transaction,
    access: RequestAccess,
    scope: string,
    connection: NonNullable<CreateCustomerBody['connection']>,
  ): Promise<PlannedLine> {
    const chosen = await this.repo.findPackage(tx, access.tenantId, connection.packageId);

    if (chosen === null)
      throw notFound('Package');

    if (scope !== 'ALL') {
      const reach = locationScopeFor(access, PERMISSIONS.CUSTOMERS_CREATE);
      const reaches = reach.kind === 'ALL_TENANT_LOCATIONS'
        || (reach.nodeIds.length > 0
          && await this.repo.nodeUnderGrant(tx, connection.locationId, reach.nodeIds));

      if (!reaches) {
        throw badRequest(
          ERROR_CODES.PERM_SCOPE_DENIED,
          'That location is outside the areas this account covers',
        );
      }
    }

    return { chosen, input: connection };
  }

  async addSubscription(
    access: RequestAccess,
    customerId: string,
    input: AddSubscriptionBody,
  ): Promise<Subscription> {
    const added = await this.repo.inTransaction(async (tx) => {
      const base = await this.reachableLine(tx, access, customerId, input.basedOn);
      const chosen = await this.samePackageProvider(tx, access.tenantId, input.packageId, base.serviceProviderId);

      const taken = await this.repo.accountNumbersOf(tx, access.tenantId, customerId);

      const created = await this.repo.insertSubscription(tx, {
        tenantId: access.tenantId,
        customerId,
        serviceProviderId: base.serviceProviderId,
        packageId: chosen.id,
        serviceAccountNumber: nextAccountNumber(base.serviceAccountNumber, taken),
        status: SUBSCRIPTION_STATUS.ACTIVE,
        startDate: new Date(),
        billingCycle: chosen.billingCycle,
        price: input.price ?? chosen.price,
        outstandingBalance: '0',
        installationLocationId: base.installationLocationId,
        installationAddress: base.installationAddress,
      });

      await audit.created(tx, access.audit, {
        entityType: AUDIT_ENTITIES.SUBSCRIPTION,
        entityId: created.id,
        after: created,
      });

      return this.lineOf(tx, access.tenantId, created.id);
    });

    this.changed(access.tenantId, customerId);
    return added;
  }

  private changed(tenantId: string, customerId: string): void {
    this.announce({ tenantId, customerId });
  }

  /** The customer's line, once the caller is known to reach where it is fitted. */
  private async reachableLine(
    tx: Transaction,
    access: RequestAccess,
    customerId: string,
    subscriptionId: string,
  ) {
    const scope = requireScope(access, PERMISSIONS.CONNECTIONS_UPDATE);
    const line = await this.repo.findSubscription(tx, access.tenantId, customerId, subscriptionId);

    if (line === null)
      throw notFound('Subscription');

    if (scope !== 'ALL') {
      const reach = locationScopeFor(access, PERMISSIONS.CONNECTIONS_UPDATE);
      const reaches = reach.kind === 'ALL_TENANT_LOCATIONS'
        || (reach.nodeIds.length > 0
          && await this.repo.nodeUnderGrant(tx, line.installationLocationId, reach.nodeIds));

      // 404 rather than 403, the same answer `GET /customers/:id` gives: whether
      // a line exists outside your areas is not something to learn from an error.
      if (!reaches)
        throw notFound('Subscription');
    }

    return line;
  }

  /**
   * A package of this tenant, on the same provider as the line.
   *
   * Crossing providers would leave the line's service account number pointing at
   * a provider that never issued it — that is a new connection, not a plan change.
   */
  private async samePackageProvider(
    tx: Transaction,
    tenantId: string,
    packageId: string,
    serviceProviderId: string,
  ) {
    const chosen = await this.repo.findPackage(tx, tenantId, packageId);

    if (chosen === null)
      throw notFound('Package');

    if (chosen.serviceProviderId !== serviceProviderId)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'That package belongs to a different provider');

    return chosen;
  }

  /** Re-reads a written line in the shape every other endpoint returns it in. */
  private async lineOf(tx: Transaction, tenantId: string, subscriptionId: string): Promise<Subscription> {
    const row = await this.repo.findSubscriptionLine(tx, tenantId, subscriptionId);

    if (row === null)
      throw notFound('Subscription');

    return toLine(row);
  }

  private async equipmentOf(tenantId: string, customerId: string) {
    const rows = await this.repo.findEquipment(tenantId, customerId);

    return rows.map(row => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      name: (row.name !== null && row.name.length > 0) ? row.name : ([row.brand, row.model].filter(Boolean).join(' ') || 'Equipment'),
      serialNumber: row.serialNumber,
      status: row.status,
      assignedAt: row.assignedAt.toISOString(),
      returnedAt: row.returnedAt ? row.returnedAt.toISOString() : null,
    }));
  }

  private async ledgerOf(tenantId: string, customerId: string) {
    const rows = await this.repo.findLedger(tenantId, customerId, RECENT_TRANSACTIONS);

    return rows.map(row => ({
      id: row.id,
      transactionNo: row.transactionNo,
      transactionDate: row.transactionDate.toISOString(),
      transactionType: row.transactionType,
      serviceAccountNumber: row.serviceAccountNumber,
      debit: row.debit,
      credit: row.credit,
      closingBalance: row.closingBalance,
      remarks: row.remarks,
    }));
  }

  private async subscriptionLines(tenantId: string, customerId: string) {
    const lines = await this.repo.findSubscriptions(tenantId, customerId);

    return lines.map(toLine);
  }
}

type LineRow = Awaited<ReturnType<CustomerRepository['findSubscriptions']>>[number];

/** The one shape a subscription is rendered in, wherever it is read from. */
function toLine(line: LineRow): Subscription {
  return {
    id: line.subscription.id,
    serviceAccountNumber: line.subscription.serviceAccountNumber,
    status: line.subscription.status,
    startDate: line.subscription.startDate.toISOString(),
    endDate: line.subscription.endDate?.toISOString() ?? null,
    billingCycle: line.subscription.billingCycle,
    price: line.subscription.price,
    outstandingBalance: line.subscription.outstandingBalance,
    locationId: line.subscription.installationLocationId,
    installationAddress: line.subscription.installationAddress,
    service: { id: line.serviceId, name: line.serviceName, slug: line.serviceSlug, icon: line.serviceIcon },
    provider: { id: line.subscription.serviceProviderId, name: line.providerName, slug: line.providerSlug },
    package: { id: line.subscription.packageId, name: line.packageName, slug: line.packageSlug, packageType: line.packageType },
  };
}

/**
 * `SSCN-0042` and its addons become `SSCN-0042-A1`, `-A2`, and so on.
 *
 * Account numbers arrive with imported MSO data and have no generator, so an
 * added line is suffixed off the one it sits beside — readable on a receipt,
 * and traceable back to the connection it belongs to.
 */
function nextAccountNumber(base: string, taken: readonly string[]): string {
  const used = new Set(taken);

  for (let suffix = 1; ; suffix += 1) {
    const candidate = `${base}-A${suffix}`;

    if (!used.has(candidate))
      return candidate;
  }
}

export { CustomerService as CustomersService };

function sumMoney(values: string[]): string {
  const paise = values.reduce((total, value) => total + Math.round(Number(value) * 100), 0);

  return (paise / 100).toFixed(2);
}
