import type { SQL } from 'drizzle-orm';
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
} from './package.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page, PaginationQuery } from '@/utils/pagination';
import { and, asc, count, eq, exists, ilike, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { ENTITY_STATUS } from '@/constants/crm';
import { owned } from '@/db/owned';
import { channels, packageChannels, packages, serviceProviders, services, subscriptions } from '@/db/schema';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, inUse, orNotFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { coverageReachesGrant } from '@/modules/services/services/coverage.service';
import { PERMISSIONS } from '@/security/permissions';
import { offsetOf, pageOf } from '@/utils/pagination';
import { likeTerm } from '@/utils/search';
import { uniqueSlug } from '@/utils/slug';

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

  private packagesInReach(access: RequestAccess, key: PermissionKey): SQL[] {
    const reach = locationScopeFor(access, key);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId: access.tenantId,
      serviceId: sql`${serviceProviders.serviceId}`,
      serviceProviderId: sql`${packages.serviceProviderId}`,
      packageId: sql`${packages.id}`,
    }, reach.nodeIds)];
  }

  private channelsInReach(access: RequestAccess, key: PermissionKey): SQL[] {
    const reach = locationScopeFor(access, key);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [sql`EXISTS (
      SELECT 1 FROM crm.service_providers sp
      WHERE sp.id = ${channels.serviceProviderId}
        AND ${coverageReachesGrant({
          tenantId: access.tenantId,
          serviceId: sql`sp.service_id`,
          serviceProviderId: sql`sp.id`,
          packageId: null,
        }, reach.nodeIds)}
    )`];
  }

  async list(access: RequestAccess, query: ListPackagesQuery): Promise<Page<PackageResponse>> {
    const filters = [
      eq(packages.tenantId, access.tenantId),
      isNull(packages.deletedAt),
      ...this.packagesInReach(access, PERMISSIONS.PACKAGES_VIEW),
    ];

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

  async get(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.PACKAGES_VIEW): Promise<PackageDetailResponse> {
    const row = await this.find(access, id, key);

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

  async create(access: RequestAccess, input: CreatePackageBody): Promise<PackageResponse> {
    const { tenantId, audit: context } = access;
    await this.findProvider(tenantId, input.serviceProviderId);

    const slug = input.slug ?? uniqueSlug(input.name, await this.takenSlugs(tenantId, input.serviceProviderId));

    try {
      const [row] = await this.db.insert(packages).values({
        tenantId,
        ...input,
        slug,
        metadata: input.metadata ?? null,
      }).returning({ id: packages.id });

      const created = this.present(await this.find(access, row!.id, PERMISSIONS.PACKAGES_CREATE));
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
    const before = this.present(await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE));

    await this.db
      .update(packages)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, access.tenantId), eq(packages.id, id)));

    const after = this.present(await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE));
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const { tenantId, audit: context } = access;
    const [exists] = await this.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

    if (exists === undefined)
      return;

    const before = this.present(await this.find(access, id, PERMISSIONS.PACKAGES_DELETE));

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
    const before = await this.get(access, id, PERMISSIONS.PACKAGES_UPDATE);
    const pkg = await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE);
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

    const after = await this.get(access, id, PERMISSIONS.PACKAGES_UPDATE);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.PACKAGE_CHANNELS,
      entityId: id,
      before: { channels: before.channels },
      after: { channels: after.channels },
    });

    return after;
  }

  async listChannels(access: RequestAccess, query: ListChannelsQuery): Promise<Page<ChannelResponse>> {
    const filters = [
      eq(channels.tenantId, access.tenantId),
      ...this.channelsInReach(access, PERMISSIONS.PACKAGES_VIEW),
    ];

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

  private async find(access: RequestAccess, id: string, key: PermissionKey) {
    const [row] = await this.db
      .select(this.selection())
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(owned(packages, access.tenantId, id), ...this.packagesInReach(access, key)))
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
