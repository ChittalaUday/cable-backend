import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import fp from 'fastify-plugin';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';

export type Database = NodePgDatabase<typeof schema>;

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    pool: pg.Pool;
  }
}

/**
 * Decorates `app.db` with Drizzle and owns the pool lifecycle.
 *
 * Registered with fastify-plugin so the decorator is visible to every module,
 * not just this plugin's encapsulation context.
 */
export default fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
  });

  // Fail at boot rather than on the first request, so a bad DATABASE_URL never
  // reaches a health check that reports "ok".
  const client = await pool.connect();
  client.release();

  const db = drizzle(pool, { schema });

  app.decorate('pool', pool);
  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await pool.end();
  });
}, { name: 'database' });
