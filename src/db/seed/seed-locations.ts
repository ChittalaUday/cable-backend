import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
} from '@/db/schema';

type Db = NodePgDatabase<typeof schema>;

/**
 * The two shapes the operator actually sells into.
 *
 * **TIDCO Apartments** is the bulk of the book — one complex in Mandapeta,
 * addressed all the way down to a door, so the hierarchy has to reach that far:
 * `Mandapeta → TIDCO Apartments → Group A → A31 → Second Floor → 1`. The tree
 * itself is not seeded here; `seed-mso-data` builds it from the addresses in
 * the MSO report, because inventing block and door numbers that do not match
 * the customer file is how the two drift apart.
 *
 * **Street Address** covers the outlying villages, where an address is a
 * village and a street and nothing finer.
 */

export const TIDCO_SCHEMA_SLUG = 'tidco-apartments';
export const STREET_SCHEMA_SLUG = 'street-address';
export const TIDCO_TOWN = 'Mandapeta';
export const TIDCO_BUILDING = 'TIDCO Apartments';

/** The chain `seed-mso-data` walks down; the order is the schema. */
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

/**
 * Villages the MSO report mentions, plus the towns the operator already
 * listed. Mandapeta is deliberately absent: it is the root of the TIDCO
 * hierarchy below, and a node belongs to exactly one schema.
 */
const STREET_AREAS: Record<string, string[]> = {
  Alamuru: ['Canal Road', 'Raja Street', 'Ramalayam Street'],
  Jonnada: ['National Highway Road', 'Old Post Office Street'],
  Dwarapudi: ['Cloth Market Street', 'Station Road', 'Cinema Hall Street'],
  Kapileswarapuram: ['Main Road', 'Brahmam Gari Veedhi', 'Challa Vari Veedhi'],
  Macharamattalu: ['Main Road'],
  Angara: ['Main Road'],
  Yandagandi: ['Main Road'],
  Kanjulapeta: ['Main Road'],
  Kutukulur: ['Main Road'],
};

export async function seedLocations(db: Db, tenantId: string): Promise<void> {
  const categoryMap = new Map<string, string>();
  for (const cat of CATEGORIES) {
    const [row] = await db
      .insert(locationCategories)
      .values({ tenantId, name: cat.name, slug: cat.slug, config: {} })
      .onConflictDoUpdate({
        target: [locationCategories.tenantId, locationCategories.slug],
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
        set: { name: input.name, description: input.description, updatedAt: new Date() },
      })
      .returning({ id: locationSchemas.id });

    // Replaced rather than upserted: the levels are unique on both depth and
    // category, so re-running with a changed chain would collide on every row
    // that moved and silently leave the old shape in place.
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
      // A node that predates this schema — Mandapeta used to be a street area —
      // is moved rather than recreated, so nothing pointing at it has to change.
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

    for (const streetName of streets) {
      await upsertNode({
        schemaId: streetSchemaId,
        categoryId: categoryMap.get('street')!,
        parentId: areaId,
        name: streetName,
      });
    }
  }

  // Mandapeta and the complex itself; everything below them comes from the
  // customer file, so `seed-mso-data` picks up from here.
  const mandapetaId = await upsertNode({
    schemaId: tidcoSchemaId,
    categoryId: categoryMap.get('area')!,
    parentId: null,
    name: TIDCO_TOWN,
    code: 'MDP',
  });

  await upsertNode({
    schemaId: tidcoSchemaId,
    categoryId: categoryMap.get('building')!,
    parentId: mandapetaId,
    name: TIDCO_BUILDING,
    code: 'TIDCO',
  });

  // Mandapeta's four synthetic streets and the old `gated-apartment` sample
  // tree described a hierarchy nothing in the customer file matches. They go,
  // unless something already points at them — an FK error here means real data
  // is attached and the node has to be re-pointed by hand rather than dropped.
  await dropStaleNodes(db, tenantId, mandapetaId);

  console.log(`✅ Seeded location categories, two schemas, ${Object.keys(STREET_AREAS).length} village areas, and the Mandapeta / TIDCO Apartments root`);
}

/**
 * The synthetic tree the first pass of this seed invented, removed leaf-first.
 *
 * Only nodes under the old `gated-apartment` schema and the streets that used
 * to hang off Mandapeta; anything a subscription still references raises a
 * foreign key error instead of being deleted out from under it.
 */
async function dropStaleNodes(db: Db, tenantId: string, mandapetaId: string): Promise<void> {
  // One DELETE for the whole set: `locations.parent_id` is NO ACTION, which
  // Postgres checks at end of statement, so parents and children can go together.
  const stale = await db.execute<{ id: string }>(sql`
    SELECT l.id
    FROM geo.locations l
    JOIN geo.location_schemas s ON s.id = l.schema_id
    WHERE l.tenant_id = ${tenantId} AND s.slug = 'gated-apartment'
    UNION
    SELECT l.id
    FROM geo.locations l
    JOIN geo.location_categories c ON c.id = l.category_id
    WHERE l.tenant_id = ${tenantId} AND l.parent_id = ${mandapetaId} AND c.slug = 'street'
  `);

  const ids = stale.rows.map(row => row.id);
  if (ids.length === 0)
    return;

  await db.delete(locations).where(inArray(locations.id, ids));
  await db.delete(locationSchemas).where(and(eq(locationSchemas.tenantId, tenantId), eq(locationSchemas.slug, 'gated-apartment')));
  console.log(`🧹 Removed ${ids.length} stale synthetic location nodes`);
}
