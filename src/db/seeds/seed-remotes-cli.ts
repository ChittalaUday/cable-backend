import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { seedRemotes } from './seed-remotes';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });

try {
  const count = await seedRemotes(drizzle(pool, { schema }));
  console.log(`✅ Seeded ${count} IR remotes into the shared library`);
}
catch (error) {
  console.error('❌ Remote seed failed:', error);
  process.exitCode = 1;
}
finally {
  await pool.end();
}
