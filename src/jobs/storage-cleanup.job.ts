import type { FastifyBaseLogger } from 'fastify';
import type { StorageCleanupOptions, StorageCleanupReport, StorageService } from '@/modules/storage';

/**
 * Nightly storage verification and cleanup job (AGENTS.md §3, §8.4).
 *
 * Runs in the worker process:
 * 1. Safely prunes expired/abandoned pending uploads while preserving in-flight requests.
 * 2. Prunes orphaned physical storage objects whose user references have been deleted.
 * 3. Verifies storage integrity of active ready files.
 */
export async function runStorageCleanupJob(
  storage: StorageService,
  log?: FastifyBaseLogger | Console,
  options?: StorageCleanupOptions,
): Promise<StorageCleanupReport> {
  const logger = log ?? console;
  logger.info('[job:storage-cleanup] Starting nightly storage verification and cleanup...');

  const report = await storage.verifyAndCleanupStorage(options);

  logger.info({
    stalePendingCleaned: report.stalePendingCleaned,
    inFlightPendingPreserved: report.inFlightPendingPreserved,
    orphanedFilesCleaned: report.orphanedFilesCleaned,
    missingObjectsFlagged: report.missingObjectsFlagged,
  }, '[job:storage-cleanup] Completed storage verification and cleanup');

  return report;
}
