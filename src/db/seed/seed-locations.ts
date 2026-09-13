import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import { and, eq, isNull } from 'drizzle-orm';
import {
  locationCategories,
  locations,
  locationSchemaLevels,
  locationSchemas,
} from '@/db/schema';

type Db = NodePgDatabase<typeof schema>;

export async function seedLocations(db: Db, tenantId: string): Promise<void> {
  // 1. Categories
  const CATEGORIES = [
    { name: 'Area', slug: 'area' },
    { name: 'Street', slug: 'street' },
    { name: 'Group', slug: 'group' },
    { name: 'Flat', slug: 'flat' },
    { name: 'Door', slug: 'door' },
  ];

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

  // 2. Schemas
  // 2a. Street Address Schema (Area -> Street)
  const [streetSchema] = await db
    .insert(locationSchemas)
    .values({
      tenantId,
      name: 'Street Address',
      slug: 'street-address',
      description: 'Standard town/village and street layout (Mandapeta, Alamuru, Jonnada, Dwarapudi)',
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [locationSchemas.tenantId, locationSchemas.slug],
      set: { name: 'Street Address', updatedAt: new Date() },
    })
    .returning({ id: locationSchemas.id });

  await db
    .insert(locationSchemaLevels)
    .values([
      { schemaId: streetSchema!.id, categoryId: categoryMap.get('area')!, depth: 0, isTerminal: false },
      { schemaId: streetSchema!.id, categoryId: categoryMap.get('street')!, depth: 1, isTerminal: true },
    ])
    .onConflictDoNothing();

  // 2b. Gated Apartment Schema (Area -> Group -> Flat -> Door)
  const [gatedSchema] = await db
    .insert(locationSchemas)
    .values({
      tenantId,
      name: 'Gated Apartment',
      slug: 'gated-apartment',
      description: 'Gated community hierarchy with groups of flats and door numbers',
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [locationSchemas.tenantId, locationSchemas.slug],
      set: { name: 'Gated Apartment', updatedAt: new Date() },
    })
    .returning({ id: locationSchemas.id });

  await db
    .insert(locationSchemaLevels)
    .values([
      { schemaId: gatedSchema!.id, categoryId: categoryMap.get('area')!, depth: 0, isTerminal: false },
      { schemaId: gatedSchema!.id, categoryId: categoryMap.get('group')!, depth: 1, isTerminal: false },
      { schemaId: gatedSchema!.id, categoryId: categoryMap.get('flat')!, depth: 2, isTerminal: false },
      { schemaId: gatedSchema!.id, categoryId: categoryMap.get('door')!, depth: 3, isTerminal: true },
    ])
    .onConflictDoNothing();

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

  // 3. Seed Street Locations: Mandapeta, Alamuru, Jonnada, Dwarapudi
  const STREET_AREAS: Record<string, string[]> = {
    Mandapeta: ['Main Road', 'Gandhi Nagar', 'Kothapeta Road', 'Bazaar Street'],
    Alamuru: ['Canal Road', 'Raja Street', 'Ramalayam Street'],
    Jonnada: ['National Highway Road', 'Old Post Office Street'],
    Dwarapudi: ['Cloth Market Street', 'Station Road', 'Cinema Hall Street'],
  };

  for (const [areaName, streets] of Object.entries(STREET_AREAS)) {
    const areaId = await upsertNode({
      schemaId: streetSchema!.id,
      categoryId: categoryMap.get('area')!,
      parentId: null,
      name: areaName,
      code: areaName.slice(0, 3).toUpperCase(),
    });

    for (const streetName of streets) {
      await upsertNode({
        schemaId: streetSchema!.id,
        categoryId: categoryMap.get('street')!,
        parentId: areaId,
        name: streetName,
      });
    }
  }

  // 4. Seed Gated Community Locations: Mandapeta Gated -> Group A, B, C -> A1, A2, A3 -> Doors G1..G8, F1..F8, TF1
  const gatedAreaId = await upsertNode({
    schemaId: gatedSchema!.id,
    categoryId: categoryMap.get('area')!,
    parentId: null,
    name: 'Mandapeta Gated',
    code: 'MDP-GTD',
  });

  const GROUPS = [
    { name: 'Group A', code: 'A', flats: ['A1', 'A2', 'A3'] },
    { name: 'Group B', code: 'B', flats: ['B1', 'B2', 'B3'] },
    { name: 'Group C', code: 'C', flats: ['C1', 'C2', 'C3'] },
  ];

  // For flat A1, generate doors G1..G8, F1..F8, TF1 as requested
  const A1_DOORS = [
    ...Array.from({ length: 8 }, (_, i) => `G${i + 1}`),
    ...Array.from({ length: 8 }, (_, i) => `F${i + 1}`),
    'TF1',
  ];

  for (const group of GROUPS) {
    const groupId = await upsertNode({
      schemaId: gatedSchema!.id,
      categoryId: categoryMap.get('group')!,
      parentId: gatedAreaId,
      name: group.name,
      code: group.code,
    });

    for (const flatName of group.flats) {
      const flatId = await upsertNode({
        schemaId: gatedSchema!.id,
        categoryId: categoryMap.get('flat')!,
        parentId: groupId,
        name: flatName,
        code: flatName,
      });

      const doors = flatName === 'A1'
        ? A1_DOORS
        : ['G1', 'G2', 'F1', 'F2'];

      for (const doorName of doors) {
        await upsertNode({
          schemaId: gatedSchema!.id,
          categoryId: categoryMap.get('door')!,
          parentId: flatId,
          name: doorName,
          code: `${flatName}-${doorName}`,
        });
      }
    }
  }

  console.log(`✅ Seeded location categories, schemas, and tree (Mandapeta, Alamuru, Jonnada, Dwarapudi, Mandapeta Gated)`);
}
