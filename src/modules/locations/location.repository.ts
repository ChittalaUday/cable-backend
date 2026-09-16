import type { SQL } from 'drizzle-orm';
import type { Database, Transaction } from '@/db/client';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import {
  locationAliases,
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
} from '@/db/schema';

export class LocationRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async listCategories(tenantId: string) {
    return this.db
      .select()
      .from(locationCategories)
      .where(eq(locationCategories.tenantId, tenantId))
      .orderBy(asc(locationCategories.name));
  }

  async findCategoryById(tenantId: string, id: string) {
    const [cat] = await this.db
      .select()
      .from(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)));
    return cat ?? null;
  }

  async createCategory(data: typeof locationCategories.$inferInsert) {
    const [created] = await this.db.insert(locationCategories).values(data).returning();
    return created!;
  }

  async updateCategory(tenantId: string, id: string, data: Partial<typeof locationCategories.$inferInsert>) {
    const [updated] = await this.db
      .update(locationCategories)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)))
      .returning();
    return updated ?? null;
  }

  async deleteCategory(tenantId: string, id: string) {
    return this.db
      .delete(locationCategories)
      .where(and(eq(locationCategories.tenantId, tenantId), eq(locationCategories.id, id)));
  }

  async listSchemas(tenantId: string) {
    return this.db
      .select()
      .from(locationSchemas)
      .where(eq(locationSchemas.tenantId, tenantId))
      .orderBy(asc(locationSchemas.name));
  }

  async findSchemaById(tenantId: string, id: string) {
    const [schema] = await this.db
      .select()
      .from(locationSchemas)
      .where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.id, id)));
    return schema ?? null;
  }

  async findSchemaLevels(schemaId: string) {
    return this.db
      .select()
      .from(locationSchemaLevels)
      .where(eq(locationSchemaLevels.schemaId, schemaId))
      .orderBy(asc(locationSchemaLevels.depth));
  }

  async listLocations(whereConditions: SQL[], limit: number, offset: number) {
    const [rows, [total]] = await Promise.all([
      this.db
        .select()
        .from(locations)
        .where(and(...whereConditions))
        .orderBy(asc(locations.name))
        .limit(limit)
        .offset(offset),
      offset === 0
        ? this.db.select({ count: count() }).from(locations).where(and(...whereConditions))
        : Promise.resolve([{ count: 0 }]),
    ]);

    return { rows, total: total?.count ?? 0 };
  }

  async findLocationById(tenantId: string, id: string) {
    const [loc] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)));
    return loc ?? null;
  }

  async findLocationByCode(tenantId: string, code: string) {
    const [loc] = await this.db
      .select()
      .from(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.code, code)));
    return loc ?? null;
  }

  async countChildren(tenantId: string, locationId: string): Promise<number> {
    const [result] = await this.db
      .select({ count: count() })
      .from(locations)
      .where(and(
        eq(locations.tenantId, tenantId),
        eq(locations.parentId, locationId),
      ));
    return result?.count ?? 0;
  }

  async findAncestors(tenantId: string, path: string) {
    const segments = path.split('.');
    return this.db
      .select()
      .from(locations)
      .where(and(
        eq(locations.tenantId, tenantId),
        inArray(locations.id, segments),
      ));
  }

  async createLocation(data: typeof locations.$inferInsert, tx?: Transaction) {
    const client = tx ?? this.db;
    const [created] = await client.insert(locations).values(data).returning();
    return created!;
  }

  async updateLocation(tenantId: string, id: string, data: Partial<typeof locations.$inferInsert>, tx?: Transaction) {
    const client = tx ?? this.db;
    const [updated] = await client
      .update(locations)
      .set({ ...data, updatedAt: new Date() })
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)))
      .returning();
    return updated ?? null;
  }

  async deleteLocation(tenantId: string, id: string, tx?: Transaction) {
    const client = tx ?? this.db;
    return client
      .delete(locations)
      .where(and(eq(locations.tenantId, tenantId), eq(locations.id, id)));
  }

  async findAliases(tenantId: string, locationId: string) {
    return this.db
      .select()
      .from(locationAliases)
      .where(and(eq(locationAliases.tenantId, tenantId), eq(locationAliases.locationId, locationId)));
  }
}
