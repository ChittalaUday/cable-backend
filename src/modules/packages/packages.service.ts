import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  ChannelResponse,
  CreatePackageBody,
  ListChannelsQuery,
  ListPackagesQuery,
  PackageDetailResponse,
  PackageResponse,
  SetPackageChannelsBody,
  UpdatePackageBody,
} from './packages.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { Page, PaginationQuery } from '@/shared/pagination';
import { and, asc, count, eq, ilike, inArray, isNull, sql } from 'drizzle-orm';
import { channels, packageChannels, packages, serviceProviders, services, subscriptions } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { ERROR_CODES, isUniqueViolation } from '@/shared/errors';
import { badRequest, conflict, inUse, notFound } from '@/shared/errors/domain-error';
import { offsetOf } from '@/shared/pagination';

type Db = NodePgDatabase<typeof schema>;

/** A package joined to the supplier and service it belongs to. */
interface PackageRow {
  package: typeof packages.$inferSelect;
  serviceProviderName: string;
  serviceId: string;
  serviceName: string;
  channelCount: number;
}
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/**
 * Packages and the channel lineups they carry
 * (docs/services-providers-packages.md).
 *
 * Everything here is scoped to a **provider**. "All packages for a service" is
 * a filter that joins through the provider — deliberately, so there is one
 * answer to which supplier a package belongs to.
 */
export class PackagesService {
  constructor(private readonly db: Db) {}

