import type { SQL } from 'drizzle-orm';
import type { CoverageTargetRef } from '../coverage.repository';
import type { AvailabilityResponse, CoverageEntry, CoverageResponse, SetCoverageBody } from '../service.schema';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
import type { PermissionKey } from '@/security/permissions';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { ERROR_CODES } from '@/errors/codes';
import { badRequest, forbidden, orNotFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { CoverageRepository } from '../coverage.repository';

export { coverageReachesGrant } from '../coverage.scope';

type AvailabilityRow = Awaited<ReturnType<CoverageRepository['availabilityAt']>>[number];

export class CoverageService {
  private readonly repo: CoverageRepository;

  constructor(repoOrDb: CoverageRepository | Database, private readonly locations: LocationsService) {
    this.repo = repoOrDb instanceof CoverageRepository ? repoOrDb : new CoverageRepository(repoOrDb);
  }

  async listForProvider(access: RequestAccess, providerId: string): Promise<CoverageResponse[]> {
    await this.findProvider(access, providerId, PERMISSIONS.SERVICES_VIEW);

    return this.rowsWhere(this.repo.forProvider(providerId), access, PERMISSIONS.SERVICES_VIEW);
  }

  async listForPackage(access: RequestAccess, packageId: string): Promise<CoverageResponse[]> {
    await this.findPackage(access, packageId, PERMISSIONS.PACKAGES_VIEW);

    return this.rowsWhere(this.repo.forPackage(packageId), access, PERMISSIONS.PACKAGES_VIEW);
  }

  async listForService(access: RequestAccess, serviceId: string): Promise<CoverageResponse[]> {
    await this.findService(access, serviceId, PERMISSIONS.SERVICES_VIEW);

    return this.rowsWhere(this.repo.forService(serviceId), access, PERMISSIONS.SERVICES_VIEW);
  }

  async replaceForProvider(access: RequestAccess, providerId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    const provider = await this.findProvider(access, providerId, PERMISSIONS.SERVICES_UPDATE);
    await this.locations.assertWithinReach(access, PERMISSIONS.SERVICES_UPDATE, input.entries.map(e => e.locationId));
    await this.assertWithinParent(access, {
      serviceId: provider.serviceId,
      serviceProviderId: null,
      entries: input.entries,
      parent: 'service',
    });

    const before = await this.listForProvider(access, providerId);

    await this.repo.replaceCoverage(access.tenantId, access.userId, {
      serviceId: provider.serviceId,
      serviceProviderId: providerId,
    }, input.entries);

    const after = await this.listForProvider(access, providerId);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: providerId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'provider', serviceId: provider.serviceId },
    });

    return after;
  }

  async replaceForPackage(access: RequestAccess, packageId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    const pkg = await this.findPackage(access, packageId, PERMISSIONS.PACKAGES_UPDATE);
    await this.locations.assertWithinReach(access, PERMISSIONS.PACKAGES_UPDATE, input.entries.map(e => e.locationId));
    await this.assertWithinParent(access, {
      serviceId: pkg.serviceId,
      serviceProviderId: pkg.serviceProviderId,
      entries: input.entries,
      parent: 'provider',
    });

    const before = await this.listForPackage(access, packageId);

    await this.repo.replaceCoverage(access.tenantId, access.userId, {
      serviceId: pkg.serviceId,
      serviceProviderId: pkg.serviceProviderId,
      packageId,
    }, input.entries);

    const after = await this.listForPackage(access, packageId);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: packageId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'package', serviceId: pkg.serviceId, serviceProviderId: pkg.serviceProviderId },
    });

    return after;
  }

  async replaceForService(access: RequestAccess, serviceId: string, input: SetCoverageBody): Promise<CoverageResponse[]> {
    await this.findService(access, serviceId, PERMISSIONS.SERVICES_UPDATE);
    await this.locations.assertWithinReach(access, PERMISSIONS.SERVICES_UPDATE, input.entries.map(e => e.locationId));

    const before = await this.listForService(access, serviceId);

    await this.repo.replaceCoverage(access.tenantId, access.userId, {
      serviceId,
      serviceProviderId: null,
    }, input.entries);

    const after = await this.listForService(access, serviceId);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.SERVICE_COVERAGE,
      entityId: serviceId,
      before: { coverage: before },
      after: { coverage: after },
      metadata: { scope: 'service' },
    });

    return after;
  }

  async availabilityAt(access: RequestAccess, locationId: string): Promise<AvailabilityResponse> {
    await this.assertNodeInReach(access, locationId);

    const rows = await this.repo.availabilityAt(access.tenantId, locationId);

    return { locationId, services: group(rows) };
  }

  async isPackageAvailableAt({ tenantId }: RequestAccess, target: { packageId: string; locationId: string }): Promise<boolean> {
    return this.repo.isPackageAvailableAt(tenantId, target.packageId, target.locationId);
  }

  private async assertWithinParent(access: RequestAccess, target: CoverageTargetRef & {
    entries: CoverageEntry[];
    parent: 'service' | 'provider';
  }): Promise<void> {
    const served = target.entries.filter(entry => entry.isAvailable !== false).map(entry => entry.locationId);

    if (served.length === 0)
      return;

    const places = await this.repo.pathsOutsideParent(access.tenantId, target, served);

    if (places.length === 0)
      return;

    throw badRequest(
      ERROR_CODES.VALIDATION_FAILED,
      `The ${target.parent} does not cover ${places.slice(0, 3).join(', ')}${places.length > 3 ? ` and ${places.length - 3} more` : ''}. Widen the ${target.parent}'s coverage first.`,
      places.map(path => ({ field: 'entries', issue: `Outside the ${target.parent}'s coverage: ${path}` })),
    );
  }

  private async assertNodeInReach(access: RequestAccess, locationId: string): Promise<void> {
    await this.locations.assertOwned(access, [locationId]);

    const reach = locationScopeFor(access, PERMISSIONS.SERVICES_VIEW);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return;

    if (!await this.repo.nodeUnderGrant(locationId, reach.nodeIds))
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');
  }

  private async rowsWhere(where: SQL, access: RequestAccess, key: PermissionKey): Promise<CoverageResponse[]> {
    return this.repo.listRows(
      access.tenantId,
      where,
      this.repo.rowsInReach(locationScopeFor(access, key)),
    );
  }

  private async findProvider(access: RequestAccess, id: string, key: PermissionKey) {
    const reach = this.repo.catalogueInReach(access.tenantId, locationScopeFor(access, key), this.repo.providerScope());
    return orNotFound(await this.repo.findProvider(access.tenantId, id, reach), 'Service provider');
  }

  private async findPackage(access: RequestAccess, id: string, key: PermissionKey) {
    const reach = this.repo.catalogueInReach(access.tenantId, locationScopeFor(access, key), this.repo.packageScope());
    return orNotFound(await this.repo.findPackage(access.tenantId, id, reach), 'Package');
  }

  private async findService(access: RequestAccess, id: string, key: PermissionKey) {
    const reach = this.repo.catalogueInReach(access.tenantId, locationScopeFor(access, key), this.repo.serviceScope());
    return orNotFound(await this.repo.findService(access.tenantId, id, reach), 'Service');
  }
}

function group(rows: AvailabilityRow[]): AvailabilityResponse['services'] {
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
