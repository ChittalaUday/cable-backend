import type { ProviderRecord, ServiceRecord } from '../service.repository';
import type {
  CreateProviderBody,
  CreateServiceBody,
  ListProvidersQuery,
  ListServicesQuery,
  ProviderResponse,
  ServiceResponse,
  UpdateProviderBody,
  UpdateServiceBody,
} from '../service.schema';
import type { Database } from '@/db/client';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { ENTITY_STATUS } from '@/constants/crm';
import { isUniqueViolation } from '@/errors';
import { conflict, inUse, orNotFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { uniqueSlug } from '@/utils/slug';
import { ServiceRepository } from '../service.repository';

export class ServicesService {
  private readonly repo: ServiceRepository;

  constructor(repoOrDb: ServiceRepository | Database) {
    this.repo = repoOrDb instanceof ServiceRepository ? repoOrDb : new ServiceRepository(repoOrDb);
  }

  private servicesInReach(access: RequestAccess, key: PermissionKey) {
    return this.repo.servicesInReach(access.tenantId, locationScopeFor(access, key));
  }

  private providersInReach(access: RequestAccess, key: PermissionKey) {
    return this.repo.providersInReach(access.tenantId, locationScopeFor(access, key));
  }

  async list(access: RequestAccess, query: ListServicesQuery): Promise<ServiceResponse[]> {
    const rows = await this.repo.listServices(
      access.tenantId,
      query,
      this.servicesInReach(access, PERMISSIONS.SERVICES_VIEW),
    );

    const providerRows = await this.repo.listProviders(
      access.tenantId,
      {},
      this.providersInReach(access, PERMISSIONS.SERVICES_VIEW),
    );

    const providersByService = new Map<string, ProviderResponse[]>();
    for (const p of providerRows) {
      const list = providersByService.get(p.provider.serviceId) ?? [];
      list.push(presentProvider(p.provider, p));
      providersByService.set(p.provider.serviceId, list);
    }

    return rows.map(row => presentService(
      row.service,
      row.providerCount,
      providersByService.get(row.service.id) ?? [],
    ));
  }

  async get(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.SERVICES_VIEW): Promise<ServiceResponse> {
    const row = await this.findService(access, id, key);
    const providerRows = await this.repo.listProvidersOfService(
      access.tenantId,
      id,
      this.providersInReach(access, key),
    );

    const providers = providerRows.map(p => presentProvider(p.provider, {
      serviceName: row.name,
      serviceIcon: row.icon,
      packageCount: p.packageCount,
    }));
    const activeCount = providers.filter(p => p.status === ENTITY_STATUS.ACTIVE).length;

    return presentService(row, activeCount, providers);
  }

  async create({ tenantId, audit: context }: RequestAccess, input: CreateServiceBody): Promise<ServiceResponse> {
    const slug = input.slug ?? uniqueSlug(input.name, await this.repo.takenServiceSlugs(tenantId));

    try {
      const row = await this.repo.createService({ tenantId, ...input, slug, metadata: input.metadata ?? null });

      const created = presentService(row, 0, []);
      await audit.created(this.repo.database, context, { entityType: AUDIT_ENTITIES.SERVICE, entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A service named "${input.name}" already exists`);
      throw error;
    }
  }

  async update(access: RequestAccess, id: string, patch: UpdateServiceBody): Promise<ServiceResponse> {
    const before = await this.get(access, id, PERMISSIONS.SERVICES_UPDATE);

    await this.repo.updateService(access.tenantId, id, patch);

    // Re-read under the permission that authorised the write: a role holding
    // `services.update` without `services.view` would otherwise be refused its
    // own result.
    const after = await this.get(access, id, PERMISSIONS.SERVICES_UPDATE);
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const { tenantId, audit: context } = access;

    if (!await this.repo.serviceExists(tenantId, id))
      return;

    const before = await this.findService(access, id, PERMISSIONS.SERVICES_DELETE);
    const providers = await this.repo.countLiveProviders(tenantId, id);

    if (providers > 0)
      throw inUse('This service still has providers; remove them first');

    await this.repo.softDeleteService(tenantId, id, ENTITY_STATUS.INACTIVE);
    await audit.deleted(this.repo.database, context, { entityType: AUDIT_ENTITIES.SERVICE, entityId: id, before });
  }

  async listProviders(access: RequestAccess, query: ListProvidersQuery): Promise<ProviderResponse[]> {
    const rows = await this.repo.listProviders(
      access.tenantId,
      query,
      this.providersInReach(access, PERMISSIONS.SERVICES_VIEW),
    );

    return rows.map(row => presentProvider(row.provider, row));
  }

  async getProvider(access: RequestAccess, id: string, key: PermissionKey = PERMISSIONS.SERVICES_VIEW): Promise<ProviderResponse> {
    const found = orNotFound(
      await this.repo.findProvider(access.tenantId, id, this.providersInReach(access, key)),
      'Service provider',
    );

    return presentProvider(found.provider, found);
  }

  async createProvider(access: RequestAccess, input: CreateProviderBody): Promise<ProviderResponse> {
    const { tenantId } = access;
    await this.findService(access, input.serviceId, PERMISSIONS.SERVICES_CREATE);

    const slug = input.slug ?? uniqueSlug(input.name, await this.repo.takenProviderSlugs(tenantId, input.serviceId));

    try {
      const id = await this.repo.createProvider(tenantId, {
        tenantId,
        ...input,
        slug,
        contact: input.contact ?? null,
        metadata: input.metadata ?? null,
      }, input.isDefault === true);

      const created = await this.getProvider(access, id, PERMISSIONS.SERVICES_CREATE);
      await audit.created(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A provider named "${input.name}" already supplies this service`);
      throw error;
    }
  }

  async updateProvider(access: RequestAccess, id: string, patch: UpdateProviderBody): Promise<ProviderResponse> {
    const existing = await this.getProvider(access, id, PERMISSIONS.SERVICES_UPDATE);

    try {
      await this.repo.updateProvider(access.tenantId, id, existing.serviceId, patch);
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict('Another provider of this service already has that slug');
      throw error;
    }

    const after = await this.getProvider(access, id, PERMISSIONS.SERVICES_UPDATE);
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, before: existing, after });

    return after;
  }

  async removeProvider(access: RequestAccess, id: string): Promise<void> {
    const { tenantId } = access;
    const before = await this.getProvider(access, id, PERMISSIONS.SERVICES_DELETE);

    // A soft delete raises no foreign key error, so what still depends on the row
    // has to be counted here or it is left pointing at a provider nobody can see.
    const live = await this.repo.countLiveSubscriptionsOfProvider(tenantId, id);

    if (live > 0)
      throw inUse(`${live} subscription(s) are still with this provider`);

    const livePackages = await this.repo.countLivePackagesOfProvider(tenantId, id);

    if (livePackages > 0)
      throw inUse(`${livePackages} package(s) still belong to this provider; remove them first`);

    await this.repo.softDeleteProvider(tenantId, id, ENTITY_STATUS.INACTIVE);
    await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.SERVICE_PROVIDER, entityId: id, before });
  }

  private async findService(access: RequestAccess, id: string, key: PermissionKey): Promise<ServiceRecord> {
    return orNotFound(
      await this.repo.findService(access.tenantId, id, this.servicesInReach(access, key)),
      'Service',
    );
  }
}

function presentService(
  row: ServiceRecord,
  providerCount: number,
  providers: ProviderResponse[] = [],
): ServiceResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    icon: row.icon,
    description: row.description,
    status: row.status,
    metadata: row.metadata as Record<string, unknown> | null,
    providerCount,
    providers,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function presentProvider(
  row: ProviderRecord,
  meta: { serviceName: string; serviceIcon: string | null; packageCount?: number },
): ProviderResponse {
  return {
    id: row.id,
    serviceId: row.serviceId,
    serviceName: meta.serviceName,
    serviceIcon: meta.serviceIcon,
    packageCount: meta.packageCount ?? 0,
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
