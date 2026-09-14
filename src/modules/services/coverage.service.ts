import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AvailabilityResponse, CoverageEntry, CoverageResponse, SetCoverageBody } from './services.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/locations.service';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { locationPaths, packages, serviceCoverage, serviceProviders, services } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { AUDIT_ENTITIES } from '@/shared/constants/audit';
import { ERROR_CODES } from '@/shared/errors/codes';
import { badRequest, notFound } from '@/shared/errors/domain-error';

type Db = NodePgDatabase<typeof schema>;

interface AvailabilityRow extends Record<string, unknown> {
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

/**
 * Where a service, or one provider of it, is sold
 * (docs/services-providers-packages.md §3, §5).
 *
 * A coverage row covers its node **and everything below it**, so an operator
 * states "ACT serves Mandapeta" once instead of per door. Resolution walks
 * `geo.location_ancestors` — at most the depth of the tree, whatever the tenant
 * has under it.
 */
export class CoverageService {
  constructor(private readonly db: Db, private readonly locations: LocationsService) {}

  async listForProvider(access: RequestAccess, providerId: string): Promise<CoverageResponse[]> {
    await this.findProvider(access.tenantId, providerId);

    return this.rowsWhere(
      and(eq(serviceCoverage.serviceProviderId, providerId), isNull(serviceCoverage.packageId))!,
      access.tenantId,
    );
  }

  /**
   * Where one package is sold, when that differs from its provider's reach.
   *
   * The narrowest statement the model makes: "ACT serves this apartment, but
   * not the 4K tier". Empty — the normal case — means the package goes wherever
   * its provider does.
   */
  async listForPackage(access: RequestAccess, packageId: string): Promise<CoverageResponse[]> {
    await this.findPackage(access.tenantId, packageId);

    return this.rowsWhere(eq(serviceCoverage.packageId, packageId), access.tenantId);
  }

  async listForService(access: RequestAccess, serviceId: string): Promise<CoverageResponse[]> {
    await this.findService(access.tenantId, serviceId);

    return this.rowsWhere(
      and(
        eq(serviceCoverage.serviceId, serviceId),
        isNull(serviceCoverage.serviceProviderId),
        isNull(serviceCoverage.packageId),
      )!,
      access.tenantId,
    );
  }

