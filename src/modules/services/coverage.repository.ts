import type { SQL } from 'drizzle-orm';
import type { CoverageEntry, CoverageResponse } from './service.schema';
import type { Database } from '@/db/client';
import type { LocationScope } from '@/security/location-scope';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { owned } from '@/db/owned';
import { locationPaths, packages, serviceCoverage, serviceProviders, services } from '@/db/schema';
import { overlapsAnyGrant, underAnyGrant } from '@/security/location-scope';
import { coverageReachesGrant } from './coverage.scope';

export interface AvailabilityRow extends Record<string, unknown> {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  serviceIcon: string | null;
  providerId: string;
  providerName: string;
  providerSlug: string;
  isDefault: boolean;
  packageId: string | null;
  packageName: string | null;
  packageSlug: string | null;
  packageType: string | null;
  price: string | null;
  billingCycle: string | null;
  packageAvailable: boolean;
}

export interface CoverageTargetRef {
  serviceId: string;
  serviceProviderId: string | null;
  packageId?: string | null;
}

export class CoverageRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  rowsInReach(scope: LocationScope): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [overlapsAnyGrant(sql`${serviceCoverage.locationId}`, scope.nodeIds)];
  }

  catalogueInReach(tenantId: string, scope: LocationScope, target: {
    serviceId: SQL;
    serviceProviderId?: SQL;
    packageId?: SQL;
  }): SQL[] {
    if (scope.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    return [coverageReachesGrant({
      tenantId,
      serviceId: target.serviceId,
      serviceProviderId: target.serviceProviderId ?? null,
      packageId: target.packageId ?? null,
    }, scope.nodeIds)];
  }

  providerScope(): { serviceId: SQL; serviceProviderId: SQL } {
    return { serviceId: sql`${serviceProviders.serviceId}`, serviceProviderId: sql`${serviceProviders.id}` };
  }

  packageScope(): { serviceId: SQL; serviceProviderId: SQL; packageId: SQL } {
    return {
      serviceId: sql`${serviceProviders.serviceId}`,
      serviceProviderId: sql`${packages.serviceProviderId}`,
      packageId: sql`${packages.id}`,
    };
  }

  serviceScope(): { serviceId: SQL } {
    return { serviceId: sql`${services.id}` };
  }

  async listRows(tenantId: string, where: SQL, reach: SQL[]): Promise<CoverageResponse[]> {
    return this.db
      .select({
        id: serviceCoverage.id,
        serviceId: serviceCoverage.serviceId,
        serviceProviderId: serviceCoverage.serviceProviderId,
        packageId: serviceCoverage.packageId,
        locationId: serviceCoverage.locationId,
        locationPath: locationPaths.path,
        isAvailable: serviceCoverage.isAvailable,
        note: serviceCoverage.note,
      })
      .from(serviceCoverage)
      .innerJoin(locationPaths, eq(locationPaths.id, serviceCoverage.locationId))
      .where(and(eq(serviceCoverage.tenantId, tenantId), where, ...reach))
      .orderBy(asc(locationPaths.path));
  }

  forProvider(providerId: string): SQL {
    return and(eq(serviceCoverage.serviceProviderId, providerId), isNull(serviceCoverage.packageId))!;
  }

  forPackage(packageId: string): SQL {
    return eq(serviceCoverage.packageId, packageId);
  }

  forService(serviceId: string): SQL {
    return and(
      eq(serviceCoverage.serviceId, serviceId),
      isNull(serviceCoverage.serviceProviderId),
      isNull(serviceCoverage.packageId),
    )!;
  }

  async findProvider(tenantId: string, id: string, reach: SQL[]) {
    const [row] = await this.db
      .select({ id: serviceProviders.id, serviceId: serviceProviders.serviceId })
      .from(serviceProviders)
      .where(and(owned(serviceProviders, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  async findPackage(tenantId: string, id: string, reach: SQL[]) {
    const [row] = await this.db
      .select({
        id: packages.id,
        serviceProviderId: packages.serviceProviderId,
        serviceId: serviceProviders.serviceId,
      })
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .where(and(owned(packages, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  async findService(tenantId: string, id: string, reach: SQL[]) {
    const [row] = await this.db
      .select({ id: services.id })
      .from(services)
      .where(and(owned(services, tenantId, id), ...reach))
      .limit(1);

    return row ?? null;
  }

  /** Paths of the nodes the parent service/provider does not already cover. */
  async pathsOutsideParent(tenantId: string, target: CoverageTargetRef, locationIds: string[]): Promise<string[]> {
    const result = await this.db.execute<{ path: string }>(sql`
      SELECT lp.path
      FROM unnest(${sql.param(locationIds)}::uuid[]) AS n(id)
      JOIN geo.location_paths lp ON lp.id = n.id
      WHERE NOT crm.coverage_allows(
        ${tenantId}, ${target.serviceId}, ${target.serviceProviderId}, NULL, n.id
      )
      ORDER BY lp.path
    `);

    return result.rows.map(row => row.path);
  }

  async nodeUnderGrant(locationId: string, nodeIds: readonly string[]): Promise<boolean> {
    const result = await this.db.execute<{ reaches: boolean }>(
      sql`SELECT ${underAnyGrant(locationId, nodeIds)} AS reaches`,
    );

    return result.rows[0]?.reaches === true;
  }

  // Coverage is declared as a complete set per (service, provider, package):
  // the rows carry no identity a client can address and no deleted_at column,
  // so a replace is delete-then-insert in one transaction. The audit row the
  // service writes carries the before/after.
  async replaceCoverage(
    tenantId: string,
    userId: string,
    target: CoverageTargetRef,
    entries: CoverageEntry[],
  ): Promise<void> {
    const packageId = target.packageId ?? null;

    await this.db.transaction(async (tx) => {
      await tx.delete(serviceCoverage).where(and(
        eq(serviceCoverage.tenantId, tenantId),
        eq(serviceCoverage.serviceId, target.serviceId),
        target.serviceProviderId === null
          ? isNull(serviceCoverage.serviceProviderId)
          : eq(serviceCoverage.serviceProviderId, target.serviceProviderId),
        packageId === null
          ? isNull(serviceCoverage.packageId)
          : eq(serviceCoverage.packageId, packageId),
      ));

      if (entries.length === 0)
        return;

      await tx.insert(serviceCoverage).values(entries.map(entry => ({
        tenantId,
        serviceId: target.serviceId,
        serviceProviderId: target.serviceProviderId,
        packageId,
        locationId: entry.locationId,
        isAvailable: entry.isAvailable ?? true,
        note: entry.note ?? null,
        createdBy: userId,
      })));
    });
  }

  async availabilityAt(tenantId: string, locationId: string): Promise<AvailabilityRow[]> {
    const result = await this.db.execute<AvailabilityRow>(sql`
      WITH chain AS (
        SELECT id, depth FROM geo.location_ancestors(${locationId})
      ),
      constants AS (
        SELECT '00000000-0000-0000-0000-000000000000'::uuid AS nil
      ),
      -- 1. Nearest ancestor rule (uses index service_coverage_tenant_location_idx)
      nearest AS (
        SELECT DISTINCT ON (
          c.service_id,
          coalesce(c.service_provider_id, k.nil),
          coalesce(c.package_id, k.nil)
        )
          c.service_id,
          coalesce(c.service_provider_id, k.nil) AS provider_id,
          coalesce(c.package_id, k.nil)          AS pkg_id,
          c.is_available
        FROM crm.service_coverage c
        CROSS JOIN constants k
        JOIN chain ON chain.id = c.location_id
        WHERE c.tenant_id = ${tenantId}
        ORDER BY
          c.service_id,
          coalesce(c.service_provider_id, k.nil),
          coalesce(c.package_id, k.nil),
          chain.depth
      ),
      -- 2. Entities that have an allowlist (at least one row with is_available = true)
      allowlists AS (
        SELECT DISTINCT
          c.service_id,
          coalesce(c.service_provider_id, k.nil) AS provider_id,
          coalesce(c.package_id, k.nil)          AS pkg_id
        FROM crm.service_coverage c
        CROSS JOIN constants k
        WHERE c.tenant_id = ${tenantId}
          AND c.is_available = true
      ),
      -- 3. Resolved rules: Hash join between nearest and allowlists
      rules AS (
        SELECT
          coalesce(n.service_id, a.service_id)   AS service_id,
          coalesce(n.provider_id, a.provider_id) AS provider_id,
          coalesce(n.pkg_id, a.pkg_id)           AS pkg_id,
          coalesce(n.is_available, a.service_id IS NULL) AS is_available
        FROM allowlists a
        FULL OUTER JOIN nearest n
          ON n.service_id = a.service_id
         AND n.provider_id = a.provider_id
         AND n.pkg_id = a.pkg_id
      )
      SELECT s.id            AS "serviceId",
             s.name          AS "serviceName",
             s.slug          AS "serviceSlug",
             s.icon          AS "serviceIcon",
             p.id            AS "providerId",
             p.name          AS "providerName",
             p.slug          AS "providerSlug",
             p.is_default    AS "isDefault",
             pk.id           AS "packageId",
             pk.name         AS "packageName",
             pk.slug         AS "packageSlug",
             pk.package_type AS "packageType",
             pk.price        AS "price",
             pk.billing_cycle AS "billingCycle",
             coalesce(rs.is_available, true)
               AND coalesce(rp.is_available, true)
               AND coalesce(rpk.is_available, true) AS "packageAvailable"
      FROM crm.service_providers p
      CROSS JOIN constants k
      JOIN crm.services s
        ON s.id = p.service_id
       AND s.tenant_id = p.tenant_id
       AND s.deleted_at IS NULL
       AND s.status = 'active'
      LEFT JOIN crm.packages pk
        ON pk.service_provider_id = p.id
       AND pk.tenant_id = p.tenant_id
       AND pk.deleted_at IS NULL
       AND pk.status = 'active'
      LEFT JOIN rules rpk
        ON rpk.service_id = p.service_id
       AND rpk.provider_id = p.id
       AND rpk.pkg_id = pk.id
      LEFT JOIN rules rp
        ON rp.service_id = p.service_id
       AND rp.provider_id = p.id
       AND rp.pkg_id = k.nil
      LEFT JOIN rules rs
        ON rs.service_id = p.service_id
       AND rs.provider_id = k.nil
       AND rs.pkg_id = k.nil
      WHERE p.tenant_id = ${tenantId}
        AND p.deleted_at IS NULL
        AND p.status = 'active'
        AND coalesce(rs.is_available, true)
        AND coalesce(rp.is_available, true)
      ORDER BY s.name, p.name, pk.name
    `);

    return result.rows;
  }

  async isPackageAvailableAt(tenantId: string, packageId: string, locationId: string): Promise<boolean> {
    const result = await this.db.execute<{ available: boolean }>(sql`
      SELECT crm.coverage_allows(
        ${tenantId}, p.service_id, p.id, pk.id, ${locationId}
      ) AS available
      FROM crm.packages pk
      JOIN crm.service_providers p
        ON p.id = pk.service_provider_id
       AND p.tenant_id = pk.tenant_id
       AND p.deleted_at IS NULL
      WHERE pk.id = ${packageId}
        AND pk.tenant_id = ${tenantId}
        AND pk.deleted_at IS NULL
    `);

    return result.rows[0]?.available ?? false;
  }
}
