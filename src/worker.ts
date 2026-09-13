import closeWithGrace from 'close-with-grace';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { csv, env } from '@/config/env';
import * as schema from '@/db/schema';
import { runLogCleanupJob } from '@/jobs/log-cleanup.job';
import { runStorageCleanupJob } from '@/jobs/storage-cleanup.job';
import { createR2Provider, createUnconfiguredStorage, StorageService } from '@/modules/storage';
import { createLogger } from '@/shared/logging/logger';

/**
 * Background worker entry point (AGENTS.md §3).
 *
 * Runs jobs from `src/jobs/`, never in the API process.
 * Schedules the nightly storage verification and cleanup cron.
 */
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

/**
 * Schedules a callback every night at `hourUtc:00:00` UTC.
 */
function scheduleNightly(name: string, callback: () => Promise<void>, hourUtc: number): () => void {
  let timer: NodeJS.Timeout;

  function getNextRunDelay(): number {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(hourUtc, 0, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
  }

  function scheduleNext() {
    const delay = getNextRunDelay();
    const nextDate = new Date(Date.now() + delay);
    log.info({ job: name, nextRun: nextDate.toISOString() }, 'Scheduled nightly job');

    timer = setTimeout(() => {
      void (async () => {
        try {
          await callback();
        }
        catch (err) {
        log.error({ err, job: name }, 'Nightly job failed');
        }
        finally {
          scheduleNext();
        }
      })();
    }, delay);
    timer.unref();
  }

  scheduleNext();
  return () => clearTimeout(timer);
}

const cancelStorageCron = scheduleNightly('storage-cleanup', async () => {
  await runStorageCleanupJob(storage, log);
}, 2); // 02:00 AM UTC

const cancelLogCron = scheduleNightly('log-cleanup', async () => {
  await runLogCleanupJob({
    directory: env.LOG_DIRECTORY,
    retentionDays: env.LOG_RETENTION_DAYS,
    log,
  });
}, env.LOG_CLEANUP_HOUR_UTC);

log.info({ appEnv: env.APP_ENV }, 'worker started — nightly storage cleanup job registered');

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  cancelStorageCron();
  cancelLogCron();
  await pool.end();
  if (err)
    log.error({ err }, 'worker shutting down after an unhandled error');
  else
    log.info({ signal }, 'worker shutting down');
});
