import process from 'node:process';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cable:cable@localhost:5432/cable',
  },
  schemaFilter: ['tenancy', 'auth', 'iam', 'crm', 'geo', 'notify', 'media', 'analytics', 'audit', 'inventory'],
  strict: true,
  verbose: true,
});
