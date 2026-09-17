import path from 'node:path';
import antfu from '@antfu/eslint-config';

const ROOT = import.meta.dirname;

export default antfu(
  {
    isInEditor: false,
    typescript: { tsconfigPath: path.join(ROOT, 'tsconfig.json'), tsconfigRootDir: ROOT },
    stylistic: { indent: 2, quotes: 'single', semi: true },
    jsonc: false,
    yaml: false,
    ignores: ['**/dist', '**/coverage', '**/node_modules', '**/src/db/migrations'],
  },

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
        ignore: ['AGENTS.md', 'CLAUDE.md', 'README.md'],
      }],
      // Length is not the thing that makes a function hard to read; a screen
      // component or a route table is long because it is a list.
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'ts/max-params': 'off',
      'complexity': ['error', 12],

      'ts/no-explicit-any': 'error',

      'no-console': 'error',
      'node/no-process-env': 'error',

      'no-restricted-imports': ['error', {
        patterns: [{
          group: ['@/modules/*/*', '!@/modules/*/*.service', '!@/modules/*/*.repository', '!@/modules/*/*.schema', '!@/modules/*/*.types', '!@/modules/*/providers', '!@/modules/*/providers/*'],
          message: 'Cross-module: import the module\'s service, repository, or schema. Within a module, use a relative sibling import (./x).',
        }],
      }],
    },
  },

  {
    files: ['**/src/**/*.ts'],
    rules: {
      'ts/consistent-type-imports': 'error',
      'ts/no-floating-promises': 'error',
      'ts/no-misused-promises': 'error',
      'ts/no-unnecessary-condition': 'error',
    },
  },

  {
    files: ['**/src/modules/**/*.service.ts', '**/src/services/**/*.service.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [{ name: 'fastify', message: 'Services are framework-free. Take plain arguments, throw domain errors.' }],
        patterns: [
          { group: ['@fastify/*'], message: 'Services are framework-free.' },
        ],
      }],
    },
  },

  {
    files: ['**/src/modules/**/*.routes.ts', '**/src/jobs/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          { group: ['@/db', '@/db/*', 'drizzle-orm', 'drizzle-orm/*'], message: 'No direct database access in routes or jobs. Go through a service or repository.' },
        ],
      }],
    },
  },

  {
    files: ['**/src/server.ts', '**/src/worker.ts', '**/src/verify.ts', '**/src/db/migrate.ts', '**/src/db/seeds/**/*.ts'],
    rules: { 'antfu/no-top-level-await': 'off' },
  },

  {
    files: ['**/*.schema.ts', '**/src/utils/pagination/**'],
    rules: { 'ts/no-redeclare': 'off' },
  },

  {
    files: ['**/src/config/env.ts', '**/drizzle.config.ts', '**/vitest.config.ts', '**/src/test/**/*.ts', '**/*.test.ts', '**/scripts/**/*.ts'],
    rules: { 'node/no-process-env': 'off' },
  },

  {
    files: ['**/*.test.ts', '**/src/test/**/*.ts'],
    rules: { 'max-lines-per-function': 'off', 'ts/no-non-null-assertion': 'off', 'no-console': 'off' },
  },

  {
    files: ['**/src/db/seeds/**/*.ts', '**/src/db/migrate.ts'],
    rules: {
      'no-console': 'off',
      'max-lines-per-function': 'off',
      'complexity': 'off',
    },
  },

  // Operator-facing scripts: their whole output is what they print.
  {
    files: ['**/scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      'max-lines-per-function': 'off',
      'complexity': 'off',
      'antfu/no-top-level-await': 'off',
    },
  },
);
