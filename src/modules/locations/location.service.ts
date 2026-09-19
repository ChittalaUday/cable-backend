import type { SQL } from 'drizzle-orm';
import type {
  AncestorResponse,
  CategoryResponse,
  CreateCategoryBody,
  CreateLocationBody,
  CreateSchemaBody,
  GenerateBody,
  ListLocationsQuery,
  LocationResponse,
  SchemaResponse,
  UpdateCategoryBody,
  UpdateLocationBody,
  UpdateSchemaBody,
} from './location.schema';
import type { LocationWritableStatus } from '@/constants/geo';
import type { Database as Db, Transaction as Tx } from '@/db/client';
import type { locationCategories, locations as locationsTable } from '@/db/schema';
import type { AccessContext, RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey, PermissionScope } from '@/security/permissions';
import type { Page } from '@/utils/pagination';
import { and } from 'drizzle-orm';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { LOCATION_SOURCE, LOCATION_STATUS } from '@/constants/geo';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, forbidden, inUse, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { locationScopeFor, requireScope } from '@/modules/iam/access.service';
import { PERMISSIONS } from '@/security/permissions';
import { offsetOf } from '@/utils/pagination';
import { LocationRepository } from './location.repository';
import { countGenerated, expandLevel, NO_PARENT } from './locations.generate';

const MAX_GENERATED_NODES = 2000;

function provenance(access: AccessContext, status: LocationWritableStatus | undefined) {
  const configures = access.permissions.has(PERMISSIONS.LOCATIONS_CONFIGURE);

  return {
    source: configures ? LOCATION_SOURCE.ADMIN : LOCATION_SOURCE.USER,
    status: configures ? (status ?? LOCATION_STATUS.APPROVED) : LOCATION_STATUS.PENDING,
  };
}

function coordinates(input: { latitude?: number | null; longitude?: number | null }) {
  return {
    ...(input.latitude === undefined ? {} : { latitude: input.latitude === null ? null : String(input.latitude) }),
    ...(input.longitude === undefined ? {} : { longitude: input.longitude === null ? null : String(input.longitude) }),
  };
}

export class LocationsService {
  private readonly repo: LocationRepository;

  constructor(repoOrDb: LocationRepository | Db) {
    this.repo = repoOrDb instanceof LocationRepository
      ? repoOrDb
      : new LocationRepository(repoOrDb);
  }

