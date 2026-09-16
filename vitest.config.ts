import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { defineConfig } from 'vitest/config';

if (fs.existsSync('.env.test'))
  process.loadEnvFile('.env.test');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    pool: 'threads',
    // One database, and `roles_known_id` allows exactly three role ids — so a
    // file that grants `staff.view` to `staff` is granting it to every other
    // file's staff caller at the same time. The API tests commit; they do not
    // roll back. Running files one at a time makes a grant that is taken away
    // in `afterAll` actually mean that. Isolation by construction, ~17s.
    // ponytail: per-tenant roles, or a schema per worker, would buy the
    // parallelism back — do it when the suite gets slow enough to notice.
    fileParallelism: false,
    server: { deps: { inline: ['@fastify/autoload'] } },
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/test/**'] },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
});
