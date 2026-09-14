import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  CustomerDetail,
  CustomerPage,
  CustomerProfile,
  ListCustomersQuery,
} from './customers.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  accountTransactions,
  customerEquipment,
  customers,
  equipment,
  packages,
  serviceProviders,
  services,
  subscriptions,
  users,
} from '@/db/schema';
import { notFound } from '@/shared/errors/domain-error';
import { listCustomers, locationPaths, reachCondition } from './customers.list';
import { searchCustomers } from './customers.search';

export type Db = NodePgDatabase<typeof schema>;

/** The latest ledger lines a details page shows. The full history is its own call. */
const RECENT_TRANSACTIONS = 20;

/**
 * The module's public wire contract. Re-exported here because a cross-module
 * import may only reach a module's service (eslint `no-restricted-imports`), and
 * `/auth/me` embeds this shape in its own response schema.
 */
export { CustomerProfileResponse } from './customers.schema';

/**
 * The subscriber side of a signed-in account.
 *
 * A `users` row is an identity; a `crm.customers` row is what that identity buys
 * from one operator. They are separate because staff have the first and not the
 * second, and because the same person can be a customer of two operators — the
 * customer record is per tenant, the login is not.
 */
export class CustomersService {
  constructor(private readonly db: Db) {}

  /**
   * A page of customers for staff, scoped to what the caller may see.
   *
   * See `customers.list.ts` — data is hydrated in batches regardless of page
   * size, and keyset paging keeps deep pages fast.
   */
  async list(access: RequestAccess, query: ListCustomersQuery): Promise<CustomerPage> {
    return query.q === undefined
      ? listCustomers(this.db, access, query)
      : searchCustomers(this.db, access, query);
  }

