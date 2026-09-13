import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
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
} from './locations.schema';
import type * as schema from '@/db/schema';
import type { AccessContext, RequestAccess } from '@/modules/iam/access.service';
import type { Page, PaginationQuery } from '@/shared/pagination';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  locationAliases,
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
} from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { grantedNodes, scopeFor } from '@/modules/iam/access.service';
import { ERROR_CODES, isForeignKeyViolation, isUniqueViolation } from '@/shared/errors';
import { badRequest, conflict, forbidden, inUse, notFound } from '@/shared/errors/domain-error';
import { offsetOf } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import { countGenerated, expandLevel, NO_PARENT } from './locations.generate';

type Db = NodePgDatabase<typeof schema>;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

const MAX_GENERATED_NODES = 2000;

function provenance(access: AccessContext, status: 'pending' | 'approved' | undefined) {
  const configures = access.permissions.has(PERMISSIONS.LOCATIONS_CONFIGURE);

  return {
    source: configures ? ('admin' as const) : ('user' as const),
    status: configures ? (status ?? 'approved') : ('pending' as const),
  };
}

function coordinates(input: { latitude?: number | null; longitude?: number | null }) {
  return {
    ...(input.latitude === undefined ? {} : { latitude: input.latitude === null ? null : String(input.latitude) }),
    ...(input.longitude === undefined ? {} : { longitude: input.longitude === null ? null : String(input.longitude) }),
  };
}

interface PathRow extends Record<string, unknown> { id: string; depth: number; path: string; pathIds: string[] }

export class LocationsService {
  constructor(private readonly db: Db) {}

