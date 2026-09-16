import type pg from 'pg';
import type { Database } from '@/db/client';
import fp from 'fastify-plugin';
import { createDb, createPool } from '@/db/client';

declare module 'fastify' {
  interface FastifyInstance {
    db: Database;
    pool: pg.Pool;
  }
}

export default fp(async (app) => {
  const pool = createPool();
  const client = await pool.connect();
  client.release();

  const db = createDb(pool);

  app.decorate('pool', pool);
  app.decorate('db', db);

  app.addHook('onClose', async () => {
    await pool.end();
  });
}, { name: 'db' });