  /**
   * The whole customer, in one request.
   *
   * A customer id is a handle onto a graph: subscriptions, and through each of
   * those a provider, a package, a service and a location. A client that walked
   * that graph over the public endpoints would make six or more calls for one
   * page, most of them repeating work. Four queries here, run together, resolve
   * all of it — the joins are indexed and cost the database nothing.
   */
  async detail(access: RequestAccess, id: string): Promise<CustomerDetail> {
    // The caller's reach is part of the lookup, not a check after it. The detail
    // route is directly addressable, so an id from anywhere would otherwise read
    // a customer in an area this caller was never granted — and a separate check
    // is a second query and a second chance to forget it.
    const reach = reachCondition(access);

    const [customer] = reach === null
      ? []
      : await this.db
          .select({
            row: customers,
            // `auth.users` is the identity of record once there is a login;
            // `customers.name` is the imported fallback. Same rule as the list.
            displayName: sql<string | null>`coalesce(${users.name}, ${customers.name})`,
            displayPhone: sql<string | null>`coalesce(${users.phone}, ${customers.phone})`,
          })
          .from(customers)
          .leftJoin(users, eq(users.id, customers.userId))
          .where(and(
            eq(customers.tenantId, access.tenantId),
            eq(customers.id, id),
            isNull(customers.deletedAt),
            ...reach,
          ))
          .limit(1);

    // Out of reach answers 404, not 403: whether a customer exists in someone
    // else's area is not this caller's business either.
    if (customer === undefined)
      throw notFound('Customer');

    const record = customer.row;

    const [lines, kit, ledger] = await Promise.all([
      this.subscriptionLines(access.tenantId, record.id),
      this.equipmentOf(access.tenantId, record.id),
      this.ledgerOf(access.tenantId, record.id),
    ]);

    const paths = await locationPaths(this.db, record.locationId === null ? [] : [record.locationId]);
    const active = lines.filter(line => line.status === 'active');

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
      locationId: record.locationId,
      locationPath: record.locationId === null ? null : paths.get(record.locationId) ?? null,
      address: record.address,
      notes: record.notes,
      subscriptions: lines,
      equipment: kit,
      recentTransactions: ledger,
      summary: {
        subscriptions: lines.length,
        activeSubscriptions: active.length,
        services: [...new Set(active.map(line => line.service.name))].sort(),
        // Money stays a decimal string on the wire (§8); summed in cents so the
        // total never picks up a float's rounding error.
        monthlyValue: sumMoney(active.map(line => line.price)),
        outstandingBalance: record.outstandingBalance,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  /**
   * Everything a subscriber's own app needs on open, in two queries.
   *
   * `null` for anyone who is not a customer of this tenant — staff and admins
   * are the normal case, and they cost one indexed lookup that finds nothing.
   */
  async profileFor(tenantId: string, userId: string): Promise<CustomerProfile | null> {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(
        eq(customers.tenantId, tenantId),
        eq(customers.userId, userId),
        isNull(customers.deletedAt),
      ))
      .limit(1);

    if (customer === undefined)
      return null;

    const subscribed = await this.subscriptionLines(tenantId, customer.id);
    const active = subscribed.filter(item => item.status === 'active');

    return {
      id: customer.id,
      customerCode: customer.customerCode,
      status: customer.status,
      outstandingBalance: customer.outstandingBalance,
      alternatePhone: customer.alternatePhone,
      whatsappNumber: customer.whatsappNumber,
      locationId: customer.locationId,
      address: customer.address,
      subscriptions: subscribed,
      summary: {
        subscriptions: subscribed.length,
        activeSubscriptions: active.length,
        // What they are actually on, deduplicated — "Cable TV, Broadband" is the
        // line a home screen renders, and it should not need the full list.
        services: [...new Set(active.map(item => item.service.name))].sort(),
        outstandingBalance: customer.outstandingBalance,
      },
    };
  }

  /** Set-top boxes and remotes on loan, newest assignment first. */
  private async equipmentOf(tenantId: string, customerId: string) {
    const rows = await this.db
      .select({
        id: customerEquipment.id,
        subscriptionId: customerEquipment.subscriptionId,
        equipmentType: equipment.equipmentType,
        brand: equipment.brand,
        model: equipment.model,
        serialNumber: equipment.serialNumber,
        status: customerEquipment.status,
        assignedAt: customerEquipment.assignedAt,
        returnedAt: customerEquipment.returnedAt,
      })
      .from(customerEquipment)
      .innerJoin(equipment, eq(equipment.id, customerEquipment.equipmentId))
      .where(and(
        eq(customerEquipment.tenantId, tenantId),
        eq(customerEquipment.customerId, customerId),
      ))
      .orderBy(desc(customerEquipment.assignedAt));

    return rows.map(row => ({
      id: row.id,
      subscriptionId: row.subscriptionId,
      name: [row.brand, row.model].filter(Boolean).join(' ') || row.equipmentType,
      serialNumber: row.serialNumber,
      status: row.status,
      assignedAt: row.assignedAt.toISOString(),
      returnedAt: row.returnedAt?.toISOString() ?? null,
    }));
  }

  /** The latest ledger lines. The full history is its own call, when there is one. */
  private async ledgerOf(tenantId: string, customerId: string) {
    const rows = await this.db
      .select()
      .from(accountTransactions)
      .where(and(
        eq(accountTransactions.tenantId, tenantId),
        eq(accountTransactions.customerId, customerId),
      ))
      .orderBy(desc(accountTransactions.transactionDate))
      .limit(RECENT_TRANSACTIONS);

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

  /**
   * A subscription with its provider, package and service already attached.
   *
   * One definition, used by both the subscriber's own profile and the staff
   * detail page — the shape a client renders is the same either way, and two
   * copies of this join is how the two views quietly drift apart.
   */
  private async subscriptionLines(tenantId: string, customerId: string) {
    const lines = await this.db
      .select({
        subscription: subscriptions,
        packageName: packages.name,
        packageSlug: packages.slug,
        packageType: packages.packageType,
        providerName: serviceProviders.name,
        providerSlug: serviceProviders.slug,
        serviceId: services.id,
        serviceName: services.name,
        serviceSlug: services.slug,
        serviceIcon: services.icon,
      })
      .from(subscriptions)
      .innerJoin(packages, eq(packages.id, subscriptions.packageId))
      .innerJoin(serviceProviders, eq(serviceProviders.id, subscriptions.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        isNull(subscriptions.deletedAt),
      ))
      .orderBy(desc(subscriptions.startDate));

    return lines.map(line => ({
      id: line.subscription.id,
      serviceAccountNumber: line.subscription.serviceAccountNumber,
      status: line.subscription.status,
      startDate: line.subscription.startDate.toISOString(),
      endDate: line.subscription.endDate?.toISOString() ?? null,
      billingCycle: line.subscription.billingCycle,
      // Money crosses the wire as a string (§8) — `numeric` already is one.
      price: line.subscription.price,
      locationId: line.subscription.locationId,
      installationAddress: line.subscription.installationAddress,
      service: { id: line.serviceId, name: line.serviceName, slug: line.serviceSlug, icon: line.serviceIcon },
      provider: { id: line.subscription.serviceProviderId, name: line.providerName, slug: line.providerSlug },
      package: { id: line.subscription.packageId, name: line.packageName, slug: line.packageSlug, packageType: line.packageType },
    }));
  }
}

/**
 * Add decimal strings without going through a float.
 *
 * `0.1 + 0.2` is the reason: money is a string on the wire and `numeric` in the
 * database precisely so it never becomes a double, and summing it in JavaScript
 * would undo that at the last step.
 */
function sumMoney(values: string[]): string {
  const paise = values.reduce((total, value) => total + Math.round(Number(value) * 100), 0);

  return (paise / 100).toFixed(2);
}
