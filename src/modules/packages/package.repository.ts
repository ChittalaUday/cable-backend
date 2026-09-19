import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import type { LocationScope } from '@/security/location-scope';
import type { PaginationQuery } from '@/utils/pagination';
import { and, asc, count, eq, exists, ilike, inArray, isNull, notExists, sql } from 'drizzle-orm';
import { owned } from '@/db/owned';
import {
  channels,
  packageChannels,
  packages,
  serviceProviders,
  services,
  subscriptions,
} from '@/db/schema';
import { coverageReachesGrant } from '@/modules/services';
import { offsetOf } from '@/utils/pagination';
import { likeTerm } from '@/utils/search';

export interface PackageRow {
  package: typeof packages.$inferSelect;
  serviceProviderName: string;
  serviceId: string;
  serviceName: string;
  serviceIcon: string | null;
  channelCount: number;
  coverageAreas: string[];
}

export interface PackageFilter {
  serviceProviderId?: string;
  serviceId?: string;
  packageType?: typeof packages.packageType.enumValues[number];
  status?: typeof packages.status.enumValues[number];
  q?: string;
}

export interface ChannelFilter {
  serviceProviderId?: string;
  genre?: string;
  resolution?: typeof channels.resolution.enumValues[number];
  q?: string;
  packageId?: string;
  inPackage?: boolean;
}

const LIVE_SUBSCRIPTION_STATUSES = ['active', 'suspended'] as const;

