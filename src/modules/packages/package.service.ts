import type { PackageRow } from './package.repository';
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
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page, PaginationQuery } from '@/utils/pagination';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { ENTITY_STATUS } from '@/constants/crm';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, inUse, notFound, orNotFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { pageOf } from '@/utils/pagination';
import { uniqueSlug } from '@/utils/slug';
import { PackageRepository } from './package.repository';

export class PackagesService {
  private readonly repo: PackageRepository;

  constructor(repoOrDb: PackageRepository | Database) {
    this.repo = repoOrDb instanceof PackageRepository ? repoOrDb : new PackageRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListPackagesQuery): Promise<Page<PackageResponse>> {
    const reach = this.repo.packagesInReach(access.tenantId, locationScopeFor(access, PERMISSIONS.PACKAGES_VIEW));
    const page = query as PaginationQuery & { limit: number };

    return pageOf(query as PaginationQuery, {
      ...this.repo.listPackagesPage(access.tenantId, query, reach, page),
      present: rows => rows.map(row => present(row)),
    });
  }

  async get(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.PACKAGES_VIEW): Promise<PackageDetailResponse> {
    const row = await this.find(access, id, key);
    const channels = await this.repo.findPackageLineup(id);

    return { ...present(row), channels };
  }

  async create(access: RequestAccess, input: CreatePackageBody): Promise<PackageResponse> {
    const { tenantId, audit: context } = access;

    if (!await this.repo.providerExists(tenantId, input.serviceProviderId))
      throw notFound('Service provider');

    const slug = input.slug ?? uniqueSlug(input.name, await this.repo.takenSlugs(tenantId, input.serviceProviderId));

    try {
      const id = await this.repo.createPackage({
        tenantId,
        ...input,
        slug,
        metadata: input.metadata ?? null,
      });

      const created = present(await this.find(access, id, PERMISSIONS.PACKAGES_CREATE));
      await audit.created(this.repo.database, context, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`This provider already has a package named "${input.name}"`);
      throw error;
    }
  }

  async update(access: RequestAccess, id: string, patch: UpdatePackageBody): Promise<PackageResponse> {
    const before = present(await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE));

    await this.repo.updatePackage(access.tenantId, id, patch);

    const after = present(await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE));
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const { tenantId, audit: context } = access;

    if (!await this.repo.packageExists(tenantId, id))
      return;

    const before = present(await this.find(access, id, PERMISSIONS.PACKAGES_DELETE));
    const live = await this.repo.countLiveSubscriptions(tenantId, id);

    if (live > 0)
      throw inUse(`${live} subscription(s) are still on this package`);

    await this.repo.softDeletePackage(tenantId, id, ENTITY_STATUS.INACTIVE);
    await audit.deleted(this.repo.database, context, { entityType: AUDIT_ENTITIES.PACKAGE, entityId: id, before });
  }

  async setChannels(access: RequestAccess, id: string, input: SetPackageChannelsBody): Promise<PackageDetailResponse> {
    const before = await this.get(access, id, PERMISSIONS.PACKAGES_UPDATE);
    const pkg = await this.find(access, id, PERMISSIONS.PACKAGES_UPDATE);
    const ids = input.channels.map(c => c.channelId);

    if (ids.length > 0) {
      if (new Set(ids).size !== ids.length)
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Duplicate channels cannot be added to the same package');

      const owned = await this.repo.findProviderChannels(access.tenantId, pkg.package.serviceProviderId, ids);

      if (owned.length !== ids.length)
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Every channel must belong to this package’s provider');
    }

    await this.repo.replacePackageChannels(id, input.channels);

    const after = await this.get(access, id, PERMISSIONS.PACKAGES_UPDATE);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.PACKAGE_CHANNELS,
      entityId: id,
      before: { channels: before.channels },
      after: { channels: after.channels },
    });

    return after;
  }

  async listChannels(access: RequestAccess, query: ListChannelsQuery): Promise<Page<ChannelResponse>> {
    const reach = this.repo.channelsInReach(access.tenantId, locationScopeFor(access, PERMISSIONS.PACKAGES_VIEW));
    const page = query as PaginationQuery & { limit: number };

    return pageOf(query as PaginationQuery, {
      ...this.repo.listChannelsPage(access.tenantId, query, reach, page),
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

  private async find(access: RequestAccess, id: string, key: PermissionKey): Promise<PackageRow> {
    const reach = this.repo.packagesInReach(access.tenantId, locationScopeFor(access, key));
    return orNotFound(await this.repo.findPackage(access.tenantId, id, reach), 'Package');
  }
}

function present(row: PackageRow): PackageResponse {
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
