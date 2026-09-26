import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  equipment,
  locationAliases,
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
  subscriptions,
} from '@/db/schema';

type Db = NodePgDatabase<typeof schema>;

export const TIDCO_SCHEMA_SLUG = 'tidco-apartments';
export const STREET_SCHEMA_SLUG = 'street-address';
export const TIDCO_TOWN = 'Mandapeta';
export const TIDCO_BUILDING = 'TIDCO Apartments';

export const TIDCO_LEVELS = ['area', 'building', 'group', 'apartment', 'floor', 'door'] as const;

const CATEGORIES = [
  { name: 'Area', slug: 'area' },
  { name: 'Street', slug: 'street' },
  { name: 'Building', slug: 'building' },
  { name: 'Group', slug: 'group' },
  { name: 'Apartment', slug: 'apartment' },
  { name: 'Floor', slug: 'floor' },
  { name: 'Door', slug: 'door' },
];

const STREET_AREAS: Record<string, string[]> = {
  Angara: ['Main Road'],
  Kapileswaram: ['Main Road', 'Brahmam Gari Veedhi', 'Challa Vari Veedhi'],
};

export async function seedLocations(db: Db, tenantId: string): Promise<void> {
  const categoryMap = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const [row] = await db
      .insert(locationCategories)
      .values({ tenantId, name: cat.name, slug: cat.slug, config: {} })
      .onConflictDoUpdate({
        target: [locationCategories.tenantId, locationCategories.slug],
        targetWhere: sql`deleted_at IS NULL`,
        set: { name: cat.name, updatedAt: new Date() },
      })
      .returning({ id: locationCategories.id, slug: locationCategories.slug });
    categoryMap.set(row!.slug, row!.id);
  }

  async function upsertSchema(input: { name: string; slug: string; description: string; levels: readonly string[] }) {
    const [row] = await db
      .insert(locationSchemas)
      .values({ tenantId, name: input.name, slug: input.slug, description: input.description, isActive: true })
      .onConflictDoUpdate({
        target: [locationSchemas.tenantId, locationSchemas.slug],
        targetWhere: sql`deleted_at IS NULL`,
        set: { name: input.name, description: input.description, updatedAt: new Date() },
      })
      .returning({ id: locationSchemas.id });

    await db.delete(locationSchemaLevels).where(eq(locationSchemaLevels.schemaId, row!.id));
    await db.insert(locationSchemaLevels).values(input.levels.map((slug, depth) => ({
      schemaId: row!.id,
      categoryId: categoryMap.get(slug)!,
      depth,
      isTerminal: depth === input.levels.length - 1,
    })));

    return row!.id;
  }

  const streetSchemaId = await upsertSchema({
    name: 'Street Address',
    slug: STREET_SCHEMA_SLUG,
    description: 'Village and street, for everyone outside the TIDCO complex',
    levels: ['area', 'street'],
  });

  const tidcoSchemaId = await upsertSchema({
    name: 'TIDCO Apartments',
    slug: TIDCO_SCHEMA_SLUG,
    description: 'Mandapeta → TIDCO Apartments → group → apartment → floor → door',
    levels: TIDCO_LEVELS,
  });

  async function upsertNode(data: {
    schemaId: string;
    categoryId: string;
    parentId: string | null;
    name: string;
    code?: string | null;
  }): Promise<string> {
    const [existing] = await db
      .select({ id: locations.id })
      .from(locations)
      .where(and(
        eq(locations.tenantId, tenantId),
        data.parentId !== null ? eq(locations.parentId, data.parentId) : isNull(locations.parentId),
        eq(locations.name, data.name),
      ));

    if (existing !== undefined) {
      await db
        .update(locations)
        .set({ schemaId: data.schemaId, categoryId: data.categoryId, code: data.code ?? null, updatedAt: new Date() })
        .where(eq(locations.id, existing.id));
      return existing.id;
    }

    const [created] = await db
      .insert(locations)
      .values({
        tenantId,
        schemaId: data.schemaId,
        categoryId: data.categoryId,
        parentId: data.parentId,
        name: data.name,
        code: data.code ?? null,
        source: 'admin',
        status: 'approved',
        isActive: true,
      })
      .returning({ id: locations.id });

    return created!.id;
  }

  for (const [areaName, streets] of Object.entries(STREET_AREAS)) {
    const areaId = await upsertNode({
      schemaId: streetSchemaId,
      categoryId: categoryMap.get('area')!,
      parentId: null,
      name: areaName,
      code: areaName.slice(0, 3).toUpperCase(),
    });

    if (areaName === 'Kapileswaram') {
      await db
        .insert(locationAliases)
        .values([
          { tenantId, locationId: areaId, alias: 'Kapileswarapuram', source: 'admin' },
          { tenantId, locationId: areaId, alias: 'K.P. Puram', source: 'admin' },
        ])
        .onConflictDoNothing();
    }

    for (const streetName of streets) {
      await upsertNode({
        schemaId: streetSchemaId,
        categoryId: categoryMap.get('street')!,
        parentId: areaId,
        name: streetName,
      });
    }
  }

  const mandapetaId = await upsertNode({
    schemaId: tidcoSchemaId,
    categoryId: categoryMap.get('area')!,
    parentId: null,
    name: TIDCO_TOWN,
    code: 'MDP',
  });

  const buildingId = await upsertNode({
    schemaId: tidcoSchemaId,
    categoryId: categoryMap.get('building')!,
    parentId: mandapetaId,
    name: TIDCO_BUILDING,
    code: 'TIDCO',
  });

  await dropStaleNodes({ db, tenantId, mandapetaId, buildingId });

  console.log(`✅ Seeded location categories, two schemas, ${Object.keys(STREET_AREAS).length} village areas, and the Mandapeta / TIDCO Apartments root`);
}