  async listCategories({ tenantId }: RequestAccess): Promise<CategoryResponse[]> {
    const rows = await this.repo.listCategories(tenantId);

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      config: row.config as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async createCategory({ tenantId, audit: context }: RequestAccess, input: CreateCategoryBody): Promise<CategoryResponse> {
    try {
      const row = await this.repo.createCategory({
        tenantId,
        name: input.name,
        slug: input.slug,
        config: input.config ?? {},
      });

      const created = this.categoryOf(row);
      await audit.created(this.repo.database, context, { entityType: AUDIT_ENTITIES.LOCATION_CATEGORY, entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A category with slug "${input.slug}" already exists`);
      throw error;
    }
  }

  async updateCategory({ tenantId, audit: context }: RequestAccess, id: string, patch: UpdateCategoryBody): Promise<CategoryResponse> {
    const existing = await this.repo.findCategoryById(tenantId, id);
    if (existing === null)
      throw notFound('Category');

    const row = await this.repo.updateCategory(tenantId, id, patch);
    if (row === null)
      throw notFound('Category');

    const after = this.categoryOf(row);
    await audit.updated(this.repo.database, context, {
      entityType: AUDIT_ENTITIES.LOCATION_CATEGORY,
      entityId: id,
      before: this.categoryOf(existing),
      after,
    });

    return after;
  }

  async deleteCategory({ tenantId, audit: context }: RequestAccess, id: string): Promise<void> {
    const existing = await this.repo.findCategoryById(tenantId, id);

    const inUseByLevelsOrLocations = await this.repo.isCategoryInUse(tenantId, id);
    if (inUseByLevelsOrLocations)
      throw inUse('This category is still used by a schema level or a location');

    await this.repo.softDeleteCategory(tenantId, id);

    if (existing !== null)
      await audit.deleted(this.repo.database, context, { entityType: AUDIT_ENTITIES.LOCATION_CATEGORY, entityId: id, before: this.categoryOf(existing) });
  }

  async listSchemas({ tenantId }: RequestAccess): Promise<SchemaResponse[]> {
    const rows = await this.repo.listSchemas(tenantId);

    if (rows.length === 0)
      return [];

    const levels = await this.levelsOf(rows.map(r => r.id));

    return rows.map(row => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      description: row.description,
      isActive: row.isActive,
      levels: levels.get(row.id) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async createSchema(access: RequestAccess, input: CreateSchemaBody): Promise<SchemaResponse> {
    const { tenantId } = access;
    const categoryIds = input.levels.map(level => level.categoryId);

    if (new Set(categoryIds).size !== categoryIds.length)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A category may appear at only one level of a schema');

    const known = await this.repo.findCategoriesByIds(tenantId, categoryIds);

    if (known.length !== categoryIds.length)
      throw notFound('Category');

    let id: string;
    try {
      id = await this.repo.createSchemaWithLevels(
        tenantId,
        {
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
        },
        input.levels.map((level, depth) => ({
          categoryId: level.categoryId,
          depth,
          isTerminal: level.isTerminal ?? depth === input.levels.length - 1,
          config: level.config ?? {},
        })),
      );
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A schema with slug "${input.slug}" already exists`);
      throw error;
    }

    const [created] = await this.listSchemasById(access, [id]);
    await audit.created(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.LOCATION_SCHEMA, entityId: id, after: created! });

    return created!;
  }

  async updateSchema(access: RequestAccess, id: string, patch: UpdateSchemaBody): Promise<SchemaResponse> {
    const { tenantId } = access;
    const [before] = await this.listSchemasById(access, [id]);
    const row = await this.repo.updateSchema(tenantId, id, patch);

    if (row === null)
      throw notFound('Location schema');

    const [updated] = await this.listSchemasById(access, [id]);
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.LOCATION_SCHEMA, entityId: id, before: before!, after: updated! });

