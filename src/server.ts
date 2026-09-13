import closeWithGrace from 'close-with-grace';
import { buildApp } from '@/app';
import { env } from '@/config/env';

/**
 * Process entry point. Builds, listens, and shuts down cleanly.
 *
 * Nothing else belongs here — anything testable lives in `app.ts`, which tests
 * build directly.
 */
const app = await buildApp();

closeWithGrace({ delay: 10_000 }, async ({ err, signal }) => {
  if (err)
    app.log.error({ err }, 'shutting down after an unhandled error');
  else
    app.log.info({ signal }, 'shutting down');

  await app.close();
});

try {
  await app.listen({ port: env.PORT, host: env.HOST });
}
catch (err) {
  app.log.error({ err }, 'failed to start');
  throw err;
}
