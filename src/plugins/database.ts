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

  const client = await pool.connect();
  client.release();

  const db = drizzle(pool, { schema });

  app.decorate('pool', pool);
  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await pool.end();
  });
}, { name: 'database' });