  /**
   * Replaces a provider's coverage in one call.
   *
   * Coverage is edited as a list in the UI. A diff of `POST`/`DELETE` calls is
   * three round trips and a half-applied state when one of them fails.
   */
  async replaceForProvider(access: RequestAccess, providerId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    const provider = await this.findProvider(access.tenantId, providerId);
    await this.locations.assertOwned(access, input.entries.map(e => e.locationId));
    await this.assertWithinParent(access, {
      serviceId: provider.serviceId,
      serviceProviderId: null,
      entries: input.entries,
      parent: 'service',
    });

    const before = await this.listForProvider(access, providerId);

    await this.write(access, {
      serviceId: provider.serviceId,
      serviceProviderId: providerId,
      entries: input.entries,
    });

    const after = await this.listForProvider(access, providerId);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: providerId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'provider', serviceId: provider.serviceId },
    });

    return after;
  }

  async replaceForPackage(access: RequestAccess, packageId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    const pkg = await this.findPackage(access.tenantId, packageId);
    await this.locations.assertOwned(access, input.entries.map(e => e.locationId));
    await this.assertWithinParent(access, {
      serviceId: pkg.serviceId,
      serviceProviderId: pkg.serviceProviderId,
      entries: input.entries,
      parent: 'provider',
    });

    const before = await this.listForPackage(access, packageId);

    await this.write(access, {
      serviceId: pkg.serviceId,
      serviceProviderId: pkg.serviceProviderId,
      packageId,
      entries: input.entries,
    });

    const after = await this.listForPackage(access, packageId);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: packageId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'package', serviceId: pkg.serviceId, serviceProviderId: pkg.serviceProviderId },
    });

    return after;
  }

  async replaceForService(access: RequestAccess, serviceId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    await this.findService(access.tenantId, serviceId);
    await this.locations.assertOwned(access, input.entries.map(e => e.locationId));

    const before = await this.listForService(access, serviceId);

    await this.write(access, { serviceId, serviceProviderId: null, entries: input.entries });

    const after = await this.listForService(access, serviceId);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: serviceId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'service' },
    });

    return after;
  }

  /**
   * What a customer at this node can actually be sold (§5 of the doc).
   *
   * Three rules, stated in full in `crm.coverage_allows`: a level that names
   * where it sells sells nowhere else, the nearest ancestor wins within a
   * level, and a parent bounds its children. A level that has said nothing
   * says nothing, so a tenant who has configured no coverage sells everywhere.
   */
  async availabilityAt({ tenantId }: RequestAccess, locationId: string): Promise<AvailabilityResponse> {
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

    return { locationId, services: this.group(result.rows) };
  }

  /**
   * Does this package reach this location? The check a subscription makes
   * before it is written (§6 of the doc).
   */
  async isPackageAvailableAt({ tenantId }: RequestAccess, target: { packageId: string; locationId: string }): Promise<boolean> {
    const result = await this.db.execute<{ available: boolean }>(sql`
      SELECT crm.coverage_allows(
        ${tenantId}, p.service_id, p.id, pk.id, ${target.locationId}
      ) AS available
      FROM crm.packages pk
      JOIN crm.service_providers p ON p.id = pk.service_provider_id
      WHERE pk.id = ${target.packageId} AND pk.tenant_id = ${tenantId}
    `);

    const [row] = result.rows;

    // No row at all means the package is not this tenant's — not "available".
    return row?.available ?? false;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  /**
   * A child cannot be sold where its parent is not.
   *
   * `crm.coverage_allows` already ANDs the levels, so a row outside the parent
   * would simply never resolve available — dead data that reads on screen as a
   * served area. Rejecting it at the write is the only place the operator can
   * still be told which places were the problem.
   *
   * Only the `true` entries are checked: marking somewhere "not served" that
   * the parent does not serve either is redundant, not wrong, and a carve-out
   * kept while a parent is temporarily narrowed is worth keeping.
   */
  private async assertWithinParent(access: RequestAccess, target: {
    serviceId: string;
    serviceProviderId: string | null;
    entries: CoverageEntry[];
    parent: 'service' | 'provider';
  }): Promise<void> {
    const served = target.entries.filter(entry => entry.isAvailable !== false).map(entry => entry.locationId);

    if (served.length === 0)
      return;

    const result = await this.db.execute<{ path: string }>(sql`
      SELECT lp.path
      FROM unnest(${sql.param(served)}::uuid[]) AS n(id)
      JOIN geo.location_paths lp ON lp.id = n.id
      WHERE NOT crm.coverage_allows(
        ${access.tenantId}, ${target.serviceId}, ${target.serviceProviderId}, NULL, n.id
      )
      ORDER BY lp.path
    `);

    if (result.rows.length === 0)
      return;

    const places = result.rows.map(row => row.path);
    throw badRequest(
      ERROR_CODES.VALIDATION_FAILED,
      `The ${target.parent} does not cover ${places.slice(0, 3).join(', ')}${places.length > 3 ? ` and ${places.length - 3} more` : ''}. Widen the ${target.parent}'s coverage first.`,
      places.map(path => ({ field: 'entries', issue: `Outside the ${target.parent}'s coverage: ${path}` })),
    );
  }

  private async write(access: RequestAccess, target: {
    serviceId: string;
    serviceProviderId: string | null;
    packageId?: string | null;
    entries: CoverageEntry[];
  }): Promise<void> {
    const { tenantId } = access;
    const packageId = target.packageId ?? null;

    await this.db.transaction(async (tx) => {
      // Scoped to exactly one level: replacing a provider's coverage must not
      // silently drop the package rows that sit underneath it.
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

      if (target.entries.length === 0)
        return;

      await tx.insert(serviceCoverage).values(target.entries.map(entry => ({
        tenantId,
        serviceId: target.serviceId,
        serviceProviderId: target.serviceProviderId,
        packageId,
        locationId: entry.locationId,
        isAvailable: entry.isAvailable ?? true,
        note: entry.note ?? null,
        createdBy: access.userId,
      })));
    });
  }

  private async findPackage(tenantId: string, id: string) {
    const [row] = await this.db
      .select({
        id: packages.id,
        serviceProviderId: packages.serviceProviderId,
        serviceId: serviceProviders.serviceId,
      })
      .from(packages)
      .innerJoin(serviceProviders, eq(serviceProviders.id, packages.serviceProviderId))
      .where(and(eq(packages.tenantId, tenantId), eq(packages.id, id), isNull(packages.deletedAt)))
      .limit(1);

    if (row === undefined)
      throw notFound('Package');

    return row;
  }

  private async rowsWhere(where: SQL, tenantId: string): Promise<CoverageResponse[]> {
    const rows = await this.db
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
      // `geo.location_paths` resolves the breadcrumb once (§8.3) — coverage is
      // read as "ACT: Mandapeta / Sri Sai Apartments", not as a bare uuid.
      .innerJoin(locationPaths, eq(locationPaths.id, serviceCoverage.locationId))
      .where(and(eq(serviceCoverage.tenantId, tenantId), where))
      .orderBy(asc(locationPaths.path));

    return rows;
  }

  private group(rows: AvailabilityRow[]): AvailabilityResponse['services'] {
    const byService = new Map<string, AvailabilityResponse['services'][number]>();

    for (const row of rows) {
      let service = byService.get(row.serviceId);
      if (service === undefined) {
        service = {
          id: row.serviceId,
          name: row.serviceName,
          slug: row.serviceSlug,
          icon: row.serviceIcon,
          providers: [],
        };
        byService.set(row.serviceId, service);
      }

      let provider = service.providers.find(p => p.id === row.providerId);
      if (provider === undefined) {
        provider = {
          id: row.providerId,
          name: row.providerName,
          slug: row.providerSlug,
          isDefault: row.isDefault,
          packages: [],
        };
        service.providers.push(provider);
      }

      // A provider with no active package still shows up: it covers the
      // address, it just has nothing to sell yet, and hiding it makes that look
      // like a coverage problem.
      if (row.packageId !== null && row.packageAvailable) {
        provider.packages.push({
          id: row.packageId,
          name: row.packageName!,
          slug: row.packageSlug!,
          packageType: row.packageType!,
          price: row.price!,
          billingCycle: row.billingCycle!,
        });
      }
    }

    return [...byService.values()];
  }

  private async findProvider(tenantId: string, id: string) {
    const [row] = await this.db
      .select({ id: serviceProviders.id, serviceId: serviceProviders.serviceId })
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

  private async findService(tenantId: string, id: string) {
    const [row] = await this.db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.tenantId, tenantId), eq(services.id, id), isNull(services.deletedAt)))
      .limit(1);

    if (row === undefined)
      throw notFound('Service');

    return row;
  }
}