  async listCategories({ tenantId }: RequestAccess): Promise<CategoryResponse[]> {
    const rows = await this.db
      .select()
      .from(locationCategories)
      .where(eq(locationCategories.tenantId, tenantId))
      .orderBy(asc(locationCategories.name));

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
      const [row] = await this.db
        .insert(locationCategories)
        .values({ tenantId, name: input.name, slug: input.slug, config: input.config ?? {} })
        .returning();

      const created = this.categoryOf(row!);
      await audit.created(this.db, context, { entityType: 'location_category', entityId: created.id, after: created });

      return created;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict(`A category with slug "${input.slug}" already exists`);
      throw error;
    }
  }

  async updateCategory({ tenantId, audit: context }: RequestAccess, id: string, patch: UpdateCategoryBody): Promise<CategoryResponse> {
    const [existing] = await this.db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)))
      .limit(1);

    const [row] = await this.db
      .update(locationCategories)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)))
      .returning();

    if (row === undefined)
      throw notFound('Category');

    const after = this.categoryOf(row);
    await audit.updated(this.db, context, {
      entityType: 'location_category',
      entityId: id,
      before: this.categoryOf(existing!),
      after,
    });

    return after;
  }

  async deleteCategory({ tenantId, audit: context }: RequestAccess, id: string): Promise<void> {
    const [existing] = await this.db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)))
      .limit(1);

    try {
      await this.db
        .delete(locationCategories)
        .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)));
    }
    catch (error) {
      if (isForeignKeyViolation(error))
        throw inUse('This category is still used by a schema level or a location');
      throw error;
    }

    // A delete of something that was not there is not a change to record.
    if (existing !== undefined)
      await audit.deleted(this.db, context, { entityType: 'location_category', entityId: id, before: this.categoryOf(existing) });
  }

  async listSchemas({ tenantId }: RequestAccess): Promise<SchemaResponse[]> {
    const rows = await this.db
      .select()
      .from(locationSchemas)
      .where(eq(locationSchemas.tenantId, tenantId))
      .orderBy(asc(locationSchemas.name));

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

    const known = await this.db
      .select({ id: locationCategories.id })
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), inArray(locationCategories.id, categoryIds)));

    if (known.length !== categoryIds.length)
      throw notFound('Category');

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(locationSchemas)
        .values({
          tenantId,
          name: input.name,
          slug: input.slug,
          description: input.description ?? null,
        })
        .returning({ id: locationSchemas.id });

      await tx.insert(locationSchemaLevels).values(input.levels.map((level, depth) => ({
        schemaId: row!.id,
        categoryId: level.categoryId,
        depth,
        isTerminal: level.isTerminal ?? depth === input.levels.length - 1,
        config: level.config ?? {},
      })));

      return row!.id;
    }).catch((error: unknown) => {
      if (isUniqueViolation(error))
        throw conflict(`A schema with slug "${input.slug}" already exists`);
      throw error;
    });

    const [created] = await this.listSchemasById(access, [id]);
    await audit.created(this.db, access.audit, { entityType: 'location_schema', entityId: id, after: created! });

    return created!;
  }

  async updateSchema(access: RequestAccess, id: string, patch: UpdateSchemaBody): Promise<SchemaResponse> {
    const { tenantId } = access;
    const [before] = await this.listSchemasById(access, [id]);
    const [row] = await this.db
      .update(locationSchemas)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id)))
      .returning({ id: locationSchemas.id });

    if (row === undefined)
      throw notFound('Location schema');

    const [updated] = await this.listSchemasById(access, [id]);
    await audit.updated(this.db, access.audit, { entityType: 'location_schema', entityId: id, before: before!, after: updated! });

    return updated!;
  }

  async deleteSchema(access: RequestAccess, id: string): Promise<void> {
    const { tenantId } = access;
    const [before] = await this.listSchemasById(access, [id]);

    try {
      await this.db
        .delete(locationSchemas)
        .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id)));
    }
    catch (error) {
      if (isForeignKeyViolation(error))
        throw inUse('This schema still has locations; delete or move them first');
      throw error;
    }

    if (before !== undefined)
      await audit.deleted(this.db, access.audit, { entityType: 'location_schema', entityId: id, before });
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

    return this.db.transaction(async (tx) => {
      let parents = parentId === null
        ? [NO_PARENT]
        : [await this.parentSeed(tx, parentId)];
      let parentIds: (string | null)[] = [parentId];
      let created = 0;
      let leafIds: string[] = [];

      for (const [offset, level] of input.levels.entries()) {
        const expanded = expandLevel(parents, level);
        const categoryId = levels[startDepth + offset]!.categoryId;

        const inserted = await tx
          .insert(locations)
          .values(expanded.map(node => ({
            tenantId,
            schemaId,
            categoryId,
            parentId: parentIds[node.parentIndex] ?? null,
            name: node.name,
            code: node.code,
            source: 'admin' as const,
            createdBy: access.userId,
          })))
          .returning({ id: locations.id, name: locations.name, code: locations.code });

        created += inserted.length;
        leafIds = inserted.map(row => row.id);
        parents = inserted.map(row => ({ name: row.name, code: row.code }));
        parentIds = inserted.map(row => row.id);
      }

      // One summary row, not one per node: a 2000-node generate would otherwise
      // bury every other change in the tenant's audit trail. Inside the
      // transaction, so the log cannot survive a rolled-back generate.
      await audit.log(tx, access.audit, {
        action: 'location.generated',
        entityType: 'location_schema',
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
    const scope = this.scopeOf(access, PERMISSIONS.LOCATIONS_VIEW);
    const reach = this.reachCondition(access, scope);

    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters = [eq(locations.tenantId, tenantId), ...reach];

    if (query.parentId !== undefined) {
      filters.push(query.parentId === 'null'
        ? isNull(locations.parentId)
        : eq(locations.parentId, query.parentId));
    }
    if (query.ancestorId !== undefined)
      filters.push(sql`EXISTS (SELECT 1 FROM geo.location_descendants(${query.ancestorId}) d WHERE d.id = ${locations.id} AND d.id <> ${query.ancestorId})`);
    if (query.schemaId !== undefined)
      filters.push(eq(locations.schemaId, query.schemaId));
    if (query.categoryId !== undefined)
      filters.push(eq(locations.categoryId, query.categoryId));
    if (query.status !== undefined)
      filters.push(eq(locations.status, query.status));
    if (query.isActive !== undefined)
      filters.push(eq(locations.isActive, query.isActive));
    if (query.q !== undefined) {
      filters.push(sql`(${locations.name} ILIKE ${`%${query.q}%`} OR EXISTS (
        SELECT 1 FROM geo.location_aliases a WHERE a.location_id = ${locations.id} AND a.alias ILIKE ${`%${query.q}%`}
      ))`);
    }

    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(locations)
        .where(where)
        .orderBy(asc(locations.name))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      this.db.select({ total: count() }).from(locations).where(where),
    ]);

    return {
      items: await this.present(rows),
      total: totals?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
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
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(locations)
          .values({
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
          })
          .returning();

        await this.replaceAliases(tx, { tenantId, locationId: row!.id, aliases: input.aliases });

        const [presented] = await this.present([row!], tx);
        await audit.created(tx, access.audit, { entityType: 'location', entityId: row!.id, after: presented! });

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
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .update(locations)
          .set({ ...rest, ...coordinates(patch), updatedAt: new Date() })
          .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)))
          .returning();

        await this.replaceAliases(tx, { tenantId, locationId: id, aliases });

        const [presented] = await this.present([row!], tx);
        await audit.updated(tx, access.audit, { entityType: 'location', entityId: id, before: before!, after: presented! });

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
    const existing = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)))
      .limit(1);

    if (existing[0] === undefined)
      return;

    await this.assertReaches(access, { key: PERMISSIONS.LOCATIONS_DELETE, nodeId: id, createdBy: existing[0].createdBy });

    const [before] = await this.present([existing[0]]);

    try {
      await this.db.delete(locations).where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)));
    }
    catch (error) {
      if (isForeignKeyViolation(error))
        throw inUse('This location still has children or customers assigned to it');
      throw error;
    }

    await audit.deleted(this.db, access.audit, { entityType: 'location', entityId: id, before: before! });
  }

  /**
   * Confirms every id is a location of this tenant, for another module that
   * needs to point at the tree (AGENTS.md §3).
   *
   * `crm.service_coverage` has a foreign key to `geo.locations`, but a foreign
   * key cannot see tenants: without this, one tenant could aim coverage at
   * another tenant's building.
   */
  async assertOwned({ tenantId }: RequestAccess, ids: readonly string[]): Promise<void> {
    if (ids.length === 0)
      return;

    const wanted = [...new Set(ids)];
    const rows = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, wanted)));

    if (rows.length !== wanted.length)
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
    const rows = await this.db
      .select({
        id: locationSchemaLevels.id,
        schemaId: locationSchemaLevels.schemaId,
        categoryId: locationSchemaLevels.categoryId,
        categorySlug: locationCategories.slug,
        categoryName: locationCategories.name,
        depth: locationSchemaLevels.depth,
        isTerminal: locationSchemaLevels.isTerminal,
        config: locationSchemaLevels.config,
      })
      .from(locationSchemaLevels)
      .innerJoin(locationCategories, eq(locationCategories.id, locationSchemaLevels.categoryId))
      .where(inArray(locationSchemaLevels.schemaId, schemaIds))
      .orderBy(asc(locationSchemaLevels.depth));

    const grouped = new Map<string, SchemaResponse['levels']>();
    for (const row of rows) {
      const list = grouped.get(row.schemaId) ?? [];
      list.push({ ...row, config: row.config as Record<string, unknown> });
      grouped.set(row.schemaId, list);
    }
    return grouped;
  }

  private async levelChain(tenantId: string, schemaId: string) {
    const [owned] = await this.db
      .select({ id: locationSchemas.id })
      .from(locationSchemas)
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, schemaId)))
      .limit(1);

    if (owned === undefined)
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
      if (this.scopeOf(access, PERMISSIONS.LOCATIONS_CREATE) !== 'ALL')
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
    const [row] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)))
      .limit(1);

    if (row === undefined)
      throw notFound('Location');

    return row;
  }

  private async parentSeed(tx: Tx, id: string) {
    const [row] = await tx
      .select({ name: locations.name, code: locations.code })
      .from(locations)
      .where(eq(locations.id, id))
      .limit(1);

    return row!;
  }

  private async replaceAliases(tx: Tx, input: { tenantId: string; locationId: string; aliases: string[] | undefined }): Promise<void> {
    const { tenantId, locationId, aliases } = input;

    if (aliases === undefined)
      return;

    await tx.delete(locationAliases).where(eq(locationAliases.locationId, locationId));

    if (aliases.length > 0) {
      await tx.insert(locationAliases).values(
        [...new Set(aliases)].map(alias => ({ tenantId, locationId, alias })),
      );
    }
  }

  private async present(rows: (typeof locations.$inferSelect)[], tx?: Tx): Promise<LocationResponse[]> {
    if (rows.length === 0)
      return [];

    const db = tx ?? this.db;
    const ids = rows.map(row => row.id);

    const [paths, aliasRows] = await Promise.all([
      db.execute<PathRow>(sql`
        SELECT n.id,
               count(*)::int - 1                                   AS depth,
               string_agg(l.name, ' / ' ORDER BY a.depth DESC)     AS path,
               array_agg(l.id ORDER BY a.depth DESC)               AS "pathIds"
        FROM unnest(${sql.param(ids)}::uuid[]) AS n(id)
        CROSS JOIN geo.location_ancestors(n.id) AS a
        JOIN geo.locations l ON l.id = a.id
        GROUP BY n.id
      `),
      db.select({ locationId: locationAliases.locationId, alias: locationAliases.alias })
        .from(locationAliases)
        .where(inArray(locationAliases.locationId, ids)),
    ]);

    const pathById = new Map(paths.rows.map(row => [row.id, row]));
    const aliasById = new Map<string, string[]>();
    for (const row of aliasRows)
      aliasById.set(row.locationId, [...(aliasById.get(row.locationId) ?? []), row.alias]);

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
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });
  }

  private scopeOf(access: RequestAccess, key: PermissionKey): PermissionScope {
    const scope = scopeFor(access, key);

    if (scope === null)
      throw forbidden(ERROR_CODES.PERM_DENIED, `Missing permission: ${key}`);

    return scope;
  }

  private reachCondition(access: RequestAccess, scope: PermissionScope) {
    if (scope === 'ALL')
      return [];

    if (scope === 'OWN')
      return [eq(locations.createdBy, access.userId)];

    const granted = grantedNodes(access, scope);

    if (granted.length === 0)
      return null;

    return [sql`EXISTS (
      SELECT 1 FROM unnest(${sql.param(granted)}::uuid[]) AS g(id), geo.location_descendants(g.id) AS d
      WHERE d.id = ${locations.id}
    )`];
  }

  private async assertReaches(access: RequestAccess, target: { key: PermissionKey; nodeId: string; createdBy: string | null }): Promise<void> {
    const { key, nodeId, createdBy } = target;
    const scope = this.scopeOf(access, key);

    if (scope === 'ALL')
      return;

    if (scope === 'OWN') {
      if (createdBy !== access.userId)
        throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');
      return;
    }

    const granted = grantedNodes(access, scope);

    if (granted.length === 0)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');

    const result = await this.db.execute(sql`
      SELECT 1 FROM geo.location_ancestors(${nodeId}) AS a
      WHERE a.id = ANY(${sql.param(granted)}::uuid[])
      LIMIT 1
    `);

    if (result.rows.length === 0)
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'This location is outside your grant');
  }
}
