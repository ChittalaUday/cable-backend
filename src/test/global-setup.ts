import path from 'node:path';
import process from 'node:process';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';

let container: Awaited<ReturnType<PostgreSqlContainer['start']>> | undefined;

const OWNED_SCHEMAS = [
  'tenancy',
  'auth',
  'iam',
  'crm',
  'geo',
  'notify',
  'media',
  'analytics',
  'audit',
  'inventory',
  'remotes',
  'drizzle',
] as const;

function assertTestDatabase(url: string): string {
  const name = new URL(url).pathname.replace(/^\//, '');

  if (!/test/i.test(name)) {
    throw new Error(
      `Refusing to reset "${name}": DATABASE_URL_TEST must name a database with "test" in it. `
      + 'This step drops every application schema.',
    );
  }

  return name;
}

async function resetSchemas(pool: pg.Pool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${OWNED_SCHEMAS.map(name => `"${name}"`).join(', ')} CASCADE`);
}

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

  assertTestDatabase(process.env.DATABASE_URL_TEST);

  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL_TEST, max: 1 });
  try {
    await resetSchemas(pool);
    await migrate(drizzle(pool), { migrationsFolder: path.join(import.meta.dirname, '..', 'db', 'migrations') });
  }
  finally {
    await pool.end();
  }
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
