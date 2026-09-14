import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  CreateProviderBody,
  CreateServiceBody,
  ListProvidersQuery,
  ListServicesQuery,
  ProviderResponse,
  ServiceResponse,
  UpdateProviderBody,
  UpdateServiceBody,
} from './services.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import { and, asc, count, eq, ilike, isNull, ne, or, sql } from 'drizzle-orm';
import { serviceProviders, services } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { AUDIT_ENTITIES } from '@/shared/constants/audit';
import { isForeignKeyViolation, isUniqueViolation } from '@/shared/errors';
import { conflict, inUse, notFound } from '@/shared/errors/domain-error';
import { uniqueSlug } from '@/shared/utils/slug';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Counts kept as fragments, with the outer table spelled out in full.
 *
 * **Do not replace the qualified names with a drizzle column.** A column in a
 * SELECT list is emitted unqualified — `${'${serviceProviders.id}'}` becomes a bare
 * `"id"` — and inside the subquery that binds to the INNER table's own `id`,
 * so the correlation silently becomes `pkg.service_provider_id = pkg.id` and
 * every count comes back 0. It only looks right when the outer query happens
 * to join, which is why the joined call sites worked and the two single-table
 * ones reported nothing.
 */
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

/**
 * The service catalogue and its suppliers (docs/services-providers-packages.md).
 *
 * `Cable TV` is a service; `ACT Digital` and `Hathway` are providers of it.
 * Nothing here knows about coverage or packages — those hang off a provider and
 * are owned by their own modules.
 *
 * Catalogue rows are tenant-wide: there is no per-record scope beyond
 * `tenant_id`, so the §5 check is stage 1 only.
 */
export class ServicesService {
  constructor(private readonly db: Db) {}

  // ── Services ────────────────────────────────────────────────────────────────

  async list({ tenantId }: RequestAccess, query: ListServicesQuery): Promise<ServiceResponse[]> {
    const filters = [eq(services.tenantId, tenantId), isNull(services.deletedAt)];

    if (query.status !== undefined)
      filters.push(eq(services.status, query.status));
    if (query.q !== undefined)
      filters.push(ilike(services.name, `%${query.q}%`));

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

  async get(access: RequestAccess, id: string): Promise<ServiceResponse> {
    const row = await this.findService(access.tenantId, id);
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
      ))
      .orderBy(asc(serviceProviders.name));

    const providers = providerRows.map(p => this.presentProvider(p.provider, {
      serviceName: row.name,
      serviceIcon: row.icon,
      packageCount: p.packageCount,
    }));
    const activeCount = providers.filter(p => p.status === 'active').length;

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
    const before = await this.get(access, id);

    await this.db
      .update(services)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(services.tenantId, access.tenantId), eq(services.id, id)));

    const after = await this.get(access, id);
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before, after });

    return after;
  }

  /**
   * Soft delete: `services` is one of the tables §8 keeps history for, and a
   * subscription from three years ago still names what it was for.
   */
  async remove({ tenantId, audit: context }: RequestAccess, id: string): Promise<void> {
    const [exists] = await this.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .limit(1);

    // Deleting what is not there stayed a 204 before this method audited
    // anything, and there is no change to record either.
    if (exists === undefined)
      return;

    const before = await this.findService(tenantId, id);

    const [providers] = await this.db
      .select({ total: count() })
      .from(serviceProviders)
      .where(and(eq(serviceProviders.serviceId, id), isNull(serviceProviders.deletedAt)));

    if ((providers?.total ?? 0) > 0)
      throw inUse('This service still has providers; remove them first');

    await this.db
      .update(services)
      .set({ deletedAt: new Date(), status: 'inactive' })
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)));

    await audit.deleted(this.db, context, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before });
  }

  // ── Providers ───────────────────────────────────────────────────────────────

  async listProviders({ tenantId }: RequestAccess, query: ListProvidersQuery): Promise<ProviderResponse[]> {
    const filters = [eq(serviceProviders.tenantId, tenantId), isNull(serviceProviders.deletedAt)];

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

  async getProvider({ tenantId }: RequestAccess, id: string): Promise<ProviderResponse> {
    const [row] = await this.db
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
        eq(serviceProviders.id, id),
        isNull(serviceProviders.deletedAt),
      ))
      .limit(1);

    if (row === undefined)
      throw notFound('Service provider');

    return this.presentProvider(row.provider, {
      serviceName: row.serviceName,
      serviceIcon: row.serviceIcon,
      packageCount: row.packageCount,
    });
  }

  async createProvider(access: RequestAccess, input: CreateProviderBody): Promise<ProviderResponse> {
    const { tenantId } = access;
    await this.findService(tenantId, input.serviceId);

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

  /**
   * A provider's `service_id` is not patchable.
   *
   * Moving a provider between services would take its packages, channels and
   * every subscription on them along with it — which is a data migration, not
   * an edit.
   */
  async updateProvider(access: RequestAccess, id: string, patch: UpdateProviderBody): Promise<ProviderResponse> {
    const existing = await this.getProvider(access, id);

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
    const before = await this.getProvider(access, id);

    try {
      await this.db
        .update(serviceProviders)
        .set({ deletedAt: new Date(), status: 'inactive', isDefault: false })
        .where(and(eq(serviceProviders.tenantId, access.tenantId), eq(serviceProviders.id, id)));
    }
    catch (error) {
      if (isForeignKeyViolation(error))
        throw inUse('This provider still has live subscriptions');
      throw error;
    }

    await audit.deleted(this.db, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, before });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * Slugs already spent, so a derived one can step around them.
   *
   * Soft-deleted rows count: the unique index does not exclude them, so
   * reusing a retired service's slug is a 409, not a fresh row.
   */
  private async takenServiceSlugs(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: services.slug })
      .from(services)
      .where(eq(services.tenantId, tenantId));

    return rows.map(row => row.slug);
  }

  /** A provider's slug is unique per service, not per tenant. */
  private async takenProviderSlugs(tenantId: string, serviceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: serviceProviders.slug })
      .from(serviceProviders)
      .where(and(eq(serviceProviders.tenantId, tenantId), eq(serviceProviders.serviceId, serviceId)));

    return rows.map(row => row.slug);
  }

  /** Exactly one default per service, enforced here rather than by a partial index. */
  private async clearOtherDefaults(tx: Tx, target: { serviceId: string; keepId: string }): Promise<void> {
    await tx
      .update(serviceProviders)
      .set({ isDefault: false })
      .where(and(
        eq(serviceProviders.serviceId, target.serviceId),
        ne(serviceProviders.id, target.keepId),
      ));
  }

  private async findService(tenantId: string, id: string) {
    const [row] = await this.db
      .select()
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .limit(1);

    if (row === undefined)
      throw notFound('Service');

    return row;
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
