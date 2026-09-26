import type { SQL } from 'drizzle-orm';
import type { CustomerPage, ListCustomersQuery } from './customer.schema';
import type { CollectableLine, LockedCustomer } from './customers.balance';
import type { Database, Transaction } from '@/db/client';
import type { Customer, NewCustomer, NewSubscription, Subscription } from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  accountTransactions,
  customerEquipment,
  customers,
  equipment,
  itemCatalog,
  packages,
  serviceProviders,
  services,
  subscriptions,
  users,
} from '@/db/schema';
import { underAnyGrant } from '@/security/location-scope';
import {
  applyDuesPayment,
  findCollectableLine,
  lockCustomer,
} from './customers.balance';
import { listCustomers, locationPaths } from './customers.list';
import { searchCustomers } from './customers.search';

export type { CollectableLine, LockedCustomer } from './customers.balance';

export class CustomerRepository {
  constructor(private readonly db: Database) {}

  async list(access: RequestAccess, query: ListCustomersQuery): Promise<CustomerPage> {
    return query.q === undefined
      ? listCustomers(this.db, access, query)
      : searchCustomers(this.db, access, query);
  }

  async findDetailRecord(tenantId: string, id: string, reach: SQL[] | null) {
    if (reach === null)
      return null;

    const [customer] = await this.db
      .select({
        row: customers,
        displayName: sql<string | null>`coalesce(${users.name}, ${customers.name})`,
        displayPhone: sql<string | null>`coalesce(${users.phone}, ${customers.phone})`,
      })
      .from(customers)
      .leftJoin(users, eq(users.id, customers.userId))
      .where(and(
        eq(customers.tenantId, tenantId),
        eq(customers.id, id),
        isNull(customers.deletedAt),
        ...reach,
      ))
      .limit(1);

    return customer ?? null;
  }

  async findProfile(tenantId: string, userId: string) {
    const [customer] = await this.db
      .select()
      .from(customers)
      .where(and(
        eq(customers.tenantId, tenantId),
        eq(customers.userId, userId),
        isNull(customers.deletedAt),
      ))
      .limit(1);

    return customer ?? null;
  }

  async findSubscriptions(tenantId: string, customerId: string) {
    return this.db
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
  }

  async findEquipment(tenantId: string, customerId: string) {
    return this.db
      .select({
        id: customerEquipment.id,
        subscriptionId: customerEquipment.subscriptionId,
        name: itemCatalog.name,
        brand: itemCatalog.brand,
        model: itemCatalog.model,
        serialNumber: equipment.serialNumber,
        status: customerEquipment.status,
        assignedAt: customerEquipment.assignedAt,
        returnedAt: customerEquipment.returnedAt,
      })
      .from(customerEquipment)
      .innerJoin(equipment, eq(equipment.id, customerEquipment.equipmentId))
      .leftJoin(itemCatalog, eq(itemCatalog.id, equipment.catalogId))
      .where(and(
        eq(customerEquipment.tenantId, tenantId),
        eq(customerEquipment.customerId, customerId),
      ))
      .orderBy(desc(customerEquipment.assignedAt));
  }

  async findLedger(tenantId: string, customerId: string, limit = 20) {
    return this.db
      .select()
      .from(accountTransactions)
      .where(and(
        eq(accountTransactions.tenantId, tenantId),
        eq(accountTransactions.customerId, customerId),
      ))
      .orderBy(desc(accountTransactions.transactionDate))
      .limit(limit);
  }

  async getLocationPaths(locationIds: string[]) {
    return locationPaths(this.db, locationIds);
  }

  // The balance a collector settles lives on these tables, so payments reaches
  // it through here rather than writing `crm.customers` itself. Each takes the
  // caller's `tx`: the row lock only holds inside their transaction.
  async lockCustomer(tx: Transaction, tenantId: string, customerId: string): Promise<LockedCustomer | null> {
    return lockCustomer(tx, tenantId, customerId);
  }

  async collectableLines(tx: Transaction, tenantId: string, customerId: string, subscriptionId: string | null): Promise<CollectableLine[]> {
    return findCollectableLine(tx, tenantId, customerId, subscriptionId);
  }

  async applyDuesPayment(tx: Transaction, tenantId: string, customerId: string, subscriptionId: string, amount: string): Promise<void> {
    return applyDuesPayment(tx, tenantId, customerId, subscriptionId, amount);
  }

  // --- Customer writes -------------------------------------------------------

  /**
   * The next subscriber code for this tenant, from the database.
   *
   * A sequence in Postgres rather than a max()+1 here, because two collectors
   * registering at the same door on the same afternoon must not be handed the
   * same code.
   */
  async nextCustomerCode(tx: Transaction, tenantId: string): Promise<string> {
    const { rows } = await tx.execute<{ code: string }>(
      sql`SELECT crm.next_customer_code(${tenantId}) AS code`,
    );

    return rows[0]!.code;
  }

  async insertCustomer(tx: Transaction, values: NewCustomer): Promise<Customer> {
    const [row] = await tx.insert(customers).values(values).returning();

    return row!;
  }

  // --- Subscription writes ---------------------------------------------------

  async inTransaction<T>(run: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(run);
  }

  /** One line of this customer, or null — never another customer's line. */
  async findSubscription(tx: Transaction, tenantId: string, customerId: string, subscriptionId: string) {
    const [row] = await tx
      .select()
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        eq(subscriptions.id, subscriptionId),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  async findPackage(tx: Transaction, tenantId: string, packageId: string) {
    const [row] = await tx
      .select()
      .from(packages)
      .where(and(
        eq(packages.tenantId, tenantId),
        eq(packages.id, packageId),
        isNull(packages.deletedAt),
      ))
      .limit(1);

    return row ?? null;
  }

  /** The account numbers already in use on this customer, to derive the next one. */
  async accountNumbersOf(tx: Transaction, tenantId: string, customerId: string): Promise<string[]> {
    const rows = await tx
      .select({ accountNumber: subscriptions.serviceAccountNumber })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.customerId, customerId),
        isNull(subscriptions.deletedAt),
      ));

    return rows.map(row => row.accountNumber);
  }

  async updateSubscription(
    tx: Transaction,
    tenantId: string,
    subscriptionId: string,
    patch: Partial<Pick<Subscription, 'packageId' | 'price' | 'billingCycle'>>,
  ): Promise<Subscription> {
    const [row] = await tx
      .update(subscriptions)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(subscriptions.tenantId, tenantId), eq(subscriptions.id, subscriptionId)))
      .returning();

    return row!;
  }

  async insertSubscription(tx: Transaction, values: NewSubscription): Promise<Subscription> {
    const [row] = await tx.insert(subscriptions).values(values).returning();

    return row!;
  }

  /** The joined shape `findSubscriptions` returns, for one line. */
  async findSubscriptionLine(tx: Transaction, tenantId: string, subscriptionId: string) {
    const [row] = await tx
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
      .where(and(eq(subscriptions.tenantId, tenantId), eq(subscriptions.id, subscriptionId)))
      .limit(1);

    return row ?? null;
  }

  /** Whether a location sits under any node the caller was granted. */
  async nodeUnderGrant(tx: Transaction, locationId: string, nodeIds: readonly string[]): Promise<boolean> {
    const { rows } = await tx.execute<{ reached: boolean }>(sql`
      SELECT ${underAnyGrant(sql`${locationId}::uuid`, nodeIds)} AS reached
    `);

    return rows[0]?.reached === true;
  }
}
