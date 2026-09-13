import type { FastifyBaseLogger } from 'fastify';
import type { StorageService } from '@/modules/storage/storage.service';
import type { StorageCleanupOptions, StorageCleanupReport } from '@/modules/storage/storage.types';

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
