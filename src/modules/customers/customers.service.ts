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
  itemCatalog,
  packages,
  serviceProviders,
  services,
  subscriptions,
  users,
} from '@/db/schema';
import { CUSTOMER_STATUS } from '@/shared/constants/crm';
import { notFound } from '@/shared/errors/domain-error';
import { listCustomers, locationPaths, reachCondition } from './customers.list';
import { searchCustomers } from './customers.search';

export type Db = NodePgDatabase<typeof schema>;

const RECENT_TRANSACTIONS = 20;

export { customerWithinNodes } from './customers.list';

export { CustomerProfileResponse } from './customers.schema';

export class CustomersService {
  constructor(private readonly db: Db) {}

  async list(access: RequestAccess, query: ListCustomersQuery): Promise<CustomerPage> {
    return query.q === undefined
      ? listCustomers(this.db, access, query)
      : searchCustomers(this.db, access, query);
  }

  async detail(access: RequestAccess, id: string): Promise<CustomerDetail> {
    const reach = reachCondition(access);

    const [customer] = reach === null
      ? []
      : await this.db
          .select({
            row: customers,
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

    if (customer === undefined)
      throw notFound('Customer');

    const record = customer.row;

    const [lines, kit, ledger] = await Promise.all([
      this.subscriptionLines(access.tenantId, record.id),
      this.equipmentOf(access.tenantId, record.id),
      this.ledgerOf(access.tenantId, record.id),
    ]);

    const paths = await locationPaths(this.db, record.locationId === null ? [] : [record.locationId]);
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
        monthlyValue: sumMoney(active.map(line => line.price)),
        outstandingBalance: record.outstandingBalance,
      },
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

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
    const active = subscribed.filter(item => item.status === CUSTOMER_STATUS.ACTIVE);

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
        services: [...new Set(active.map(item => item.service.name))].sort(),
        outstandingBalance: customer.outstandingBalance,
      },
    };
  }

  private async equipmentOf(tenantId: string, customerId: string) {
    const rows = await this.db
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
      price: line.subscription.price,
      locationId: line.subscription.locationId,
      installationAddress: line.subscription.installationAddress,
      service: { id: line.serviceId, name: line.serviceName, slug: line.serviceSlug, icon: line.serviceIcon },
      provider: { id: line.subscription.serviceProviderId, name: line.providerName, slug: line.providerSlug },
      package: { id: line.subscription.packageId, name: line.packageName, slug: line.packageSlug, packageType: line.packageType },
    }));
  }
}

function sumMoney(values: string[]): string {
  const paise = values.reduce((total, value) => total + Math.round(Number(value) * 100), 0);

  return (paise / 100).toFixed(2);
}
