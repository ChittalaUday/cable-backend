import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  locationAliases,
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
  membershipLocations,
  subscriptions,
  teamLocations,
  teamMemberLocations,
  teams,
  tenantMemberships,
} from '@/db/schema';
import { underAnyGrant, withinGrantedSubtree } from '@/security/location-scope';

export interface PathRow extends Record<string, unknown> {
  id: string;
  depth: number;
  path: string;
  pathIds: string[];
}

export class LocationRepository {
  constructor(private readonly db: Database) {}

  /**
   * Every read below is scoped to live rows. `geo.locations`,
   * `geo.location_categories` and `geo.location_schemas` are soft-deleted, and
   * the recursive walks in `geo.location_ancestors` / `location_descendants`
   * already stop at a deleted node — so a query that forgets `deleted_at` here
   * would hand back a node the tree itself no longer contains.
   */

  get database(): Database {
    return this.db;
  }

  async transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(fn);
  }

  // --- Categories ---

  async listCategories(tenantId: string) {
    return this.db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), isNull(locationCategories.deletedAt)))
      .orderBy(asc(locationCategories.name));
  }

  async findCategoryById(tenantId: string, id: string) {
    const [cat] = await this.db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id), isNull(locationCategories.deletedAt)))
      .limit(1);
    return cat ?? null;
  }

  async findCategoriesByIds(tenantId: string, ids: string[]) {
    if (ids.length === 0)
      return [];

    return this.db
      .select({ id: locationCategories.id })
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), inArray(locationCategories.id, ids), isNull(locationCategories.deletedAt)));
  }

  async createCategory(data: typeof locationCategories.$inferInsert) {
    const [created] = await this.db.insert(locationCategories).values(data).returning();
    return created!;
  }

  async updateCategory(tenantId: string, id: string, data: Partial<typeof locationCategories.$inferInsert>) {
    const [updated] = await this.db
      .update(locationCategories)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id), isNull(locationCategories.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async isCategoryInUse(tenantId: string, categoryId: string): Promise<boolean> {
    const [level] = await this.db
      .select({ id: locationSchemaLevels.id })
      .from(locationSchemaLevels)
      .innerJoin(locationSchemas, eq(locationSchemas.id, locationSchemaLevels.schemaId))
      .where(and(
        eq(locationSchemas.tenantId, tenantId),
        eq(locationSchemaLevels.categoryId, categoryId),
        isNull(locationSchemas.deletedAt),
      ))
      .limit(1);

    if (level !== undefined)
      return true;

    const [location] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.categoryId, categoryId), isNull(locations.deletedAt)))
      .limit(1);

    return location !== undefined;
  }

  async softDeleteCategory(tenantId: string, id: string) {
    return this.db
      .update(locationCategories)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id), isNull(locationCategories.deletedAt)));
  }

  // --- Schemas & Levels ---

  async listSchemas(tenantId: string) {
    return this.db
      .select()
      .from(locationSchemas)
      .where(and(eq(locationSchemas.tenantId, tenantId), isNull(locationSchemas.deletedAt)))
      .orderBy(asc(locationSchemas.name));
  }

  async findSchemaById(tenantId: string, id: string) {
    const [schema] = await this.db
      .select()
      .from(locationSchemas)
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id), isNull(locationSchemas.deletedAt)))
      .limit(1);
    return schema ?? null;
  }

  async findSchemaLevels(schemaId: string) {
    return this.db
      .select()
      .from(locationSchemaLevels)
      .where(eq(locationSchemaLevels.schemaId, schemaId))
      .orderBy(asc(locationSchemaLevels.depth));
  }

  async findSchemaLevelsWithCategories(schemaIds: string[]) {
    if (schemaIds.length === 0)
      return [];

    return this.db
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
  }

  async createSchemaWithLevels(
    tenantId: string,
    schema: { name: string; slug: string; description?: string | null },
    levels: { categoryId: string; depth: number; isTerminal: boolean; config?: Record<string, unknown> }[],
  ): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(locationSchemas)
        .values({
          tenantId,
          name: schema.name,
          slug: schema.slug,
          description: schema.description ?? null,
        })
        .returning({ id: locationSchemas.id });

      if (levels.length > 0) {
        await tx.insert(locationSchemaLevels).values(levels.map(level => ({
          schemaId: row!.id,
          categoryId: level.categoryId,
          depth: level.depth,
          isTerminal: level.isTerminal,
          config: level.config ?? {},
        })));
      }

      return row!.id;
    });
  }

  async updateSchema(tenantId: string, id: string, patch: Partial<typeof locationSchemas.$inferInsert>) {
    const [row] = await this.db
      .update(locationSchemas)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id), isNull(locationSchemas.deletedAt)))
      .returning({ id: locationSchemas.id });
    return row ?? null;
  }

  async softDeleteSchema(tenantId: string, id: string) {
    return this.db
      .update(locationSchemas)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id), isNull(locationSchemas.deletedAt)));
  }

  async schemaHasLocations(tenantId: string, schemaId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.schemaId, schemaId), isNull(locations.deletedAt)))
      .limit(1);

    return row !== undefined;
  }

  // --- Locations CRUD & Tree ---

  /** Every location read starts here: this tenant's live nodes and nothing else. */
  liveIn(tenantId: string): SQL {
    return and(eq(locations.tenantId, tenantId), isNull(locations.deletedAt))!;
  }

  ownedBy(userId: string): SQL {
    return eq(locations.createdBy, userId);
  }

  withinGrant(nodeIds: readonly string[]): SQL {
    return withinGrantedSubtree(sql`${locations.id}`, nodeIds);
  }

  underAncestor(ancestorId: string): SQL {
    return sql`EXISTS (
      SELECT 1 FROM geo.location_descendants(${ancestorId}) d
      WHERE d.id = ${locations.id} AND d.id <> ${ancestorId}
    )`;
  }

  nameOrAliasMatches(term: string): SQL {
    const pattern = `%${term}%`;
    return sql`(${locations.name} ILIKE ${pattern} OR EXISTS (
      SELECT 1 FROM geo.location_aliases a
      WHERE a.location_id = ${locations.id} AND a.alias ILIKE ${pattern}
    ))`;
  }

  coveredBy(tenantId: string, serviceId: string, providerId: string | null): SQL {
    return sql`crm.coverage_allows(
      ${tenantId}, ${serviceId}, ${providerId}, NULL, ${locations.id}
    )`;
  }

  matchesParent(parentId: string | null): SQL {
    return parentId === null ? isNull(locations.parentId) : eq(locations.parentId, parentId);
  }

  matchesSchema(schemaId: string): SQL {
    return eq(locations.schemaId, schemaId);
  }

  matchesCategory(categoryId: string): SQL {
    return eq(locations.categoryId, categoryId);
  }

  matchesStatus(status: typeof locations.status.enumValues[number]): SQL {
    return eq(locations.status, status);
  }

  matchesActive(isActive: boolean): SQL {
    return eq(locations.isActive, isActive);
  }

  async listLocations(where: SQL, limit: number, offset: number) {
    const [rows, [totals]] = await Promise.all([
      this.db
        .select()
        .from(locations)
        .where(where)
        .orderBy(asc(locations.name), asc(locations.id))
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(locations).where(where),
    ]);

    return { rows, total: totals?.total ?? 0 };
  }

  async findLocationById(tenantId: string, id: string) {
    const [loc] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id), isNull(locations.deletedAt)))
      .limit(1);
    return loc ?? null;
  }

  async findLocationByCode(tenantId: string, code: string) {
    const [loc] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.code, code), isNull(locations.deletedAt)))
      .limit(1);
    return loc ?? null;
  }

  async findLocationsByIds(tenantId: string, ids: string[]) {
    if (ids.length === 0)
      return [];

    return this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, ids), isNull(locations.deletedAt)));
  }

  async findOwnedLocationIds(tenantId: string, ids: string[]): Promise<string[]> {
    if (ids.length === 0)
      return [];

    const rows = await this.db
      .select({ id: locations.id })
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), inArray(locations.id, ids), isNull(locations.deletedAt)));
    return rows.map(r => r.id);
  }

  async findAncestorIds(id: string): Promise<string[]> {
    const chain = await this.db.execute<{ id: string }>(sql`
      SELECT a.id
      FROM geo.location_ancestors(${id}) a
      ORDER BY a.depth DESC
    `);
    return chain.rows.map(row => row.id);
  }

  async findSiblingRanks(ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0)
      return new Map();

    const ranks = await this.db.execute<{ id: string; siblingIndex: number }>(sql`
      SELECT l.id,
             (SELECT count(*)::int
                FROM geo.locations s
               WHERE s.tenant_id = l.tenant_id
                 AND s.parent_id IS NOT DISTINCT FROM l.parent_id
                 AND s.deleted_at IS NULL
                 AND (s.name, s.id) < (l.name, l.id)) AS "siblingIndex"
      FROM geo.locations l
      WHERE l.id = ANY(${sql.param(ids)}::uuid[]) AND l.deleted_at IS NULL
    `);

    return new Map(ranks.rows.map(row => [row.id, row.siblingIndex]));
  }

  async parentSeed(id: string, tx?: Transaction | Database) {
    const client = tx ?? this.db;
    const [row] = await client
      .select({ name: locations.name, code: locations.code })
      .from(locations)
      .where(and(eq(locations.id, id), isNull(locations.deletedAt)))
      .limit(1);
    return row!;
  }

  async createLocation(data: typeof locations.$inferInsert, tx?: Transaction | Database) {
    const client = tx ?? this.db;
    const [created] = await client.insert(locations).values(data).returning();
    return created!;
  }

  async batchCreateLocations(nodes: (typeof locations.$inferInsert)[], tx?: Transaction | Database) {
    const client = tx ?? this.db;
    return client
      .insert(locations)
      .values(nodes)
      .returning({ id: locations.id, name: locations.name, code: locations.code });
  }

  async updateLocation(tenantId: string, id: string, data: Partial<typeof locations.$inferInsert>, tx?: Transaction | Database) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(locations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id), isNull(locations.deletedAt)))
      .returning();
    return updated ?? null;
  }

  async softDeleteLocation(tenantId: string, id: string, tx?: Transaction | Database) {
    const client = tx ?? this.db;
    return client
      .update(locations)
      .set({ deletedAt: new Date(), isActive: false, updatedAt: new Date() })
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id), isNull(locations.deletedAt)));
  }

  async countChildren(tenantId: string, locationId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: count() })
      .from(locations)
      .where(and(
        eq(locations.tenantId, tenantId),
        eq(locations.parentId, locationId),
        isNull(locations.deletedAt),
      ));
    return result?.count ?? 0;
  }

  async isLocationAssigned(tenantId: string, id: string): Promise<boolean> {
    const [staffMem] = await this.db
      .select({ id: membershipLocations.membershipId })
      .from(membershipLocations)
      .innerJoin(tenantMemberships, eq(tenantMemberships.id, membershipLocations.membershipId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(membershipLocations.locationId, id)))
      .limit(1);
    if (staffMem !== undefined)
      return true;

    const [teamLoc] = await this.db
      .select({ id: teamLocations.teamId })
      .from(teamLocations)
      .innerJoin(teams, eq(teams.id, teamLocations.teamId))
      .where(and(eq(teams.tenantId, tenantId), eq(teamLocations.locationId, id)))
      .limit(1);
    if (teamLoc !== undefined)
      return true;

    const [teamMemLoc] = await this.db
      .select({ id: teamMemberLocations.membershipId })
      .from(teamMemberLocations)
      .innerJoin(tenantMemberships, eq(tenantMemberships.id, teamMemberLocations.membershipId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(teamMemberLocations.locationId, id)))
      .limit(1);
    if (teamMemLoc !== undefined)
      return true;

    const [sub] = await this.db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(
        eq(subscriptions.tenantId, tenantId),
        eq(subscriptions.installationLocationId, id),
        isNull(subscriptions.deletedAt),
      ))
      .limit(1);
    if (sub !== undefined)
      return true;

    return false;
  }

  // --- Aliases ---

  async findAliases(tenantId: string, locationId: string) {
    return this.db
      .select()
      .from(locationAliases)
      .where(and(eq(locationAliases.tenantId, tenantId), eq(locationAliases.locationId, locationId)));
  }

  async replaceAliases(
    tenantId: string,
    locationId: string,
    aliases: string[] | undefined,
    tx?: Transaction | Database,
  ): Promise<void> {
    if (aliases === undefined)
      return;

    const client = tx ?? this.db;
    await client
      .delete(locationAliases)
      .where(and(eq(locationAliases.tenantId, tenantId), eq(locationAliases.locationId, locationId)));

    if (aliases.length > 0) {
      await client.insert(locationAliases).values(
        [...new Set(aliases)].map(alias => ({ tenantId, locationId, alias })),
      );
    }
  }

  // --- Presentation Data ---

  async findPresentationData(ids: string[], tx?: Transaction | Database) {
    if (ids.length === 0) {
      return {
        pathById: new Map<string, PathRow>(),
        aliasById: new Map<string, string[]>(),
        childrenById: new Map<string, number>(),
      };
    }

    const client = tx ?? this.db;
    const [paths, aliasRows, childRows] = await Promise.all([
      client.execute<PathRow>(sql`
        SELECT n.id,
               count(*)::int - 1                                   AS depth,
               string_agg(l.name, ' / ' ORDER BY a.depth DESC)     AS path,
               array_agg(l.id ORDER BY a.depth DESC)               AS "pathIds"
        FROM unnest(${sql.param(ids)}::uuid[]) AS n(id)
        CROSS JOIN geo.location_ancestors(n.id) AS a
        JOIN geo.locations l ON l.id = a.id AND l.deleted_at IS NULL
        GROUP BY n.id
      `),
      client.select({ locationId: locationAliases.locationId, alias: locationAliases.alias })
        .from(locationAliases)
        .where(inArray(locationAliases.locationId, ids)),
      client.select({ parentId: locations.parentId, children: count() })
        .from(locations)
        .where(and(inArray(locations.parentId, ids), isNull(locations.deletedAt)))
        .groupBy(locations.parentId),
    ]);

    const pathById = new Map(paths.rows.map(row => [row.id, row]));
    const aliasById = new Map<string, string[]>();
    for (const row of aliasRows)
      aliasById.set(row.locationId, [...(aliasById.get(row.locationId) ?? []), row.alias]);
    const childrenById = new Map(childRows.map(row => [row.parentId, row.children]));

    return { pathById, aliasById, childrenById };
  }

  // --- Reach & Scope Checks ---

  async findOutsideGrants(ids: string[], nodeIds: readonly string[]): Promise<{ id: string }[]> {
    const outside = await this.db.execute<{ id: string }>(sql`
      SELECT w.id
      FROM unnest(${sql.param([...new Set(ids)])}::uuid[]) AS w(id)
      WHERE NOT ${underAnyGrant(sql`w.id`, nodeIds)}
      LIMIT 1
    `);
    return outside.rows;
  }

  async checkUnderAnyGrant(nodeId: string, nodeIds: readonly string[]): Promise<boolean> {
    const result = await this.db.execute<{ reaches: boolean }>(
      sql`SELECT ${underAnyGrant(nodeId, nodeIds)} AS reaches`,
    );
    return result.rows[0]?.reaches === true;
  }
}
