import process from 'node:process';
import closeWithGrace from 'close-with-grace';
import { buildApp } from '@/app';
import { env } from '@/config/env';
import { reportPreflight, runPreflight } from '@/config/preflight';

const app = await buildApp();

const preflight = await runPreflight(app);
reportPreflight(app, preflight);

if (preflight.failed) {
  app.log.error('Preflight failed — not listening. Fix the items marked ✗ above.');
  await app.close();
  process.exit(1);
}

await app.clearCache();

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
