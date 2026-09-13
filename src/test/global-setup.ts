/**
 * Starts one PostgreSQL container for the whole test run (AGENTS.md §10).
 *
 * Tests run against the same Postgres version as production: `numeric` behaves
 * like `numeric`, constraints actually fire, and a broken migration is caught by
 * the suite rather than by a deploy.
 *
 * Skipped when DATABASE_URL_TEST is already set, so CI can point at a service
 * container instead of nesting Docker.
 *
 * If no container runtime is reachable, this does NOT fail the run — pure unit
 * tests have no reason to need Docker. DATABASE_URL_TEST stays unset and
 * `requireTestDatabase()` fails loudly in the tests that actually need it.
 */
import path from 'node:path';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;

export async function setup(): Promise<void> {
  if (process.env.DATABASE_URL_TEST == null || process.env.DATABASE_URL_TEST === '') {
    try {
      container = await new PostgreSqlContainer('postgres:18-alpine')
        .withDatabase('cable_test')
        .withUsername('cable')
        .withPassword('cable')
        .start();

      process.env.DATABASE_URL_TEST = container.getConnectionUri();
    }
    catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`\n⚠️  No container runtime available — database tests will fail.\n   ${reason}\n   Start Docker, or set DATABASE_URL_TEST to an existing PostgreSQL 18.\n`);
      return;
    }
  }

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: path.join(import.meta.dirname, '..', 'db', 'migrations') });
  }
  finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
