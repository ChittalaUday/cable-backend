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
