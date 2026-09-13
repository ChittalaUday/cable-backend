import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@/db/schema';

export type TestDb = NodePgDatabase<typeof schema>;

export function requireTestDatabase(): string {
  const url = process.env.DATABASE_URL_TEST;
  if (url == null || url === '') {
    throw new Error(
      'No test database. Set DATABASE_URL_TEST, or start Docker so Testcontainers '
      + 'can boot PostgreSQL 18.',
    );
  }
  return url;
}

export interface TestDbHandle {
  db: TestDb;
  close: () => Promise<void>;
}

export function createTestDb(): TestDbHandle {
  const pool = new pg.Pool({ connectionString: requireTestDatabase(), max: 4 });
  return { db: drizzle(pool, { schema }), close: async () => pool.end() };
}

const ROLLBACK = 'Rollback';

export async function inRollback(db: TestDb, body: (tx: TestDb) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  }
  catch (error) {
    if (error instanceof Error && (error.name.includes(ROLLBACK) || error.message.includes(ROLLBACK)))
      return;
    throw error;
  }
}