export class PackageRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  // A package is in reach when the staff member's granted nodes touch the
  // coverage rows that carry it. `ALL` short-circuits to no predicate at all so
  // an admin's list does not pay for the coverage probe.
  packagesInReach(tenantId: string, scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId,
      serviceId: sql`${serviceProviders.serviceId}`,
      serviceProviderId: sql`${packages.serviceProviderId}`,
      packageId: sql`${packages.id}`,
    }, scope.nodeIds)];
  }

  channelsInReach(tenantId: string, scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [sql`EXISTS (
      SELECT 1 FROM crm.service_providers sp
      WHERE sp.id = ${channels.serviceProviderId}
        AND ${coverageReachesGrant({
          tenantId,
          serviceId: sql`sp.service_id`,
          serviceProviderId: sql`sp.id`,
          packageId: null,
        }, scope.nodeIds)}
    )`];
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

  private packageFilters(tenantId: string, filter: PackageFilter, reach: SQL[]): SQL[] {
    const filters: SQL[] = [
      eq(packages.tenantId, tenantId),
      isNull(packages.deletedAt),
      ...reach,
    ];

    if (filter.serviceProviderId !== undefined)
      filters.push(eq(packages.serviceProviderId, filter.serviceProviderId));
    if (filter.serviceId !== undefined)
      filters.push(eq(serviceProviders.serviceId, filter.serviceId));
    if (filter.packageType !== undefined)
      filters.push(eq(packages.packageType, filter.packageType));
    if (filter.status !== undefined)
      filters.push(eq(packages.status, filter.status));
    if (filter.q !== undefined)
      filters.push(ilike(packages.name, likeTerm(filter.q)));

    return filters;
  }

  listPackagesPage(tenantId: string, filter: PackageFilter, reach: SQL[], page: PaginationQuery & { limit: number }) {
    const where = and(...this.packageFilters(tenantId, filter, reach));

    return {
      rows: this.db
        .select(this.selection())
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .innerJoin(services, eq(services.id, serviceProviders.serviceId))
        .where(where)
        .orderBy(asc(packages.name))
        .limit(page.limit)
        .offset(offsetOf(page)),
      // The totals query repeats the `services` join: `serviceId` may filter on
      // it, and leaving it out would count rows the page cannot show.
      totals: this.db
        .select({ total: count() })
        .from(packages)
        .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
        .innerJoin(services, eq(services.id, serviceProviders.serviceId))
        .where(where),
    };
  }

  async findPackage(tenantId: string, id: string, reach: SQL[]): Promise<PackageRow | null> {
    const [row] = await this.db
      .select(this.selection())
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .innerJoin(services, eq(services.id, serviceProviders.serviceId))
      .where(and(owned(packages, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  async packageExists(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: packages.id })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

    return row !== undefined;
  }

  async findPackageLineup(packageId: string) {
    return this.db
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
      .where(eq(packageChannels.packageId, packageId))
      .orderBy(asc(channels.channelNumber));
  }

  async createPackage(data: typeof packages.$inferInsert, tx?: Transaction): Promise<string> {
    const client = tx ?? this.db;
    const [row] = await client.insert(packages).values(data).returning({ id: packages.id });
    return row!.id;
  }

  async updatePackage(tenantId: string, id: string, data: Partial<typeof packages.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    return client
      .update(packages)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)));
  }

  async softDeletePackage(tenantId: string, id: string, status: typeof packages.status.enumValues[number]) {
    return this.db
      .update(packages)
      .set({ deletedAt: new Date(), status, updatedAt: new Date() })
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)));
  }

  async countLiveSubscriptions(tenantId: string, packageId: string): Promise<number> {
    const [row] = await this.db
      .select({ total: count() })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.packageId, packageId),
        isNull(subscriptions.deletedAt),
        inArray(subscriptions.status, [...LIVE_SUBSCRIPTION_STATUSES]),
      ));

    return row?.total ?? 0;
  }

  async takenSlugs(tenantId: string, serviceProviderId: string): Promise<string[]> {
    const rows = await this.db
      .select({ slug: packages.slug })
      .from(packages)
      .where(and(eq(packages.tenantId, tenantId), eq(packages.serviceProviderId, serviceProviderId)));

    return rows.map(row => row.slug);
  }

  async providerExists(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: serviceProviders.id })
      .from(serviceProviders)
      .where(owned(serviceProviders, tenantId, id))
      .limit(1);

    return row !== undefined;
  }

  async findProviderChannels(tenantId: string, serviceProviderId: string, channelIds: string[]): Promise<string[]> {
    const rows = await this.db
      .select({ id: channels.id })
      .from(channels)
      .where(and(
        eq(channels.tenantId, tenantId),
        eq(channels.serviceProviderId, serviceProviderId),
        inArray(channels.id, channelIds),
      ));

    return rows.map(row => row.id);
  }

  // A package's line-up is a set, not a history: the rows carry no identity of
  // their own and no deleted_at column, so replacing it is delete-then-insert
  // inside one transaction. The audit row the service writes is the record.
  async replacePackageChannels(packageId: string, lineup: { channelId: string; isMandatory?: boolean }[]) {
    return this.db.transaction(async (tx) => {
      await tx.delete(packageChannels).where(eq(packageChannels.packageId, packageId));

      if (lineup.length > 0) {
        await tx.insert(packageChannels).values(lineup.map(item => ({
          packageId,
          channelId: item.channelId,
          isMandatory: item.isMandatory ?? true,
        })));
      }
    });
  }

  listChannelsPage(tenantId: string, filter: ChannelFilter, reach: SQL[], page: PaginationQuery & { limit: number }) {
    const filters: SQL[] = [eq(channels.tenantId, tenantId), ...reach];

    if (filter.serviceProviderId !== undefined)
      filters.push(eq(channels.serviceProviderId, filter.serviceProviderId));
    if (filter.genre !== undefined)
      filters.push(eq(channels.genre, filter.genre as typeof channels.genre.enumValues[number]));
    if (filter.resolution !== undefined)
      filters.push(eq(channels.resolution, filter.resolution));
    if (filter.q !== undefined)
      filters.push(ilike(channels.name, likeTerm(filter.q)));

    if (filter.packageId !== undefined) {
      const carried = this.db
        .select({ one: sql`1` })
        .from(packageChannels)
        .where(and(
          eq(packageChannels.packageId, filter.packageId),
          eq(packageChannels.channelId, channels.id),
        ));

      filters.push(filter.inPackage === false ? notExists(carried) : exists(carried));
    }

    const where = and(...filters);

    return {
      rows: this.db
        .select()
        .from(channels)
        .where(where)
        .orderBy(asc(channels.channelNumber))
        .limit(page.limit)
        .offset(offsetOf(page)),
      totals: this.db.select({ total: count() }).from(channels).where(where),
    };
  }
}
