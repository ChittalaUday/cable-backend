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
/**
 * TLS for the database connection, per tier (AGENTS.md §2.1).
 *
 * `disable` locally and on staging, where Postgres is on the same host or a
 * private network. Production cannot reach `disable` — `assertTier` rejects it
 * at boot — and `verify-full` is the setting that actually checks the
 * certificate; `require` encrypts but would accept an impostor.
 */
function sslOptions(): { ssl?: { rejectUnauthorized: boolean } } {
  switch (env.DATABASE_SSL) {
    case 'disable':
      return {};
    case 'require':
      return { ssl: { rejectUnauthorized: false } };
    case 'verify-full':
      return { ssl: { rejectUnauthorized: true } };
  }
}

export default fp(async (app) => {
  const pool = new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: env.DATABASE_POOL_MAX,
    ...sslOptions(),
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
