import process from 'node:process';
import { buildApp } from '@/app';
import { reportPreflight, runPreflight } from '@/config/preflight';

/**
 * Runs the startup checks without listening, so a deploy pipeline can gate on
 * configuration before it routes traffic at a broken instance.
 */
const app = await buildApp();

try {
  const result = await runPreflight(app);
  reportPreflight(app, result);

  if (result.failed) {
    app.log.error('Configuration is not deployable.');
    process.exitCode = 1;
  }
  else {
    app.log.info('Configuration verified.');
  }
}
finally {
  await app.close();
}
