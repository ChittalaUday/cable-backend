import process from 'node:process';
import { buildApp } from '@/app';
import { reportPreflight, runPreflight } from '@/config/preflight';

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
