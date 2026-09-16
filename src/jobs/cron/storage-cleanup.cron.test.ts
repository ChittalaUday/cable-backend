import type { FastifyBaseLogger } from 'fastify';
import type { StorageService } from '@/services/storage/storage.service';
import type { StorageCleanupReport } from '@/services/storage/storage.types';
import { describe, expect, it, vi } from 'vitest';
import { runStorageCleanupJob } from './storage-cleanup.cron';

describe('runStorageCleanupJob', () => {
  it('invokes verifyAndCleanupStorage and logs the result', async () => {
    const mockReport: StorageCleanupReport = {
      stalePendingCleaned: 2,
      inFlightPendingPreserved: 5,
      orphanedFilesCleaned: 3,
      missingObjectsFlagged: 0,
    };

    const verifyMock = vi.fn(async () => mockReport);
    const mockStorage = {
      verifyAndCleanupStorage: verifyMock,
    } as unknown as StorageService;

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as FastifyBaseLogger;

    const report = await runStorageCleanupJob(mockStorage, mockLogger, { gracePeriodMinutes: 60 });

    expect(verifyMock).toHaveBeenCalledWith({ gracePeriodMinutes: 60 });
    expect(report).toEqual(mockReport);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        stalePendingCleaned: 2,
        inFlightPendingPreserved: 5,
        orphanedFilesCleaned: 3,
      }),
      expect.stringContaining('Completed storage verification and cleanup'),
    );
  });
});
