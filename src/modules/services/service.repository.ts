import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import type { LocationScope } from '@/security/location-scope';
import { and, asc, count, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { owned } from '@/db/owned';
import { packages, serviceProviders, services, subscriptions } from '@/db/schema';
import { likeTerm } from '@/utils/search';
import { coverageReachesGrant } from './coverage.scope';

const ACTIVE_PACKAGE_COUNT = sql<number>`(
  SELECT count(*)::int FROM crm.packages pkg
  WHERE pkg.service_provider_id = crm.service_providers.id
    AND pkg.deleted_at IS NULL AND pkg.status = 'active'
)`;

const ACTIVE_PROVIDER_COUNT = sql<number>`(
  SELECT count(*)::int FROM crm.service_providers p
  WHERE p.service_id = crm.services.id
    AND p.deleted_at IS NULL AND p.status = 'active'
)`;

const LIVE_SUBSCRIPTION_STATUSES = ['active', 'suspended'] as const;

export interface ServiceFilter {
  status?: typeof services.status.enumValues[number];
  q?: string;
}

export interface ProviderFilter {
  serviceId?: string;
  status?: typeof serviceProviders.status.enumValues[number];
  search?: string;
}

export type ServiceRecord = typeof services.$inferSelect;
export type ProviderRecord = typeof serviceProviders.$inferSelect;

export interface ProviderRow {
  provider: ProviderRecord;
  serviceName: string;
  serviceIcon: string | null;
  packageCount: number;
}

export class ServiceRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  servicesInReach(tenantId: string, scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId,
      serviceId: sql`${services.id}`,
      serviceProviderId: null,
      packageId: null,
    }, scope.nodeIds)];
  }

  providersInReach(tenantId: string, scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId,
      serviceId: sql`${serviceProviders.serviceId}`,
      serviceProviderId: sql`${serviceProviders.id}`,
      packageId: null,
    }, scope.nodeIds)];
  }

  async listServices(tenantId: string, filter: ServiceFilter, reach: SQL[]) {
    const filters: SQL[] = [eq(services.tenantId, tenantId), isNull(services.deletedAt), ...reach];

    if (filter.status !== undefined)
      filters.push(eq(services.status, filter.status));
    if (filter.q !== undefined)
      filters.push(ilike(services.name, likeTerm(filter.q)));

    return this.db
      .select({ service: services, providerCount: ACTIVE_PROVIDER_COUNT })
      .from(services)
      .where(and(...filters))
      .orderBy(asc(services.name));
  }

  async findService(tenantId: string, id: string, reach: SQL[]): Promise<ServiceRecord | null> {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(owned(services, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  async serviceExists(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .limit(1);

    return row !== undefined;
  }

  async createService(data: typeof services.$inferInsert): Promise<ServiceRecord> {
    const [row] = await this.db.insert(services).values(data).returning();
    return row!;
  }

  async updateService(tenantId: string, id: string, data: Partial<typeof services.$inferInsert>) {
    return this.db
      .update(services)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));
  }

  async softDeleteService(tenantId: string, id: string, status: typeof services.status.enumValues[number]) {
    return this.db
      .update(services)
      .set({ deletedAt: new Date(), status, updatedAt: new Date() })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));
  }

  async countLiveProviders(tenantId: string, serviceId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(serviceProviders)
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        eq(serviceProviders.serviceId, serviceId),
        isNull(serviceProviders.deletedAt),
      ));

    return row?.total ?? 0;
  }

  async takenServiceSlugs(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: services.slug })
      .from(services)
      .where(eq(services.tenantId, tenantId));

    return rows.map(row => row.slug);
  }

  private providerSelection() {
    return {
      provider: serviceProviders,
      serviceName: services.name,
      serviceIcon: services.icon,
      packageCount: ACTIVE_PACKAGE_COUNT,
    };
  }

  async listProviders(tenantId: string, filter: ProviderFilter, reach: SQL[]): Promise<ProviderRow[]> {
    const filters: SQL[] = [
      eq(serviceProviders.tenantId, tenantId),
      isNull(serviceProviders.deletedAt),
      ...reach,
    ];

    if (filter.serviceId !== undefined)
      filters.push(eq(serviceProviders.serviceId, filter.serviceId));
    if (filter.status !== undefined)
      filters.push(eq(serviceProviders.status, filter.status));
    if (filter.search !== undefined && filter.search.trim() !== '') {
      const q = `%${filter.search.trim()}%`;
      filters.push(or(
        ilike(serviceProviders.name, q),
        ilike(serviceProviders.code, q),
        ilike(services.name, q),
      )!);
    }

    return this.db
      .select(this.providerSelection())
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(...filters))
      .orderBy(asc(services.name), asc(serviceProviders.name));
  }

  /** Providers of one service, for the service detail payload. */
  async listProvidersOfService(tenantId: string, serviceId: string, reach: SQL[]) {
    return this.db
      .select({ provider: serviceProviders, packageCount: ACTIVE_PACKAGE_COUNT })
      .from(serviceProviders)
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        eq(serviceProviders.serviceId, serviceId),
        isNull(serviceProviders.deletedAt),
        ...reach,
      ))
      .orderBy(asc(serviceProviders.name));
  }

  async findProvider(tenantId: string, id: string, reach: SQL[]): Promise<ProviderRow | null> {
    const [row] = await this.db
      .select(this.providerSelection())
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(owned(serviceProviders, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  async createProvider(
    tenantId: string,
    data: typeof serviceProviders.$inferInsert,
    makeDefault: boolean,
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(serviceProviders).values(data).returning({ id: serviceProviders.id });

      if (makeDefault)
        await this.clearOtherDefaults(tx, tenantId, data.serviceId, row!.id);

      return row!.id;
    });
  }

  async updateProvider(
    tenantId: string,
    id: string,
    serviceId: string,
    data: Partial<typeof serviceProviders.$inferInsert>,
  ) {
    return this.db.transaction(async (tx) => {
      await tx
        .update(serviceProviders)
        .set({ ...data, updatedAt: new Date() })
        .where(and(
          eq(serviceProviders.tenantId, tenantId),
          eq(serviceProviders.id, id),
          isNull(serviceProviders.deletedAt),
        ));

      if (data.isDefault === true)
        await this.clearOtherDefaults(tx, tenantId, serviceId, id);
    });
  }

  async softDeleteProvider(tenantId: string, id: string, status: typeof serviceProviders.status.enumValues[number]) {
    return this.db
      .update(serviceProviders)
      .set({ deletedAt: new Date(), status, isDefault: false, updatedAt: new Date() })
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        eq(serviceProviders.id, id),
        isNull(serviceProviders.deletedAt),
      ));
  }

  async countLiveSubscriptionsOfProvider(tenantId: string, providerId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.serviceProviderId, providerId),
        isNull(subscriptions.deletedAt),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ));

    return row?.total ?? 0;
  }

  async countLivePackagesOfProvider(tenantId: string, providerId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(packages)
      .where(and(
        eq(packages.tenantId, tenantId),
        eq(packages.serviceProviderId, providerId),
        isNull(packages.deletedAt),
      ));

    return row?.total ?? 0;
  }

  async takenProviderSlugs(tenantId: string, serviceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: serviceProviders.slug })
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.serviceId, serviceId)));

    return rows.map(row => row.slug);
  }

  // `is_default` is a single-winner flag, and the winner is per tenant: without
  // the tenant predicate this write reaches every tenant that shares the
  // service id.
  private async clearOtherDefaults(tx: Transaction, tenantId: string, serviceId: string, keepId: string) {
    await tx
      .update(serviceProviders)
      .set({ isDefault: false })
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        eq(serviceProviders.serviceId, serviceId),
        ne(serviceProviders.id, keepId),
      ));
  }
}
