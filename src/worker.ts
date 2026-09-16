import closeWithGrace from 'close-with-grace';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { startScheduler } from '@/jobs/scheduler';
import { createStorageService } from '@/modules/storage/storage.service';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('worker');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool, { schema });

const storage = createStorageService(db);

const scheduler = await startScheduler(storage, log);
log.info({ appEnv: env.APP_ENV }, 'worker started');

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  await scheduler.stop({ graceful: true, timeout: 10_000 });
  await pool.end();
  if (err)
    log.error({ err }, 'worker shutting down after an unhandled error');
  else
    log.info({ signal }, 'worker shutting down');
});
