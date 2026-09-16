import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { locationCategories, locations, locationSchemas, tenants } from '@/db/schema';
import { createTestDb, inRollback } from '@/test/db';
import { underAnyGrant, withinGrantedSubtree } from './location-scope';

const { db, close } = createTestDb();
afterAll(async () => close());

async function seedTree(tx: typeof db) {
  const [tenant] = await tx
    .insert(tenants)
    .values({ code: `S${randomUUID().replaceAll('-', '').slice(0, 4).toUpperCase()}`, name: 'Scope Test' })
    .returning();
  const tenantId = tenant!.id;

  const [schema] = await tx.insert(locationSchemas).values({ tenantId, name: 'Flat', slug: 'flat' }).returning();
  const [category] = await tx.insert(locationCategories).values({ tenantId, name: 'Node', slug: 'node' }).returning();

  const add = async (name: string, parentId: string | null) => {
    const [row] = await tx
      .insert(locations)
      .values({ tenantId, schemaId: schema!.id, categoryId: category!.id, parentId, name })
      .returning();
    return row!.id;
  };

  const north = await add('North', null);
  const building = await add('Sri Sai Apartments', north);
  const floor = await add('First Floor', building);
  const door = await add('A101', floor);
  const south = await add('South', null);
  const southDoor = await add('B201', south);

  return { north, building, floor, door, south, southDoor };
}

async function matched(tx: typeof db, ids: string[], granted: readonly string[]): Promise<string[]> {
  const result = await tx.execute<{ id: string }>(sql`
    SELECT candidate.id
    FROM unnest(${sql.param(ids)}::uuid[]) AS candidate(id)
    WHERE ${withinGrantedSubtree(sql`candidate.id`, granted)}
  `);

  return result.rows.map(row => row.id);
}

describe('withinGrantedSubtree', () => {
  it('reaches the granted node and everything beneath it', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await matched(tx, [tree.north, tree.building, tree.floor, tree.door], [tree.north]))
        .toEqual([tree.north, tree.building, tree.floor, tree.door]);
    });
  });

  it('stops at a sibling subtree', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await matched(tx, [tree.door, tree.southDoor], [tree.north])).toEqual([tree.door]);
    });
  });

  it('does not reach upward from the granted node', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await matched(tx, [tree.north, tree.building, tree.floor, tree.door], [tree.floor]))
        .toEqual([tree.floor, tree.door]);
    });
  });

  it('unions several grants', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await matched(tx, [tree.door, tree.southDoor], [tree.building, tree.south]))
        .toEqual([tree.door, tree.southDoor]);
    });
  });

  it('reaches nothing when no area was granted', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await matched(tx, [tree.north, tree.door, tree.southDoor], [])).toEqual([]);
    });
  });
});

describe('underAnyGrant', () => {
  const reaches = async (tx: typeof db, nodeId: string, granted: readonly string[]) => {
    const result = await tx.execute<{ ok: boolean }>(sql`SELECT ${underAnyGrant(nodeId, granted)} AS ok`);
    return result.rows[0]!.ok;
  };

  it('accepts a node under a granted ancestor', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await reaches(tx, tree.door, [tree.north])).toBe(true);
    });
  });

  it('accepts the granted node itself', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await reaches(tx, tree.building, [tree.building])).toBe(true);
    });
  });

  it('refuses a node in a sibling subtree', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await reaches(tx, tree.southDoor, [tree.north])).toBe(false);
    });
  });

  it('refuses everything when no area was granted', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);

      expect(await reaches(tx, tree.door, [])).toBe(false);
    });
  });

  it('agrees with withinGrantedSubtree on the same pair', async () => {
    await inRollback(db, async (tx) => {
      const tree = await seedTree(tx);
      const nodes = [tree.north, tree.building, tree.floor, tree.door, tree.south, tree.southDoor];
      const granted = [tree.building];

      const downward = await matched(tx, nodes, granted);
      const upward: string[] = [];
      for (const node of nodes) {
        if (await reaches(tx, node, granted))
          upward.push(node);
      }

      expect(upward).toEqual(downward);
    });
  });
});