    return updated!;
  }

  async deleteSchema(access: RequestAccess, id: string): Promise<void> {
    const { tenantId } = access;
    const [before] = await this.listSchemasById(access, [id]);

    // A soft delete raises no foreign key error, so the dependency has to be
    // counted here or the schema goes while its locations still point at it.
    if (await this.repo.schemaHasLocations(tenantId, id))
      throw inUse('This schema still has locations; delete or move them first');

    await this.repo.softDeleteSchema(tenantId, id);

    if (before !== undefined)
      await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.LOCATION_SCHEMA, entityId: id, before });
  }

  async generate(access: RequestAccess, schemaId: string, input: GenerateBody): Promise<{ created: number; leafIds: string[] }> {
    const { tenantId } = access;
    const total = countGenerated(input.levels);

    if (total === 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'Every level needs either names or a count');

    if (total > MAX_GENERATED_NODES)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, `That would create ${total} locations; the limit is ${MAX_GENERATED_NODES}`);

    const levels = await this.levelChain(tenantId, schemaId);
    const parentId = input.parentId ?? null;
    let startDepth = 0;

    if (parentId !== null) {
      const parent = await this.findNode(tenantId, parentId);
      if (parent.schemaId !== schemaId)
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'The parent belongs to a different location schema');

      await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_CONFIGURE, nodeId: parent.id, createdBy: parent.createdBy });
      startDepth = this.depthOf(levels, parent.categoryId) + 1;
    }

    if (startDepth + input.levels.length > levels.length)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'More levels requested than the schema defines below this parent');

    return this.repo.transaction(async (tx) => {
      let parents = parentId === null
        ? [NO_PARENT]
        : [await this.repo.parentSeed(parentId, tx)];
      let parentIds: (string | null)[] = [parentId];
      let created = 0;
      let leafIds: string[] = [];

      for (const [offset, level] of input.levels.entries()) {
        const expanded = expandLevel(parents, level);
        const categoryId = levels[startDepth + offset]!.categoryId;

        const inserted = await this.repo.batchCreateLocations(expanded.map(node => ({
          tenantId,
          schemaId,
          categoryId,
          parentId: parentIds[node.parentIndex] ?? null,
          name: node.name,
          code: node.code,
          source: LOCATION_SOURCE.ADMIN,
          createdBy: access.userId,
        })), tx);

        created += inserted.length;
        leafIds = inserted.map(row => row.id);
        parents = inserted.map(row => ({ name: row.name, code: row.code }));
        parentIds = inserted.map(row => row.id);
      }

      await audit.log(tx, access.audit, {
        action: AUDIT_ACTIONS.LOCATION_GENERATED,
        entityType: AUDIT_ENTITIES.LOCATION_SCHEMA,
        entityId: schemaId,
        after: { parentId, created, leafIds },
      });

      return { created, leafIds };
    }).catch((error: unknown) => {
      if (isUniqueViolation(error))
        throw conflict('Generation would create a location that already exists here');
      throw error;
    });
  }

  async list(access: RequestAccess, query: ListLocationsQuery): Promise<Page<LocationResponse>> {
    const { tenantId } = access;
    const scope = requireScope(access, PERMISSIONS.LOCATIONS_VIEW);
    const reach = this.reachCondition(access, scope);

    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters: (SQL | undefined)[] = [this.repo.liveIn(tenantId), ...reach];

    if (query.parentId !== undefined)
      filters.push(this.repo.matchesParent(query.parentId === 'null' ? null : query.parentId));
    if (query.ancestorId !== undefined)
      filters.push(this.repo.underAncestor(query.ancestorId));
    if (query.schemaId !== undefined)
      filters.push(this.repo.matchesSchema(query.schemaId));
    if (query.categoryId !== undefined)
      filters.push(this.repo.matchesCategory(query.categoryId));
    if (query.status !== undefined)
      filters.push(this.repo.matchesStatus(query.status));
    if (query.isActive !== undefined)
      filters.push(this.repo.matchesActive(query.isActive));
    if (query.coverageServiceId !== undefined)
      filters.push(this.repo.coveredBy(tenantId, query.coverageServiceId, query.coverageProviderId ?? null));
    if (query.q !== undefined)
      filters.push(this.repo.nameOrAliasMatches(query.q));

    const where = and(...filters)!;

    const { rows, total } = await this.repo.listLocations(
      where,
      query.limit,
      offsetOf(query),
    );

    return {
      items: await this.present(rows),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async ancestorsOf(access: RequestAccess, id: string): Promise<AncestorResponse[]> {
    const node = await this.findNode(access.tenantId, id);
    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_VIEW, nodeId: node.id, createdBy: node.createdBy });

    const ids = await this.repo.findAncestorIds(id);
    if (ids.length === 0)
      return [];

    const rows = await this.repo.findLocationsByIds(access.tenantId, ids);
    const byId = new Map(rows.map(row => [row.id, row]));
    const ordered = ids.map(nodeId => byId.get(nodeId)).filter(row => row !== undefined);

    const [presented, rankById] = await Promise.all([
      this.present(ordered),
      this.repo.findSiblingRanks(ids),
    ]);

    return presented.map(row => ({ ...row, siblingIndex: rankById.get(row.id) ?? 0 }));
  }

  async get(access: RequestAccess, id: string): Promise<LocationResponse> {
    const row = await this.findNode(access.tenantId, id);
    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_VIEW, nodeId: row.id, createdBy: row.createdBy });

    const [presented] = await this.present([row]);
    return presented!;
  }

  async create(access: RequestAccess, input: CreateLocationBody): Promise<LocationResponse> {
    const { tenantId } = access;
    const { parentId, schemaId, categoryId } = await this.placeFor(access, input);

    try {
      return await this.repo.transaction(async (tx) => {
        const row = await this.repo.createLocation({
          tenantId,
          schemaId,
          categoryId,
          parentId,
          name: input.name,
          code: input.code ?? null,
          ...provenance(access, input.status),
          ...coordinates(input),
          metadata: input.metadata ?? null,
          createdBy: access.userId,
        }, tx);

        await this.repo.replaceAliases(tenantId, row.id, input.aliases, tx);

        const [presented] = await this.present([row], tx);
        await audit.created(tx, access.audit, { entityType: AUDIT_ENTITIES.LOCATION, entityId: row.id, after: presented! });

        return presented!;
      });
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`"${input.name}" already exists at this level`);
      throw error;
    }
  }

  async update(access: RequestAccess, id: string, patch: UpdateLocationBody): Promise<LocationResponse> {
    const { tenantId } = access;
    const existing = await this.findNode(tenantId, id);
    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_UPDATE, nodeId: existing.id, createdBy: existing.createdBy });

    const { aliases, latitude: _lat, longitude: _lng, ...rest } = patch;
    const [before] = await this.present([existing]);

    try {
      return await this.repo.transaction(async (tx) => {
        const row = await this.repo.updateLocation(
          tenantId,
          id,
          { ...rest, ...coordinates(patch), updatedAt: new Date() },
          tx,
        );

        if (row === null)
          throw notFound('Location');

        await this.repo.replaceAliases(tenantId, id, aliases, tx);

        const [presented] = await this.present([row], tx);
        await audit.updated(tx, access.audit, { entityType: AUDIT_ENTITIES.LOCATION, entityId: id, before: before!, after: presented! });

        return presented!;
      });
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict('Another location at this level already has that name');
      throw error;
    }
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const { tenantId } = access;
    const existing = await this.repo.findLocationById(tenantId, id);

    if (existing === null)
      return;

    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_DELETE, nodeId: id, createdBy: existing.createdBy });

    const [before] = await this.present([existing]);

    const childCount = await this.repo.countChildren(tenantId, id);
    if (childCount > 0)
      throw inUse('This location still has children or customers assigned to it');

    const isAssigned = await this.repo.isLocationAssigned(tenantId, id);
    if (isAssigned) {
      await this.repo.updateLocation(tenantId, id, { isActive: false });
      await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.LOCATION, entityId: id, before: before! });
      return;
    }

    await this.repo.softDeleteLocation(tenantId, id);

    await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.LOCATION, entityId: id, before: before! });
  }

  async assertWithinReach(access: RequestAccess, key: PermissionKey, ids: readonly string[]): Promise<void> {
    await this.assertOwned(access, ids);

    if (ids.length === 0)
      return;

    const reach = locationScopeFor(access, key);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return;

    const outside = await this.repo.findOutsideGrants(ids as string[], reach.nodeIds);

    if (outside.length > 0)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'That area is outside your own grant');
  }

  async assertOwned({ tenantId }: RequestAccess, ids: readonly string[]): Promise<void> {
    if (ids.length === 0)
      return;

    const wanted = [...new Set(ids)];
    const owned = await this.repo.findOwnedLocationIds(tenantId, wanted);

    if (owned.length !== wanted.length)
      throw notFound('Location');
  }

  private categoryOf(row: typeof locationCategories.$inferSelect): CategoryResponse {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      config: row.config as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async listSchemasById(access: RequestAccess, ids: string[]): Promise<SchemaResponse[]> {
    const all = await this.listSchemas(access);
    return all.filter(s => ids.includes(s.id));
  }

  private async levelsOf(schemaIds: string[]) {
    const rows = await this.repo.findSchemaLevelsWithCategories(schemaIds);

    const grouped = new Map<string, SchemaResponse['levels']>();
    for (const row of rows) {
      const list = grouped.get(row.schemaId) ?? [];
      list.push({ ...row, config: row.config as Record<string, unknown> });
      grouped.set(row.schemaId, list);
    }
    return grouped;
  }

  private async levelChain(tenantId: string, schemaId: string) {
    const owned = await this.repo.findSchemaById(tenantId, schemaId);

    if (owned === null)
      throw notFound('Location schema');

    const levels = (await this.levelsOf([schemaId])).get(schemaId) ?? [];

    if (levels.length === 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'This schema has no levels defined');

    return levels;
  }

  private async placeFor(access: RequestAccess, input: CreateLocationBody) {
    const { tenantId } = access;
    const parentId = input.parentId ?? null;
    const parent = parentId === null ? null : await this.findNode(tenantId, parentId);

    const schemaId = parent?.schemaId ?? input.schemaId;

    if (schemaId === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'schemaId is required when creating a root location');

    if (parent !== null && input.schemaId !== undefined && input.schemaId !== parent.schemaId)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A child belongs to the same schema as its parent');

    const level = await this.levelUnder(tenantId, {
      schemaId,
      parentCategoryId: parent?.categoryId ?? null,
      wanted: input.categoryId,
    });

    await this.assertMayCreateUnder(access, parent);

    return { parentId, schemaId, categoryId: level.categoryId };
  }

  private async assertMayCreateUnder(access: RequestAccess, parent: { id: string; createdBy: string | null } | null): Promise<void> {
    if (parent === null) {
      if (requireScope(access, PERMISSIONS.LOCATIONS_CREATE) !== 'ALL')
        throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Creating a root location needs an unrestricted grant');

      return;
    }

    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_CREATE, nodeId: parent.id, createdBy: parent.createdBy });
  }

  private async levelUnder(tenantId: string, target: { schemaId: string; parentCategoryId: string | null; wanted: string | undefined }) {
    const levels = await this.levelChain(tenantId, target.schemaId);
    const depth = target.parentCategoryId === null ? 0 : this.depthOf(levels, target.parentCategoryId) + 1;
    const level = levels[depth];

    if (level === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'The schema defines no level below this parent');

    if (target.wanted !== undefined && target.wanted !== level.categoryId)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, `Level ${depth} of this schema is category ${level.categorySlug}`);

    return level;
  }

  private depthOf(levels: SchemaResponse['levels'], categoryId: string): number {
    const level = levels.find(l => l.categoryId === categoryId);

    if (level === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'This location’s category is not part of its schema');

    return level.depth;
  }

  private async findNode(tenantId: string, id: string) {
    const row = await this.repo.findLocationById(tenantId, id);

    if (row === null)
      throw notFound('Location');

    return row;
  }

  private async present(rows: (typeof locationsTable.$inferSelect)[], tx?: Tx): Promise<LocationResponse[]> {
    if (rows.length === 0)
      return [];

    const ids = rows.map(row => row.id);
    const { pathById, aliasById, childrenById } = await this.repo.findPresentationData(ids, tx);

    return rows.map((row) => {
      const path = pathById.get(row.id);

      return {
        id: row.id,
        schemaId: row.schemaId,
        categoryId: row.categoryId,
        parentId: row.parentId,
        name: row.name,
        code: row.code,
        source: row.source,
        status: row.status,
        isActive: row.isActive,
        latitude: row.latitude,
        longitude: row.longitude,
        metadata: row.metadata as Record<string, unknown> | null,
        aliases: aliasById.get(row.id) ?? [],
        depth: path?.depth ?? 0,
        path: path?.path ?? row.name,
        pathIds: path?.pathIds ?? [row.id],
        childCount: childrenById.get(row.id) ?? 0,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private reachCondition(access: RequestAccess, scope: PermissionScope) {
    if (scope === 'OWN')
      return [this.repo.ownedBy(access.userId)];

    const reach = locationScopeFor(access, PERMISSIONS.LOCATIONS_VIEW);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return [];

    if (reach.nodeIds.length === 0)
      return null;

    return [this.repo.withinGrant(reach.nodeIds)];
  }

  private async assertReaches(access: RequestAccess, target: { key: PermissionKey; nodeId: string; createdBy: string | null }): Promise<void> {
    const { key, nodeId, createdBy } = target;
    const scope = requireScope(access, key);

    if (scope === 'OWN') {
      if (createdBy !== access.userId)
        throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');
      return;
    }

    const reach = locationScopeFor(access, key);

    if (reach.kind === 'ALL_TENANT_LOCATIONS')
      return;

    const reaches = await this.repo.checkUnderAnyGrant(nodeId, reach.nodeIds);

    if (!reaches)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');
  }
}
