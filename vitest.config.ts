import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { defineConfig } from 'vitest/config';

// A local PostgreSQL beats spinning a container: same engine, far faster suite.
// Testcontainers stays as the fallback when this file is absent (e.g. in CI).
if (fs.existsSync('.env.test'))
  process.loadEnvFile('.env.test');

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Testcontainers starts one PostgreSQL for the whole run (AGENTS.md §10).
    globalSetup: ['./src/test/global-setup.ts'],
    setupFiles: ['./src/test/setup.ts'],
    hookTimeout: 120_000,
    testTimeout: 30_000,
    pool: 'threads',
    // @fastify/autoload dynamically imports plugin files at runtime. Left
    // external, that import is native Node's and the `@/` alias does not exist
    // — every plugin fails with "Cannot find package '@/config'". Inlined, the
    // import goes through Vite and resolves like every other one.
    server: { deps: { inline: ['@fastify/autoload'] } },
    coverage: { provider: 'v8', include: ['src/**/*.ts'], exclude: ['src/**/*.test.ts', 'src/test/**'] },
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
});
