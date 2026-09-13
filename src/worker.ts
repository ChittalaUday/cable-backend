import closeWithGrace from 'close-with-grace';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { csv, env } from '@/config/env';
import * as schema from '@/db/schema';
import { startScheduler } from '@/jobs/scheduler';
import { createR2Provider } from '@/modules/storage/providers/r2.provider';
import { createUnconfiguredStorage } from '@/modules/storage/providers/unconfigured.provider';
import { StorageService } from '@/modules/storage/storage.service';
import { createLogger } from '@/shared/logging/logger';

const log = createLogger('worker');

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const db = drizzle(pool, { schema });

const hasR2 = env.R2_ACCOUNT_ID !== ''
  && env.R2_ACCESS_KEY_ID !== ''
  && env.R2_SECRET_ACCESS_KEY !== ''
  && env.R2_BUCKET !== '';

const provider = hasR2
  ? createR2Provider({
      accountId: env.R2_ACCOUNT_ID,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
      ...(env.R2_ENDPOINT === '' ? {} : { endpoint: env.R2_ENDPOINT }),
      ...(env.R2_JURISDICTION === '' ? {} : { jurisdiction: env.R2_JURISDICTION }),
      ...(env.R2_PUBLIC_BASE_URL === '' ? {} : { publicBaseUrl: env.R2_PUBLIC_BASE_URL }),
    })
  : createUnconfiguredStorage();

const storage = new StorageService(db, {
  provider,
  uploadUrlTtlSeconds: env.UPLOAD_URL_TTL_SECONDS,
  downloadUrlTtlSeconds: env.DOWNLOAD_URL_TTL_SECONDS,
  maxUploadBytes: env.MAX_UPLOAD_BYTES,
  allowedContentTypes: csv(env.ALLOWED_UPLOAD_TYPES),
});

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
