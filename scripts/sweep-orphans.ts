/**
 * Lists objects in the bucket that no `files` row points at.
 *
 *   pnpm storage:orphans                  # report only — the default
 *   pnpm storage:orphans --delete         # actually remove them
 *   pnpm storage:orphans --min-age 30     # minutes an object must have existed
 *
 * The scheduled cleanup reconciles from the database outwards, so it can never
 * see an object that has no row at all. This is the other direction, and it is
 * destructive, so it prints what it found and stops unless told otherwise.
 */
import process from 'node:process';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { env } from '@/config/env';
import * as schema from '@/db/schema';
import { createStorageProvider, createStorageService } from '@/services/storage/storage.service';
import { arg, flag } from './stress/shared';

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 1 });
const db = drizzle(pool, { schema });

const provider = createStorageProvider();

if (!provider.configured) {
  console.error('Object storage is not configured.');
  process.exit(1);
}

const storage = createStorageService(db, provider);
const dryRun = !flag('delete');
const minimumAgeMinutes = Number(arg('min-age', '120'));

const report = await storage.sweepOrphanedObjects({ dryRun, minimumAgeMinutes });

const bytes = report.orphans.reduce((total, orphan) => total + orphan.sizeBytes, 0);

console.log(`\nbucket "${provider.bucket}"`);
console.log(`  scanned            ${report.scanned}`);
console.log(`  orphans            ${report.orphans.length} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  too recent to touch ${report.skippedTooRecent} (younger than ${minimumAgeMinutes}m)`);
console.log(`  removed            ${report.removed}`);

for (const orphan of report.orphans.slice(0, 25))
  console.log(`    ${orphan.lastModified?.toISOString() ?? '(no date)'}  ${(orphan.sizeBytes / 1024).toFixed(1)} KB  ${orphan.key}`);

if (report.orphans.length > 25)
  console.log(`    … and ${report.orphans.length - 25} more`);

if (dryRun && report.orphans.length > 0)
  console.log('\nNothing was deleted. Re-run with --delete to remove them.');

await pool.end();
