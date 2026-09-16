import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];

export function sslOptions(): { ssl?: { rejectUnauthorized: boolean } } {
  switch (env.DATABASE_SSL) {
    case 'disable':
      return {};
    case 'require':
      return { ssl: { rejectUnauthorized: false } };
    case 'verify-full':
      return { ssl: { rejectUnauthorized: true } };
  }
}

export function createPool(connectionString = env.DATABASE_URL, max = env.DATABASE_POOL_MAX): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    ...sslOptions(),
  });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}
