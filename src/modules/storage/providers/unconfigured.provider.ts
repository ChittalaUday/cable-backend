import type { StorageProvider } from '../storage.types';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError } from '@/shared/errors/domain-error';

/**
 * Holds the storage slot open until R2 credentials exist (AGENTS.md §1).
 *
 * Every call fails with the env vars it needs, so a missing configuration reads
 * as a deployment checklist item rather than a crash inside the AWS SDK.
 */
export function createUnconfiguredStorage(bucket = 'unconfigured'): StorageProvider {
  const fail = (): never => {
    throw new DomainError({
      code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
      statusCode: 503,
      message: 'Object storage is not configured. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET.',
    });
  };

  return {
    name: 'unconfigured',
    bucket,
    configured: false,
    createUploadUrl: async () => fail(),
    createDownloadUrl: async () => fail(),
    head: async () => fail(),
    put: async () => fail(),
    remove: async () => fail(),
  };
}