  async list({ tenantId }: RequestAccess, query: ListPackagesQuery): Promise<Page<PackageResponse>> {
    const filters = [eq(packages.tenantId, tenantId), isNull(packages.deletedAt)];

    if (query.serviceProviderId !== undefined)
      filters.push(eq(packages.serviceProviderId, query.serviceProviderId));
    if (query.serviceId !== undefined)
      filters.push(eq(serviceProviders.serviceId, query.serviceId));
    if (query.packageType !== undefined)
      filters.push(eq(packages.packageType, query.packageType));
    if (query.status !== undefined)
      filters.push(eq(packages.status, query.status));
    if (query.q !== undefined)
      filters.push(ilike(packages.name, `%${query.q}%`));

    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select(this.selection())
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .innerJoin(services, eq(services.id, serviceProviders.serviceId))
        .where(where)
        .orderBy(asc(packages.name))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      this.db
        .select({ total: count() })
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .where(where),
    ]);

    return {
      items: rows.map(row => this.present(row)),
      total: totals?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(access: RequestAccess, id: string): Promise<PackageDetailResponse> {
    const row = await this.find(access.tenantId, id);

    const lineup = await this.db
      .select({
        id: channels.id,
        channelNumber: channels.channelNumber,
        name: channels.name,
        slug: channels.slug,
        genre: channels.genre,
        resolution: channels.resolution,
        isFta: channels.isFta,
        isMandatory: packageChannels.isMandatory,
      })
      .from(packageChannels)
      .innerJoin(channels, eq(channels.id, packageChannels.channelId))
      .where(eq(packageChannels.packageId, id))
      .orderBy(asc(channels.channelNumber));

    return { ...this.present(row), channels: lineup };
  }

  async create({ tenantId, audit: context }: RequestAccess, input: CreatePackageBody): Promise<PackageResponse> {
    await this.findProvider(tenantId, input.serviceProviderId);

    try {
      const [row] = await this.db.insert(packages).values({
        tenantId,
        ...input,
        metadata: input.metadata ?? null,
      }).returning({ id: packages.id });

      const created = this.present(await this.find(tenantId, row!.id));
      await audit.created(this.db, context, { entityType: 'package', entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`This provider already has a package with slug "${input.slug}"`);
      throw error;
    }
  }

  /**
   * `serviceProviderId` is not patchable.
   *
   * Re-pointing a package at another supplier silently rewrites what every
   * existing subscriber is on, and what the MSO is owed for them. Deactivate it
   * and create the package the other provider actually sells.
   */
  async update(access: RequestAccess, id: string, patch: UpdatePackageBody): Promise<PackageResponse> {
    const before = this.present(await this.find(access.tenantId, id));

    await this.db
      .update(packages)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, access.tenantId), eq(packages.id, id)));

    const after = this.present(await this.find(access.tenantId, id));
    await audit.updated(this.db, access.audit, { entityType: 'package', entityId: id, before, after });

    return after;
  }

  /** Soft delete, and refused outright while anyone is still subscribed. */
  async remove({ tenantId, audit: context }: RequestAccess, id: string): Promise<void> {
    const [exists] = await this.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

    // Deleting what is not there stayed a 204 before this method audited
    // anything, and there is no change to record either.
    if (exists === undefined)
      return;

    const before = this.present(await this.find(tenantId, id));

    const [live] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.packageId, id),
        isNull(subscriptions.deletedAt),
        inArray(subscriptions.status, ['active', 'suspended']),
      ));

    if ((live?.total ?? 0) > 0)
      throw inUse(`${live!.total} subscription(s) are still on this package`);

    await this.db
      .update(packages)
      .set({ deletedAt: new Date(), status: 'inactive' })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)));

    await audit.deleted(this.db, context, { entityType: 'package', entityId: id, before });
  }

  /**
   * Replaces a package's lineup in one call.
   *
   * A bouquet is edited as a list in the UI; a diff of add/remove calls is many
   * round trips and a half-applied state if one of them fails.
   */
  async setChannels(access: RequestAccess, id: string, input: SetPackageChannelsBody): Promise<PackageDetailResponse> {
    const before = await this.get(access, id);
    const pkg = await this.find(access.tenantId, id);
    const ids = input.channels.map(c => c.channelId);

    if (ids.length > 0) {
      if (new Set(ids).size !== ids.length)
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Duplicate channels cannot be added to the same package');

      const owned = await this.db
        .select({ id: channels.id })
        .from(channels)
        .where(and(
          eq(channels.tenantId, access.tenantId),
          eq(channels.serviceProviderId, pkg.package.serviceProviderId),
          inArray(channels.id, ids),
        ));

      // A lineup may only hold channels the same supplier carries — otherwise a
      // bouquet quietly promises a channel that provider's feed does not have.
      if (owned.length !== ids.length)
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Every channel must belong to this package’s provider');
    }

    await this.db.transaction(async (tx: Tx) => {
      await tx.delete(packageChannels).where(eq(packageChannels.packageId, id));

      if (input.channels.length > 0) {
        await tx.insert(packageChannels).values(input.channels.map(c => ({
          packageId: id,
          channelId: c.channelId,
          isMandatory: c.isMandatory ?? true,
        })));
      }
    });

    const after = await this.get(access, id);
    await audit.updated(this.db, access.audit, {
      entityType: 'package_channels',
      entityId: id,
      before: { channels: before.channels },
      after: { channels: after.channels },
    });

    return after;
  }

  async listChannels({ tenantId }: RequestAccess, query: ListChannelsQuery): Promise<Page<ChannelResponse>> {
    const filters = [eq(channels.tenantId, tenantId)];

    if (query.serviceProviderId !== undefined)
      filters.push(eq(channels.serviceProviderId, query.serviceProviderId));
    if (query.genre !== undefined)
      filters.push(eq(channels.genre, query.genre as typeof channels.genre.enumValues[number]));
    if (query.q !== undefined)
      filters.push(ilike(channels.name, `%${query.q}%`));

    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(channels)
        .where(where)
        .orderBy(asc(channels.channelNumber))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      this.db.select({ total: count() }).from(channels).where(where),
    ]);

    return {
      items: rows.map(row => ({
        id: row.id,
        serviceProviderId: row.serviceProviderId,
        channelNumber: row.channelNumber,
        name: row.name,
        slug: row.slug,
        genre: row.genre,
        languages: row.languages,
        resolution: row.resolution,
        isFta: row.isFta,
        broadcaster: row.broadcaster,
        price: row.price,
        logoUrl: row.logoUrl,
        status: row.status,
      })),
      total: totals?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private selection() {
    return {
      package: packages,
      serviceProviderName: serviceProviders.name,
      serviceId: services.id,
      serviceName: services.name,
      channelCount: sql<number>`(
        SELECT count(*)::int FROM crm.package_channels pc WHERE pc.package_id = ${packages.id}
      )`,
    };
  }

  private async find(tenantId: string, id: string) {
    const [row] = await this.db
      .select(this.selection())
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

    if (row === undefined)
      throw notFound('Package');

    return row;
  }

  private async findProvider(tenantId: string, id: string) {
    const [row] = await this.db
      .select({ id: serviceProviders.id })
      .from(serviceProviders)
      .where(and(
        eq(serviceProviders.tenantId, tenantId),
        eq(serviceProviders.id, id),
        isNull(serviceProviders.deletedAt),
      ))
      .limit(1);

    if (row === undefined)
      throw notFound('Service provider');

    return row;
  }

  private present(row: PackageRow): PackageResponse {
    const pkg = row.package;

    return {
      id: pkg.id,
      serviceProviderId: pkg.serviceProviderId,
      serviceProviderName: row.serviceProviderName,
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      name: pkg.name,
      slug: pkg.slug,
      packageType: pkg.packageType,
      price: pkg.price,
      discount: pkg.discount,
      msoShare: pkg.msoShare,
      taxRate: pkg.taxRate,
      billingCycle: pkg.billingCycle,
      description: pkg.description,
      metadata: pkg.metadata as Record<string, unknown> | null,
      status: pkg.status,
      channelCount: row.channelCount,
      createdAt: pkg.createdAt.toISOString(),
      updatedAt: pkg.updatedAt.toISOString(),
    };
  }
}
