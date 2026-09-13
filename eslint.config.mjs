import antfu from '@antfu/eslint-config';

/**
 * Layer boundaries from AGENTS.md §3 are enforced here, not by reviewer memory.
 * With no repository layer, the `db/` restriction on controllers is the only
 * thing keeping queries out of the controller layer — it is load-bearing.
 */
export default antfu(
  {
    // antfu relaxes rules when it thinks it is running in an editor. Lint must
    // behave identically on a laptop and in CI, so the detection is off.
    isInEditor: false,
    typescript: { tsconfigPath: './tsconfig.json' },
    stylistic: { indent: 2, quotes: 'single', semi: true },
    jsonc: false,
    yaml: false,
    ignores: ['dist', 'coverage', 'node_modules', 'src/db/migrations'],
  },

  // Code fences inside Markdown are examples, not compiled source.
  {
    files: ['**/*.md/**'],
    rules: {
      'no-console': 'off',
      'unused-imports/no-unused-vars': 'off',
      'no-restricted-imports': 'off',
      'ts/no-unused-vars': 'off',
    },
  },

  {
    rules: {
      'unicorn/filename-case': ['error', {
        case: 'kebabCase',
        // Convention-named docs that tooling looks up by exact name.
        ignore: ['AGENTS.md', 'CLAUDE.md', 'README.md'],
      }],
      'max-params': ['error', 3],
      'max-lines-per-function': ['error', 110],
      'complexity': ['error', 12],

      'ts/no-explicit-any': 'error',

      // §10: console bypasses Pino, loses the requestId, and leaks in production.
      'no-console': 'error',
      'node/no-process-env': 'error',

      // No `import/no-cycle`: antfu v4 ships import-lite, which does not provide it.
      // The layer restrictions below already block the cycles that matter — a cycle
      // inside one module is a local problem, not a broken boundary.

      // §3: cross-module access goes through the module's index.ts, never its internals.
      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/modules/*/*'],
          message: 'Cross-module: import from `@/modules/<name>` (its index.ts). Within a module, use a relative sibling import (./x).',
        }],
      }],
    },
  },

  // Type-aware rules need a real program, so they apply to compiled source only.
  {
    files: ['src/**/*.ts'],
    rules: {
      'ts/consistent-type-imports': 'error',
      'ts/no-floating-promises': 'error',
      'ts/no-misused-promises': 'error',
      'ts/no-unnecessary-condition': 'error',
    },
  },

  // §3: services are framework-free, so they stay testable without booting a server.
  {
    files: ['src/modules/**/*.service.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'fastify', message: 'Services are framework-free (§3). Take plain arguments, throw domain errors.' }],
        patterns: [
          { group: ['@fastify/*'], message: 'Services are framework-free (§3).' },
          { group: ['@/modules/*/*'], message: 'Cross-module: import from `@/modules/<name>` (its index.ts).' },
        ],
      }],
    },
  },

  // §3: no database access above the service layer.
  {
    files: ['src/modules/**/*.controller.ts', 'src/modules/**/*.routes.ts', 'src/jobs/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/db', '@/db/*', 'drizzle-orm', 'drizzle-orm/*'], message: 'No database access here (§3). Go through a service.' },
          { group: ['@/modules/*/*'], message: 'Cross-module: import from `@/modules/<name>` (its index.ts).' },
        ],
      }],
    },
  },

  // ESM process entry points: top-level await is exactly what they are for.
  {
    files: ['src/server.ts', 'src/worker.ts', 'src/db/migrate.ts'],
    rules: { 'antfu/no-top-level-await': 'off' },
  },

  // §10: env is read in exactly one place.
  {
    files: ['src/config/env.ts', 'drizzle.config.ts', 'vitest.config.ts', 'src/test/**/*.ts'],
    rules: { 'node/no-process-env': 'off' },
  },

  {
    files: ['**/*.test.ts', 'src/test/**/*.ts'],
    rules: { 'max-lines-per-function': 'off', 'ts/no-non-null-assertion': 'off', 'no-console': 'off' },
  },

  // Entry points and seeders report to a human on a terminal, not to a request logger.
  {
    files: ['src/db/seed/**/*.ts', 'src/db/migrate.ts'],
    rules: { 'no-console': 'off' },
  },
);
