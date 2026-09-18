import type {
  CustomerDetail,
  CustomerPage,
  CustomerProfile,
  ListCustomersQuery,
} from './customer.schema';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import { CUSTOMER_STATUS } from '@/constants/crm';
import { notFound } from '@/errors/domain-error';
import { CustomerRepository } from './customer.repository';
import { reachCondition } from './customers.list';

export { CustomerProfileResponse } from './customer.schema';
export { customerWithinNodes } from './customers.list';

const RECENT_TRANSACTIONS = 20;

export class CustomerService {
  private readonly repo: CustomerRepository;

  constructor(repoOrDb: CustomerRepository | Database) {
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

    return lines.map(line => ({
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
    }));
  }
}

export { CustomerService as CustomersService };

function sumMoney(values: string[]): string {
  const paise = values.reduce((total, value) => total + Math.round(Number(value) * 100), 0);

  return (paise / 100).toFixed(2);
}