async function dropStaleNodes(input: {
  db: Db;
  tenantId: string;
  mandapetaId: string;
  buildingId: string;
}): Promise<void> {
  const { db, tenantId, mandapetaId, buildingId } = input;
  const [kapileswaram] = await db
    .select({ id: locations.id })
    .from(locations)
    .where(and(eq(locations.tenantId, tenantId), isNull(locations.parentId), eq(locations.name, 'Kapileswaram')))
    .limit(1);

  const stale = await db.execute<{ id: string; root_name: string }>(sql`
    SELECT l.id, s.slug as root_name
    FROM geo.locations l
    JOIN geo.location_schemas s ON s.id = l.schema_id
    WHERE l.tenant_id = ${tenantId} AND s.slug = 'gated-apartment'
    UNION
    SELECT l.id, 'Mandapeta' as root_name
    FROM geo.locations l
    JOIN geo.location_categories c ON c.id = l.category_id
    WHERE l.tenant_id = ${tenantId} AND l.parent_id = ${mandapetaId} AND c.slug = 'street'
    UNION
    SELECT d.id, root.name as root_name
    FROM geo.locations root
    JOIN geo.location_descendants(root.id) d ON true
    WHERE root.tenant_id = ${tenantId}
      AND root.parent_id IS NULL
      AND root.name NOT IN ('Mandapeta', 'Angara', 'Kapileswaram', 'Central Warehouse', 'KPHB Branch')
  `);

  const rows = stale.rows;
  if (rows.length === 0)
    return;

  const ids = rows.map(r => r.id);
  const kapileswarapuramIds = rows.filter(r => r.root_name === 'Kapileswarapuram').map(r => r.id);
  const otherStaleIds = rows.filter(r => r.root_name !== 'Kapileswarapuram').map(r => r.id);

  if (kapileswarapuramIds.length > 0 && kapileswaram) {
    await db
      .update(subscriptions)
      .set({ installationLocationId: kapileswaram.id })
      .where(and(eq(subscriptions.tenantId, tenantId), inArray(subscriptions.installationLocationId, kapileswarapuramIds)));
    await db
      .update(equipment)
      .set({ locationId: kapileswaram.id })
      .where(and(eq(equipment.tenantId, tenantId), inArray(equipment.locationId, kapileswarapuramIds)));
  }

  if (otherStaleIds.length > 0) {
    await db
      .update(subscriptions)
      .set({ installationLocationId: buildingId })
      .where(and(eq(subscriptions.tenantId, tenantId), inArray(subscriptions.installationLocationId, otherStaleIds)));
    await db
      .update(equipment)
      .set({ locationId: buildingId })
      .where(and(eq(equipment.tenantId, tenantId), inArray(equipment.locationId, otherStaleIds)));
  }

  await db.delete(locationAliases).where(and(eq(locationAliases.tenantId, tenantId), inArray(locationAliases.locationId, ids)));
  await db.delete(locations).where(inArray(locations.id, ids));
  await db.delete(locationSchemas).where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.slug, 'gated-apartment')));
  console.log(`🧹 Removed ${ids.length} stale synthetic/unconfigured location nodes`);
}
