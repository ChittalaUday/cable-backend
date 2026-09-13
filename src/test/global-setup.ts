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
