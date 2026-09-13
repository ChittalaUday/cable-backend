/**
 * Applies pending migrations (AGENTS.md §8).
 *
 * Migrations are generated with `pnpm db:generate`, reviewed as SQL, and
 * committed. A merged migration file is immutable — fix forward with a new one.
 * `drizzle-kit push` is for local scratch work and never touches a shared database.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import { env } from '@/config/env';

const migrationsFolder = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

try {
  console.log(`Applying migrations from ${migrationsFolder}`);
  await migrate(drizzle(pool), { migrationsFolder });
  console.log('✅ Migrations applied');
}
catch (error) {
  console.error('❌ Migration failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}
