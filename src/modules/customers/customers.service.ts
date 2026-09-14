import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { CustomerProfile } from './customers.schema';
import type * as schema from '@/db/schema';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  customers,
  packages,
  serviceProviders,
  services,
  subscriptions,
} from '@/db/schema';

type Db = NodePgDatabase<typeof schema>;

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
        eq(subscriptions.customerId, customer.id),
        isNull(subscriptions.deletedAt),
      ))
      .orderBy(desc(subscriptions.startDate));

    const subscribed = lines.map(line => ({
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
}
