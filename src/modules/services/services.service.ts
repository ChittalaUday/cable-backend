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
import { and, asc, count, eq, isNull, ne, sql } from 'drizzle-orm';
import { serviceProviders, services } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { isForeignKeyViolation, isUniqueViolation } from '@/shared/errors';
import { conflict, inUse, notFound } from '@/shared/errors/domain-error';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
    if (query.serviceType !== undefined)
      filters.push(eq(services.serviceType, query.serviceType));

    const rows = await this.db
      .select({
        service: services,
        // Counted in SQL: a tenant with fifty services should not become fifty
        // round trips just to render "3 providers".
        providerCount: sql<number>`(
          SELECT count(*)::int FROM crm.service_providers p
          WHERE p.service_id = ${services.id} AND p.deleted_at IS NULL AND p.status = 'active'
        )`,
      })
      .from(services)
      .where(and(...filters))
      .orderBy(asc(services.name));

    return rows.map(row => this.presentService(row.service, row.providerCount));
  }

  async get(access: RequestAccess, id: string): Promise<ServiceResponse> {
    const row = await this.findService(access.tenantId, id);
    const [counted] = await this.db
      .select({ total: count() })
      .from(serviceProviders)
      .where(and(
        eq(serviceProviders.serviceId, id),
        eq(serviceProviders.status, 'active'),
        isNull(serviceProviders.deletedAt),
      ));

    return this.presentService(row, counted?.total ?? 0);
  }

  async create({ tenantId, audit: context }: RequestAccess, input: CreateServiceBody): Promise<ServiceResponse> {
    try {
      const [row] = await this.db
        .insert(services)
        .values({ tenantId, ...input, metadata: input.metadata ?? null })
        .returning();

      const created = this.presentService(row!, 0);
      await audit.created(this.db, context, { entityType: 'service', entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A service with slug "${input.slug}" already exists`);
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
    await audit.updated(this.db, access.audit, { entityType: 'service', entityId: id, before, after });

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

    await audit.deleted(this.db, context, { entityType: 'service', entityId: id, before });
  }

  // ── Providers ───────────────────────────────────────────────────────────────

  async listProviders({ tenantId }: RequestAccess, query: ListProvidersQuery): Promise<ProviderResponse[]> {
    const filters = [eq(serviceProviders.tenantId, tenantId), isNull(serviceProviders.deletedAt)];

    if (query.serviceId !== undefined)
      filters.push(eq(serviceProviders.serviceId, query.serviceId));
    if (query.status !== undefined)
      filters.push(eq(serviceProviders.status, query.status));

    const rows = await this.db
      .select({ provider: serviceProviders, serviceName: services.name })
      .from(serviceProviders)
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(...filters))
      .orderBy(asc(services.name), asc(serviceProviders.name));

    return rows.map(row => this.presentProvider(row.provider, row.serviceName));
  }

  async getProvider({ tenantId }: RequestAccess, id: string): Promise<ProviderResponse> {
    const [row] = await this.db
      .select({ provider: serviceProviders, serviceName: services.name })
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

    return this.presentProvider(row.provider, row.serviceName);
  }

  async createProvider(access: RequestAccess, input: CreateProviderBody): Promise<ProviderResponse> {
    const { tenantId } = access;
    await this.findService(tenantId, input.serviceId);

    try {
      const id = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(serviceProviders)
          .values({
            tenantId,
            ...input,
            contact: input.contact ?? null,
            metadata: input.metadata ?? null,
          })
          .returning({ id: serviceProviders.id });

        if (input.isDefault === true)
          await this.clearOtherDefaults(tx, { serviceId: input.serviceId, keepId: row!.id });

        return row!.id;
      });

      const created = await this.getProvider(access, id);
      await audit.created(this.db, access.audit, { entityType: 'service_provider', entityId: id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A provider with slug "${input.slug}" already exists for this service`);
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
    await audit.updated(this.db, access.audit, { entityType: 'service_provider', entityId: id, before: existing, after });

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

    await audit.deleted(this.db, access.audit, { entityType: 'service_provider', entityId: id, before });
  }

  // ── Internals ───────────────────────────────────────────────────────────────

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

  private presentService(row: typeof services.$inferSelect, providerCount: number): ServiceResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      serviceType: row.serviceType,
      description: row.description,
      status: row.status,
      metadata: row.metadata as Record<string, unknown> | null,
      providerCount,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private presentProvider(row: typeof serviceProviders.$inferSelect, serviceName: string): ProviderResponse {
    return {
      id: row.id,
      serviceId: row.serviceId,
      serviceName,
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
