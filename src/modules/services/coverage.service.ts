import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AvailabilityResponse, CoverageEntry, CoverageResponse, SetCoverageBody } from './services.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/locations.service';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { locationPaths, serviceCoverage, serviceProviders, services } from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { notFound } from '@/shared/errors/domain-error';

type Db = NodePgDatabase<typeof schema>;

interface AvailabilityRow extends Record<string, unknown> {
  serviceId: string;
  serviceName: string;
  serviceSlug: string;
  serviceType: string;
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

    return this.rowsWhere(eq(serviceCoverage.serviceProviderId, providerId), access.tenantId);
  }

  async listForService(access: RequestAccess, serviceId: string): Promise<CoverageResponse[]> {
    await this.findService(access.tenantId, serviceId);

    return this.rowsWhere(
      and(eq(serviceCoverage.serviceId, serviceId), isNull(serviceCoverage.serviceProviderId))!,
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

    const before = await this.listForProvider(access, providerId);

    await this.write(access, {
      serviceId: provider.serviceId,
      serviceProviderId: providerId,
      entries: input.entries,
    });

    const after = await this.listForProvider(access, providerId);
    await audit.updated(this.db, access.audit, {
      entityType: 'service_coverage',
      entityId: providerId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'provider', serviceId: provider.serviceId },
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
      entityType: 'service_coverage',
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
   * Precedence, and nothing else: the nearest ancestor row for that provider
   * wins; failing that the nearest row for the service; failing that it is
   * available, so a tenant that configures no coverage sells everywhere.
   */
  async availabilityAt({ tenantId }: RequestAccess, locationId: string): Promise<AvailabilityResponse> {
    const result = await this.db.execute<AvailabilityRow>(sql`
      WITH chain AS (
        SELECT id, depth FROM geo.location_ancestors(${locationId})
      ),
      resolved AS (
        SELECT DISTINCT ON (c.service_id, c.service_provider_id)
               c.service_id, c.service_provider_id, c.is_available
        FROM crm.service_coverage c
        JOIN chain ON chain.id = c.location_id
        WHERE c.tenant_id = ${tenantId}
        ORDER BY c.service_id, c.service_provider_id, chain.depth
      )
      SELECT s.id            AS "serviceId",
             s.name          AS "serviceName",
             s.slug          AS "serviceSlug",
             s.service_type  AS "serviceType",
             p.id            AS "providerId",
             p.name          AS "providerName",
             p.slug          AS "providerSlug",
             p.is_default    AS "isDefault",
             pk.id           AS "packageId",
             pk.name         AS "packageName",
             pk.slug         AS "packageSlug",
             pk.package_type AS "packageType",
             pk.price        AS "price",
             pk.billing_cycle AS "billingCycle"
      FROM crm.service_providers p
      JOIN crm.services s ON s.id = p.service_id AND s.deleted_at IS NULL AND s.status = 'active'
      LEFT JOIN crm.packages pk
             ON pk.service_provider_id = p.id AND pk.deleted_at IS NULL AND pk.status = 'active'
      LEFT JOIN resolved rp ON rp.service_provider_id = p.id
      LEFT JOIN resolved rs ON rs.service_provider_id IS NULL AND rs.service_id = p.service_id
      WHERE p.tenant_id = ${tenantId}
        AND p.deleted_at IS NULL
        AND p.status = 'active'
        AND coalesce(rp.is_available, rs.is_available, true)
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
      WITH chain AS (
        SELECT id, depth FROM geo.location_ancestors(${target.locationId})
      ),
      pkg AS (
        SELECT pk.id, p.id AS provider_id, p.service_id
        FROM crm.packages pk
        JOIN crm.service_providers p ON p.id = pk.service_provider_id
        WHERE pk.id = ${target.packageId} AND pk.tenant_id = ${tenantId}
      ),
      resolved AS (
        SELECT DISTINCT ON (c.service_provider_id)
               c.service_provider_id, c.is_available
        FROM crm.service_coverage c
        JOIN chain ON chain.id = c.location_id
        JOIN pkg ON pkg.service_id = c.service_id
        WHERE c.tenant_id = ${tenantId}
          AND (c.service_provider_id = pkg.provider_id OR c.service_provider_id IS NULL)
        ORDER BY c.service_provider_id NULLS LAST, chain.depth
      )
      SELECT coalesce((SELECT is_available FROM resolved LIMIT 1), true) AS available
      FROM pkg
    `);

    const [row] = result.rows;

    // No row at all means the package is not this tenant's — not "available".
    return row?.available ?? false;
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private async write(access: RequestAccess, target: { serviceId: string; serviceProviderId: string | null; entries: CoverageEntry[] }): Promise<void> {
    const { tenantId } = access;

    await this.db.transaction(async (tx) => {
      await tx.delete(serviceCoverage).where(and(
        eq(serviceCoverage.tenantId, tenantId),
        eq(serviceCoverage.serviceId, target.serviceId),
        target.serviceProviderId === null
          ? isNull(serviceCoverage.serviceProviderId)
          : eq(serviceCoverage.serviceProviderId, target.serviceProviderId),
      ));

      if (target.entries.length === 0)
        return;

      await tx.insert(serviceCoverage).values(target.entries.map(entry => ({
        tenantId,
        serviceId: target.serviceId,
        serviceProviderId: target.serviceProviderId,
        locationId: entry.locationId,
        isAvailable: entry.isAvailable ?? true,
        note: entry.note ?? null,
        createdBy: access.userId,
      })));
    });
  }

  private async rowsWhere(where: SQL, tenantId: string): Promise<CoverageResponse[]> {
    const rows = await this.db
      .select({
        id: serviceCoverage.id,
        serviceId: serviceCoverage.serviceId,
        serviceProviderId: serviceCoverage.serviceProviderId,
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
          serviceType: row.serviceType,
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
      if (row.packageId !== null) {
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
