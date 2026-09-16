import type { FastifyBaseLogger } from 'fastify';
import type { StorageService } from '@/services/storage/storage.service';
import { PgBoss } from 'pg-boss';
import { env } from '@/config/env';
import { runLogCleanupJob } from './cron/log-cleanup.cron';
import { runStorageCleanupJob } from './cron/storage-cleanup.cron';

const LOG_CLEANUP = 'log-cleanup';
const STORAGE_CLEANUP = 'storage-cleanup';

export async function startScheduler(storage: StorageService, log: FastifyBaseLogger): Promise<PgBoss> {
  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: 'jobs',
    max: 2,
    ...(env.DATABASE_SSL === 'disable' ? {} : { ssl: { rejectUnauthorized: env.DATABASE_SSL === 'verify-full' } }),
  });
  boss.on('error', error => log.error({ err: error }, 'persistent scheduler error'));
  boss.on('warning', warning => log.warn({ warning }, 'persistent scheduler warning'));
  await boss.start();

  const queueOptions = {
    retryLimit: 2,
    retryDelay: 60,
    retryBackoff: true,
    deleteAfterSeconds: env.JOB_HISTORY_RETENTION_DAYS * 86_400,
  };
  await boss.createQueue(STORAGE_CLEANUP, queueOptions);
  await boss.createQueue(LOG_CLEANUP, queueOptions);

  await boss.work(STORAGE_CLEANUP, async ([job]) => {
    if (!job)
      return;
    return executeLogged(log, { name: STORAGE_CLEANUP, id: job.id }, async () => runStorageCleanupJob(storage, log));
  });
  await boss.work(LOG_CLEANUP, async ([job]) => {
    if (!job)
      return;
    return executeLogged(log, { name: LOG_CLEANUP, id: job.id }, async () => ({
      deletedFolders: await runLogCleanupJob({
        directory: env.LOG_DIRECTORY,
        retentionDays: env.LOG_RETENTION_DAYS,
        log,
      }),
    }));
  });

  await boss.schedule(STORAGE_CLEANUP, env.STORAGE_CLEANUP_CRON, null, { tz: 'UTC', missed: 'once' });
  await boss.schedule(LOG_CLEANUP, env.LOG_CLEANUP_CRON, null, { tz: 'UTC', missed: 'once' });
  log.info({
    schedules: await boss.getSchedules(),
    historyRetentionDays: env.JOB_HISTORY_RETENTION_DAYS,
  }, 'persistent jobs registered');
  return boss;
}

async function executeLogged<T>(
  log: FastifyBaseLogger,
  job: { name: string; id: string },
  callback: () => Promise<T>,
): Promise<T> {
  log.info({ job: job.name, jobId: job.id }, 'job execution started');
  try {
    const result = await callback();
    log.info({ job: job.name, jobId: job.id, result }, 'job execution completed');
    return result;
  }
  catch (error) {
    log.error({ err: error, job: job.name, jobId: job.id }, 'job execution failed');
    throw error;
  }
}
