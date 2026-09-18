import type { SQL } from 'drizzle-orm';
import type {
  CreateProviderBody,
  CreateServiceBody,
  ListProvidersQuery,
  ListServicesQuery,
  ProviderResponse,
  ServiceResponse,
  UpdateProviderBody,
  UpdateServiceBody,
} from '../service.schema';
import type { Database as Db, Transaction as Tx } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import { and, asc, count, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { ENTITY_STATUS } from '@/constants/crm';
import { owned } from '@/db/owned';
import { packages, serviceProviders, services, subscriptions } from '@/db/schema';
import { isUniqueViolation } from '@/errors';
import { conflict, inUse, orNotFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { likeTerm } from '@/utils/search';
import { uniqueSlug } from '@/utils/slug';
import { coverageReachesGrant } from '../coverage.scope';

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

export class ServicesService {
  constructor(private readonly db: Db) {}

  private reaching(access: RequestAccess, key: PermissionKey, target: {
    serviceId: SQL;
    serviceProviderId?: SQL;
  }): SQL[] {
    const reach = locationScopeFor(access, key);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId: access.tenantId,
      serviceId: target.serviceId,
      serviceProviderId: target.serviceProviderId ?? null,
      packageId: null,
    }, reach.nodeIds)];
  }

  private servicesInReach(access: RequestAccess, key: PermissionKey): SQL[] {
    return this.reaching(access, key, { serviceId: sql`${services.id}` });
  }

  private providersInReach(access: RequestAccess, key: PermissionKey): SQL[] {
    return this.reaching(access, key, {
      serviceId: sql`${serviceProviders.serviceId}`,
      serviceProviderId: sql`${serviceProviders.id}`,
    });
  }

  async list(access: RequestAccess, query: ListServicesQuery): Promise<ServiceResponse[]> {
    const { tenantId } = access;
    const filters = [
      eq(services.tenantId, tenantId),
      isNull(services.deletedAt),
      ...this.servicesInReach(access, PERMISSIONS.SERVICES_VIEW),
    ];

    if (query.status !== undefined)
      filters.push(eq(services.status, query.status));
    if (query.q !== undefined)
      filters.push(ilike(services.name, likeTerm(query.q)));

    const rows = await this.db
      .select({
        service: services,
        providerCount: ACTIVE_PROVIDER_COUNT,
      })
      .from(services)
      .where(and(...filters))
      .orderBy(asc(services.name));

    const providerRows = await this.db
      .select({
        provider: serviceProviders,
        serviceName: services.name,
        serviceIcon: services.icon,
        packageCount: ACTIVE_PACKAGE_COUNT,
      })
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        isNull(serviceProviders.deletedAt),
        ...this.providersInReach(access, PERMISSIONS.SERVICES_VIEW),
      ))
      .orderBy(asc(serviceProviders.name));

    const providersByService = new Map<string, ProviderResponse[]>();
    for (const p of providerRows) {
      const list = providersByService.get(p.provider.serviceId) ?? [];
      list.push(this.presentProvider(p.provider, {
        serviceName: p.serviceName,
        serviceIcon: p.serviceIcon,
        packageCount: p.packageCount,
      }));
      providersByService.set(p.provider.serviceId, list);
    }

    return rows.map(row => this.presentService(
      row.service,
      row.providerCount,
      providersByService.get(row.service.id) ?? [],
    ));
  }

  async get(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.SERVICES_VIEW): Promise<ServiceResponse> {
    const row = await this.findService(access, id, key);
    const providerRows = await this.db
      .select({
        provider: serviceProviders,
        packageCount: ACTIVE_PACKAGE_COUNT,
      })
      .from(serviceProviders)
      .where(and(
        eq(serviceProviders.tenantId, access.tenantId),
        eq(serviceProviders.serviceId, id),
        isNull(serviceProviders.deletedAt),
        ...this.providersInReach(access, key),
      ))
      .orderBy(asc(serviceProviders.name));

    const providers = providerRows.map(p => this.presentProvider(p.provider, {
      serviceName: row.name,
      serviceIcon: row.icon,
      packageCount: p.packageCount,
    }));
    const activeCount = providers.filter(p => p.status === ENTITY_STATUS.ACTIVE).length;

    return this.presentService(row, activeCount, providers);
  }

  async create({ tenantId, audit: context }: RequestAccess, input: CreateServiceBody): Promise<ServiceResponse> {
    const slug = input.slug ?? uniqueSlug(input.name, await this.takenServiceSlugs(tenantId));

    try {
      const [row] = await this.db
        .insert(services)
        .values({ tenantId, ...input, slug, metadata: input.metadata ?? null })
        .returning();

      const created = this.presentService(row!, 0, []);
      await audit.created(this.db, context, { entityType: AUDIT_ENTITIES.SERVICE, entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A service named "${input.name}" already exists`);
      throw error;
    }
  }

  async update(access: RequestAccess, id: string, patch: UpdateServiceBody): Promise<ServiceResponse> {
    const before = await this.get(access, id, PERMISSIONS.SERVICES_UPDATE);

    await this.db
      .update(services)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(services.tenantId, access.tenantId), eq(services.id, id)));

    const after = await this.get(access, id);
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const { tenantId, audit: context } = access;
    const [exists] = await this.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .limit(1);

    if (exists === undefined)
      return;

    const before = await this.findService(access, id, PERMISSIONS.SERVICES_DELETE);

    const [providers] = await this.db
      .select({ total: count() })
      .from(serviceProviders)
      .where(and(eq(serviceProviders.serviceId, id), isNull(serviceProviders.deletedAt)));

    if ((providers?.total ?? 0) > 0)
      throw inUse('This service still has providers; remove them first');

    await this.db
      .update(services)
      .set({ deletedAt: new Date(), status: ENTITY_STATUS.INACTIVE })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));

    await audit.deleted(this.db, context, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before });
  }

  async listProviders(access: RequestAccess, query: ListProvidersQuery): Promise<ProviderResponse[]> {
    const filters = [
      eq(serviceProviders.tenantId, access.tenantId),
      isNull(serviceProviders.deletedAt),
      ...this.providersInReach(access, PERMISSIONS.SERVICES_VIEW),
    ];

    if (query.serviceId !== undefined)
      filters.push(eq(serviceProviders.serviceId, query.serviceId));
    if (query.status !== undefined)
      filters.push(eq(serviceProviders.status, query.status));
    if (query.search !== undefined && query.search.trim() !== '') {
      const q = `%${query.search.trim()}%`;
      filters.push(or(
        ilike(serviceProviders.name, q),
        ilike(serviceProviders.code, q),
        ilike(services.name, q),
      )!);
    }

    const rows = await this.db
      .select({
        provider: serviceProviders,
        serviceName: services.name,
        serviceIcon: services.icon,
        packageCount: ACTIVE_PACKAGE_COUNT,
      })
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(...filters))
      .orderBy(asc(services.name), asc(serviceProviders.name));

    return rows.map(row => this.presentProvider(row.provider, {
      serviceName: row.serviceName,
      serviceIcon: row.serviceIcon,
      packageCount: row.packageCount,
    }));
  }

  async getProvider(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.SERVICES_VIEW): Promise<ProviderResponse> {
    const { tenantId } = access;
    const [row] = await this.db
      .select({
        provider: serviceProviders,
        serviceName: services.name,
        serviceIcon: services.icon,
        packageCount: ACTIVE_PACKAGE_COUNT,
      })
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(owned(serviceProviders, tenantId, id), ...this.providersInReach(access, key)))
      .limit(1);

    const found = orNotFound(row, 'Service provider');

    return this.presentProvider(found.provider, {
      serviceName: found.serviceName,
      serviceIcon: found.serviceIcon,
      packageCount: found.packageCount,
    });
  }

  async createProvider(access: RequestAccess, input: CreateProviderBody): Promise<ProviderResponse> {
    const { tenantId } = access;
    await this.findService(access, input.serviceId, PERMISSIONS.SERVICES_CREATE);

    const slug = input.slug ?? uniqueSlug(input.name, await this.takenProviderSlugs(tenantId, input.serviceId));

    try {
      const id = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(serviceProviders)
          .values({
            tenantId,
            ...input,
            slug,
            contact: input.contact ?? null,
            metadata: input.metadata ?? null,
          })
          .returning({ id: serviceProviders.id });

        if (input.isDefault === true)
          await this.clearOtherDefaults(tx, { serviceId: input.serviceId, keepId: row!.id });

        return row!.id;
      });

      const created = await this.getProvider(access, id);
      await audit.created(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A provider named "${input.name}" already supplies this service`);
      throw error;
    }
  }

  async updateProvider(access: RequestAccess, id: string, patch: UpdateProviderBody): Promise<ProviderResponse> {
    const existing = await this.getProvider(access, id, PERMISSIONS.SERVICES_UPDATE);

    try {
      await this.db.transaction(async (tx) => {
        await tx
          .update(serviceProviders)
          .set({ ...patch, updatedAt: new Date() })
          .where(and(eq(serviceProviders.tenantId, access.tenantId), eq(serviceProviders.id, id)));

        if (patch.isDefault === true)
          await this.clearOtherDefaults(tx, { serviceId: existing.serviceId, keepId: id });
      });
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict('Another provider of this service already has that slug');
      throw error;
    }

    const after = await this.getProvider(access, id);
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, before: existing, after });

    return after;
  }

  async removeProvider(access: RequestAccess, id: string): Promise<void> {
    const before = await this.getProvider(access, id, PERMISSIONS.SERVICES_DELETE);

    // A soft delete raises no foreign key error, so what still depends on the row
    // has to be counted here or it is left pointing at a provider nobody can see.
    const [live] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.serviceProviderId, id),
        isNull(subscriptions.deletedAt),
        inArray(subscriptions.status, ['active', 'suspended']),
      ));

    if ((live?.total ?? 0) > 0)
      throw inUse(`${live!.total} subscription(s) are still with this provider`);

    const [livePackages] = await this.db
      .select({ total: count() })
      .from(packages)
      .where(and(eq(packages.serviceProviderId, id), isNull(packages.deletedAt)));

    if ((livePackages?.total ?? 0) > 0)
      throw inUse(`${livePackages!.total} package(s) still belong to this provider; remove them first`);

    await this.db
      .update(serviceProviders)
      .set({ deletedAt: new Date(), status: ENTITY_STATUS.INACTIVE, isDefault: false })
      .where(and(
        eq(serviceProviders.tenantId, access.tenantId),
        eq(serviceProviders.id, id),
        isNull(serviceProviders.deletedAt),
      ));

    await audit.deleted(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, before });
  }

  private async takenServiceSlugs(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: services.slug })
      .from(services)
      .where(eq(services.tenantId, tenantId));

    return rows.map(row => row.slug);
  }

  private async takenProviderSlugs(tenantId: string, serviceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: serviceProviders.slug })
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.serviceId, serviceId)));

    return rows.map(row => row.slug);
  }

  private async clearOtherDefaults(tx: Tx, target: { serviceId: string; keepId: string }): Promise<void> {
    await tx
      .update(serviceProviders)
      .set({ isDefault: false })
      .where(and(
        eq(serviceProviders.serviceId, target.serviceId),
        ne(serviceProviders.id, target.keepId),
      ));
  }

  private async findService(access: RequestAccess, id: string, key: PermissionKey) {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(owned(services, access.tenantId, id), ...this.servicesInReach(access, key)))
      .limit(1);

    return orNotFound(row, 'Service');
  }

  private presentService(
    row: typeof services.$inferSelect,
    providerCount: number,
    providers: ProviderResponse[] = [],
  ): ServiceResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      icon: row.icon,
      description: row.description,
      status: row.status,
      metadata: row.metadata as Record<string, unknown> | null,
      providerCount,
      providers,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private presentProvider(
    row: typeof serviceProviders.$inferSelect,
    meta: { serviceName: string; serviceIcon: string | null; packageCount?: number },
  ): ProviderResponse {
    return {
      id: row.id,
      serviceId: row.serviceId,
      serviceName: meta.serviceName,
      serviceIcon: meta.serviceIcon,
      packageCount: meta.packageCount ?? 0,
      name: row.name,
      slug: row.slug,
      code: row.code,
      description: row.description,
      contact: row.contact as Record<string, unknown> | null,
      metadata: row.metadata as Record<string, unknown> | null,
      status: row.status,
      isDefault: row.isDefault,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
