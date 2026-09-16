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
import { and, asc, count, eq, exists, ilike, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { channels, packageChannels, packages, serviceProviders, services, subscriptions } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { AUDIT_ENTITIES } from '@/shared/constants/audit';
import { ENTITY_STATUS } from '@/shared/constants/crm';
import { owned } from '@/shared/db/owned';
import { ERROR_CODES, isUniqueViolation } from '@/shared/errors';
import { badRequest, conflict, inUse, orNotFound } from '@/shared/errors/domain-error';
import { offsetOf, pageOf } from '@/shared/pagination';
import { likeTerm } from '@/shared/utils/search';
import { uniqueSlug } from '@/shared/utils/slug';

type Db = NodePgDatabase<typeof schema>;

interface PackageRow {
  package: typeof packages.$inferSelect;
  serviceProviderName: string;
  serviceId: string;
  serviceName: string;
  serviceIcon: string | null;
  channelCount: number;
  coverageAreas: string[];
}
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

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
      filters.push(ilike(packages.name, likeTerm(query.q)));

    const where = and(...filters);

    return pageOf(query as PaginationQuery, {
      rows: this.db
        .select(this.selection())
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .innerJoin(services, eq(services.id, serviceProviders.serviceId))
        .where(where)
        .orderBy(asc(packages.name))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      totals: this.db
        .select({ total: count() })
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .where(where),
      present: rows => rows.map(row => this.present(row)),
    });
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

    const slug = input.slug ?? uniqueSlug(input.name, await this.takenSlugs(tenantId, input.serviceProviderId));

    try {
      const [row] = await this.db.insert(packages).values({
        tenantId,
        ...input,
        slug,
        metadata: input.metadata ?? null,
      }).returning({ id: packages.id });

      const created = this.present(await this.find(tenantId, row!.id));
      await audit.created(this.db, context, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`This provider already has a package named "${input.name}"`);
      throw error;
    }
  }

  async update(access: RequestAccess, id: string, patch: UpdatePackageBody): Promise<PackageResponse> {
    const before = this.present(await this.find(access.tenantId, id));

    await this.db
      .update(packages)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, access.tenantId), eq(packages.id, id)));

    const after = this.present(await this.find(access.tenantId, id));
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: id, before, after });

    return after;
  }

  async remove({ tenantId, audit: context }: RequestAccess, id: string): Promise<void> {
    const [exists] = await this.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

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
      .set({ deletedAt: new Date(), status: ENTITY_STATUS.INACTIVE })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)));

    await audit.deleted(this.db, context, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: id, before });
  }

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
      entityType: AUDIT_ENTITIES.PACKAGE_CHANNELS,
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
    if (query.resolution !== undefined)
      filters.push(eq(channels.resolution, query.resolution));
    if (query.q !== undefined)
      filters.push(ilike(channels.name, likeTerm(query.q)));

    if (query.packageId !== undefined) {
      const carried = this.db
        .select({ one: sql`1` })
        .from(packageChannels)
        .where(and(
          eq(packageChannels.packageId, query.packageId),
          eq(packageChannels.channelId, channels.id),
        ));

      filters.push(query.inPackage === false ? notExists(carried) : exists(carried));
    }

    const where = and(...filters);

    return pageOf(query as PaginationQuery, {
      rows: this.db
        .select()
        .from(channels)
        .where(where)
        .orderBy(asc(channels.channelNumber))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      totals: this.db.select({ total: count() }).from(channels).where(where),
      present: rows => rows.map(row => ({
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
    });
  }

  private selection() {
    return {
      package: packages,
      serviceProviderName: serviceProviders.name,
      serviceId: services.id,
      serviceName: services.name,
      serviceIcon: services.icon,
      channelCount: sql<number>`(
        SELECT count(*)::int FROM crm.package_channels pc WHERE pc.package_id = crm.packages.id
      )`,
      coverageAreas: sql<string[]>`(
        SELECT coalesce(array_agg(lp.path ORDER BY lp.path), '{}')
        FROM crm.service_coverage c
        JOIN geo.location_paths lp ON lp.id = c.location_id
        WHERE c.package_id = crm.packages.id AND c.is_available
      )`,
    };
  }

  private async find(tenantId: string, id: string) {
    const [row] = await this.db
      .select(this.selection())
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(owned(packages, tenantId, id))
      .limit(1);

    return orNotFound(row, 'Package');
  }

  private async takenSlugs(tenantId: string, serviceProviderId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: packages.slug })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.serviceProviderId, serviceProviderId)));

    return rows.map(row => row.slug);
  }

  private async findProvider(tenantId: string, id: string) {
    const [row] = await this.db
      .select({ id: serviceProviders.id })
      .from(serviceProviders)
      .where(owned(serviceProviders, tenantId, id))
      .limit(1);

    return orNotFound(row, 'Service provider');
  }

  private present(row: PackageRow): PackageResponse {
    const pkg = row.package;

    return {
      id: pkg.id,
      serviceProviderId: pkg.serviceProviderId,
      serviceProviderName: row.serviceProviderName,
      serviceId: row.serviceId,
      serviceName: row.serviceName,
      serviceIcon: row.serviceIcon,
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
      coverageAreas: row.coverageAreas,
      createdAt: pkg.createdAt.toISOString(),
      updatedAt: pkg.updatedAt.toISOString(),
    };
  }
}
