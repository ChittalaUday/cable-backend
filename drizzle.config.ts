import process from 'node:process';
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/schema/index.ts',
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://cable:cable@localhost:5432/cable',
  },
  // Only our own namespaces — never `public`, and never anything an extension owns.
  schemaFilter: ['tenancy', 'auth', 'iam', 'crm', 'notify', 'media', 'analytics', 'audit'],
  strict: true,
  verbose: true,
});
