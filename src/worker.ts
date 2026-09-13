import closeWithGrace from 'close-with-grace';
import pino from 'pino';
import { env, isLocal } from '@/config/env';

/**
 * Background worker entry point (AGENTS.md §3).
 *
 * Runs jobs from `src/jobs/`, never in the API process — an API process that
 * also runs jobs stalls requests behind a billing run.
 *
 * There are no jobs yet (§1). This exists so the process, its logger and its
 * shutdown path are already correct when the first one lands.
 */
const log = pino({
  level: env.LOG_LEVEL,
  ...(isLocal ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
});

log.info({ appEnv: env.APP_ENV }, 'worker started — no jobs registered');

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  if (err)
    log.error({ err }, 'worker shutting down after an unhandled error');
  else
    log.info({ signal }, 'worker shutting down');
});
