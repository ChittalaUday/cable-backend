import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from '@/db/schema';

export type TestDb = NodePgDatabase<typeof schema>;

/**
 * Connection string for the test database, or a loud failure.
 *
 * Never falls back to the development or production database: a test that
 * quietly runs somewhere else is worse than a test that does not run.
 */
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

/** Thrown by `tx.rollback()`; it is the success path here, not a failure. */
const ROLLBACK = 'Rollback';

/**
 * Runs a test body inside a transaction that is always rolled back.
 *
 * Keeps tests order-independent and parallel-safe without truncating tables
 * between them (AGENTS.md §10).
 */
export async function inRollback(db: TestDb, body: (tx: TestDb) => Promise<void>): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await body(tx);
      tx.rollback();
    });
  }
  catch (error) {
    if (error instanceof Error && error.name.includes(ROLLBACK))
      return;
    throw error;
  }
}
