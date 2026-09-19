import type { SQL } from 'drizzle-orm';
import type { CustomerPage, ListCustomersQuery } from './customer.schema';
import type { CollectableLine, LockedCustomer } from './customers.balance';
import type { Database, Transaction } from '@/db/client';
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
}
