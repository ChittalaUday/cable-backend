import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { locationCategories, locations, locationSchemaLevels, locationSchemas, tenants } from '@/db/schema';
import { createTestDb, inRollback } from '@/test/db';

const { db, close } = createTestDb();
afterAll(async () => close());

async function seedTree(tx: typeof db) {
  const [tenant] = await tx.insert(tenants)
    .values({ code: `L${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`, name: 'Tree Test' })
    .returning();
  const tenantId = tenant!.id;

  const [schema] = await tx.insert(locationSchemas)
    .values({ tenantId, name: 'Apartment', slug: 'apartment' })
    .returning();

  const names = ['Area', 'Building', 'Block', 'Floor', 'Door'];
  const categories = await tx.insert(locationCategories)
    .values(names.map(name => ({ tenantId, name, slug: name.toLowerCase() })))
    .returning();

  await tx.insert(locationSchemaLevels).values(categories.map((c, depth) => ({
    schemaId: schema!.id,
    categoryId: c.id,
    depth,
    isTerminal: depth === categories.length - 1,
  })));

  const chain = ['Mandapeta', 'Sri Sai Apartments', 'Block A', 'First Floor', 'A101'];
  const nodes: string[] = [];
  for (const [depth, name] of chain.entries()) {
    const [node] = await tx.insert(locations)
      .values({
        tenantId,
        schemaId: schema!.id,
        categoryId: categories[depth]!.id,
        parentId: nodes[depth - 1] ?? null,
        name,
      })
      .returning();
    nodes.push(node!.id);
  }

  return { tenantId, schemaId: schema!.id, categories, nodes };
}

describe('geo location tree', () => {
  it('walks every descendant of a node, itself included', async () => {
    await inRollback(db, async (tx) => {
      const { nodes } = await seedTree(tx);
      const building = nodes[1]!;

      const result = await tx.execute<{ id: string; depth: number }>(
        sql`SELECT id, depth FROM geo.location_descendants(${building}) ORDER BY depth`,
      );

      expect(result.rows.map(r => r.id)).toEqual(nodes.slice(1));
      expect(result.rows.at(-1)?.depth).toBe(3);
    });
  });

  it('walks ancestors up to the root, so a breadcrumb is one query', async () => {
    await inRollback(db, async (tx) => {
      const { nodes } = await seedTree(tx);

      const result = await tx.execute<{ id: string }>(
        sql`SELECT id FROM geo.location_ancestors(${nodes[4]!}) ORDER BY depth DESC`,
      );

      expect(result.rows.map(r => r.id)).toEqual(nodes);
    });
  });

  it('resolves the full path for display and search', async () => {
    await inRollback(db, async (tx) => {
      const { nodes } = await seedTree(tx);

      const result = await tx.execute<{ path: string; depth: number; root_id: string }>(
        sql`SELECT path, depth, root_id FROM geo.location_paths WHERE id = ${nodes[4]!}`,
      );

      expect(result.rows[0]?.path).toBe('Mandapeta / Sri Sai Apartments / Block A / First Floor / A101');
      expect(result.rows[0]?.depth).toBe(4);
      expect(result.rows[0]?.root_id).toBe(nodes[0]);
    });
  });

  it('refuses two siblings with the same name', async () => {
    await inRollback(db, async (tx) => {
      const { tenantId, schemaId, categories, nodes } = await seedTree(tx);

      await expect(tx.insert(locations).values({
        tenantId,
        schemaId,
        categoryId: categories[4]!.id,
        parentId: nodes[3]!,
        name: 'A101',
      })).rejects.toThrow();
    });
  });

  it('refuses two roots with the same name — NULL parents are not distinct', async () => {
    await inRollback(db, async (tx) => {
      const { tenantId, schemaId, categories } = await seedTree(tx);

      await expect(tx.insert(locations).values({
        tenantId,
        schemaId,
        categoryId: categories[0]!.id,
        parentId: null,
        name: 'Mandapeta',
      })).rejects.toThrow();
    });
  });

  it('keeps a schema a chain: one category per depth', async () => {
    await inRollback(db, async (tx) => {
      const { schemaId, categories } = await seedTree(tx);

      await expect(tx.insert(locationSchemaLevels)
        .values({ schemaId, categoryId: categories[0]!.id, depth: 9 }))
        .rejects
        .toThrow();
    });
  });

  it('will not orphan children by deleting their parent', async () => {
    await inRollback(db, async (tx) => {
      const { nodes } = await seedTree(tx);

      await tx.execute(sql`DELETE FROM geo.locations WHERE id = ${nodes[3]!}`);

      await expect(tx.execute(sql`SET CONSTRAINTS ALL IMMEDIATE`))
        .rejects
        .toThrow();
    });
  });
});
