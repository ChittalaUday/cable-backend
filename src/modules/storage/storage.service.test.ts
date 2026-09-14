import type { ObjectHead, StorageProvider } from './storage.types';
import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { files, tenants, userFiles } from '@/db/schema';
import { ERROR_CODES } from '@/shared/errors';
import { createTestDb } from '@/test/db';
import { createUnconfiguredStorage } from './providers/unconfigured.provider';
import { buildStorageKey, folderFor, StorageService } from './storage.service';

function fakeProvider(overrides: Partial<StorageProvider> = {}): StorageProvider {
  return {
    name: 'fake',
    bucket: 'test-bucket',
    configured: true,
    createUploadUrl: async (key: string) => ({ url: `https://upload.test/${key}`, expiresAt: new Date() }),
    createDownloadUrl: async (key: string) => ({ url: `https://download.test/${key}`, expiresAt: new Date() }),
    head: async (): Promise<ObjectHead | null> => ({ sizeBytes: 10, contentType: 'image/png', checksum: null }),
    put: async () => {},
    remove: async () => {},
    ...overrides,
  };
}

describe('buildStorageKey', () => {
  it('never lets the client filename shape the path', () => {
    const key = buildStorageKey({ tenantId: 'tenant-1', originalName: '../../etc/passwd', contentType: 'image/png' });

    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(key.startsWith('tenant-1/')).toBe(true);
  });

  it('keeps the extension so storage serves a sensible content type', () => {
    expect(buildStorageKey({ tenantId: 'tenant-1', originalName: 'invoice.PDF', contentType: 'application/pdf' })).toMatch(/\.pdf$/);
    expect(buildStorageKey({ tenantId: 'tenant-1', originalName: 'photo.jpeg', contentType: 'image/jpeg' })).toMatch(/\.jpeg$/);
  });

  it('partitions by tenant and month, so a bucket listing stays navigable', () => {
    const key = buildStorageKey({ tenantId: 'tenant-1', originalName: 'a.png', contentType: 'image/png' });
    expect(key).toMatch(/^tenant-1\/images\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  it('files a tenantless object under platform rather than under "null"', () => {
    expect(buildStorageKey({ tenantId: null, originalName: 'a.png', contentType: 'image/png' }).startsWith('platform/')).toBe(true);
  });

  it('is unique across calls with the same name', () => {
    const keys = new Set(Array.from({ length: 50 }, () => buildStorageKey({ tenantId: 't', originalName: 'same.png', contentType: 'image/png' })));
    expect(keys.size).toBe(50);
  });

  it('strips a hostile extension instead of trusting it', () => {
    expect(buildStorageKey({ tenantId: 't', originalName: 'x.p n g/../../evil', contentType: 'image/png' })).not.toContain('/../');
  });

  it('sorts by content type when the caller says nothing', () => {
    // The default has to be right on its own: an endpoint that forgets the
    // folder should still file its upload somewhere sensible, not in a heap.
    expect(folderFor('image/png')).toBe('images');
    expect(folderFor('application/pdf')).toBe('documents');
    expect(folderFor('text/csv')).toBe('documents');
    expect(folderFor('application/octet-stream')).toBe('files');
  });

  it('lets a caller that knows the purpose beat the content type', () => {
    // A channel logo is an image, and belongs with the logos.
    const key = buildStorageKey({ tenantId: 'tenant-1', originalName: 'etv-logo.png', contentType: 'image/png', folder: 'logos' });

    expect(key.startsWith('tenant-1/logos/')).toBe(true);
  });
});

describe('unconfigured storage', () => {
  it('reports itself unconfigured', () => {
    expect(createUnconfiguredStorage().configured).toBe(false);
  });

  it.each([
    ['createUploadUrl', async (s: StorageProvider) => s.createUploadUrl('k', 'image/png', 60)],
    ['createDownloadUrl', async (s: StorageProvider) => s.createDownloadUrl('k', 60)],
    ['head', async (s: StorageProvider) => s.head('k')],
    ['put', async (s: StorageProvider) => s.put({ key: 'k', body: 'x', contentType: 'text/plain' })],
    ['remove', async (s: StorageProvider) => s.remove('k')],
  ])('%s fails naming the missing variables', async (_name, call) => {
    const storage = createUnconfiguredStorage();

    await expect(call(storage)).rejects.toMatchObject({
      code: ERROR_CODES.STORAGE_NOT_CONFIGURED,
      statusCode: 503,
    });
    await expect(call(storage)).rejects.toThrow(/R2_ACCOUNT_ID/);
  });
});

describe('provider contract', () => {
  it('treats a missing object as an answer, not a failure', async () => {
    const provider = fakeProvider({ head: async () => null });
    await expect(provider.head('missing')).resolves.toBeNull();
  });

  it('signs upload and download URLs for the given key', async () => {
    const provider = fakeProvider();
    const spy = vi.spyOn(provider, 'createUploadUrl');

    await provider.createUploadUrl('a/b/c.png', 'image/png', 900);

    expect(spy).toHaveBeenCalledWith('a/b/c.png', 'image/png', 900);
  });
});

describe('storage service deduplication and lifecycle', () => {
  const { db, close } = createTestDb();
  const createdUserFileIds: string[] = [];
  const createdFileIds: string[] = [];
  let tenantAId: string;
  let tenantBId: string;

  beforeAll(async () => {
    const [t1] = await db.insert(tenants).values({ code: `T${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Storage Test Tenant A' }).returning();
    const [t2] = await db.insert(tenants).values({ code: `T${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Storage Test Tenant B' }).returning();
    tenantAId = t1!.id;
    tenantBId = t2!.id;
  });

  afterAll(async () => {
    if (createdUserFileIds.length > 0) {
      await db.delete(userFiles).where(inArray(userFiles.id, createdUserFileIds));
    }
    if (createdFileIds.length > 0) {
      await db.delete(files).where(inArray(files.id, createdFileIds));
    }
    if (tenantAId && tenantBId) {
      await db.delete(tenants).where(inArray(tenants.id, [tenantAId, tenantBId]));
    }
    await close();
  });

  it('uploads a new file and confirms it as ready', async () => {
    const checksum = `sha256-${randomUUID()}`;
    const provider = fakeProvider({
      head: async () => ({ sizeBytes: 1024, contentType: 'image/png', checksum }),
    });

    const service = new StorageService(db, {
      provider,
      uploadUrlTtlSeconds: 900,
      downloadUrlTtlSeconds: 900,
      maxUploadBytes: 5 * 1024 * 1024,
      allowedContentTypes: ['image/png'],
    });

    const tenantId = tenantAId;
    const res = await service.requestUpload({
      tenantId,
      uploadedBy: null,
      originalName: 'avatar.png',
      contentType: 'image/png',
      sizeBytes: 1024,
    });

    createdUserFileIds.push(res.userFile.id);
    createdFileIds.push(res.file.id);

    expect(res.deduplicated).toBe(false);
    if (!res.deduplicated) {
      expect(res.uploadUrl).toBeDefined();
    }
    expect(res.userFile.originalName).toBe('avatar.png');
    expect(res.userFile.fileId).toBe(res.file.id);

    const confirmed = await service.confirmUpload(res.userFile.id, tenantId);
    expect(confirmed.file.status).toBe('ready');
    expect(confirmed.file.checksum).toBe(checksum);
  });

  it('immediately deduplicates when checksum matches existing ready file', async () => {
    const checksum = `sha256-${randomUUID()}`;
    const provider = fakeProvider();
    const service = new StorageService(db, {
      provider,
      uploadUrlTtlSeconds: 900,
      downloadUrlTtlSeconds: 900,
      maxUploadBytes: 5 * 1024 * 1024,
      allowedContentTypes: ['image/png'],
    });

    const t1 = tenantAId;
    const first = await service.requestUpload({
      tenantId: t1,
      uploadedBy: null,
      originalName: 'original.png',
      contentType: 'image/png',
      checksum,
    });
    createdUserFileIds.push(first.userFile.id);
    createdFileIds.push(first.file.id);

    const confirmedFirst = await service.confirmUpload(first.userFile.id, t1);
    expect(confirmedFirst.file.status).toBe('ready');

    const t2 = tenantBId;
    const createUploadUrlSpy = vi.spyOn(provider, 'createUploadUrl');

    const second = await service.requestUpload({
      tenantId: t2,
      uploadedBy: null,
      originalName: 'duplicate_copy.png',
      contentType: 'image/png',
      checksum,
    });
    createdUserFileIds.push(second.userFile.id);

    expect(second.deduplicated).toBe(true);
    expect(second.userFile.originalName).toBe('duplicate_copy.png');
    expect(second.userFile.fileId).toBe(first.file.id);
    expect(second.file.id).toBe(first.file.id);
    expect(createUploadUrlSpy).not.toHaveBeenCalled();
  });

  it('deduplicates concurrently confirmed files and deletes redundant storage object', async () => {
    const checksum = `sha256-${randomUUID()}`;
    const removeSpy = vi.fn(async () => {});
    const provider = fakeProvider({
      head: async () => ({ sizeBytes: 2048, contentType: 'image/png', checksum }),
      remove: removeSpy,
    });

    const service = new StorageService(db, {
      provider,
      uploadUrlTtlSeconds: 900,
      downloadUrlTtlSeconds: 900,
      maxUploadBytes: 5 * 1024 * 1024,
      allowedContentTypes: ['image/png'],
    });

    const t1 = tenantAId;
    const t2 = tenantBId;

    const upload1 = await service.requestUpload({
      tenantId: t1,
      uploadedBy: null,
      originalName: 'file1.png',
      contentType: 'image/png',
    });
    const upload2 = await service.requestUpload({
      tenantId: t2,
      uploadedBy: null,
      originalName: 'file2.png',
      contentType: 'image/png',
    });

    createdUserFileIds.push(upload1.userFile.id, upload2.userFile.id);
    createdFileIds.push(upload1.file.id, upload2.file.id);

    const confirmed1 = await service.confirmUpload(upload1.userFile.id, t1);
    expect(confirmed1.file.status).toBe('ready');

    const confirmed2 = await service.confirmUpload(upload2.userFile.id, t2);

    expect(confirmed2.userFile.fileId).toBe(confirmed1.file.id);
    expect(confirmed2.file.id).toBe(confirmed1.file.id);

    expect(removeSpy).toHaveBeenCalledWith(upload2.file.storageKey);
  });

  it('keeps physical file in storage when one of multiple user references is removed', async () => {
    const checksum = `sha256-${randomUUID()}`;
    const removeSpy = vi.fn(async () => {});
    const provider = fakeProvider({
      head: async () => ({ sizeBytes: 500, contentType: 'image/png', checksum }),
      remove: removeSpy,
    });

    const service = new StorageService(db, {
      provider,
      uploadUrlTtlSeconds: 900,
      downloadUrlTtlSeconds: 900,
      maxUploadBytes: 5 * 1024 * 1024,
      allowedContentTypes: ['image/png'],
    });

    const t1 = tenantAId;
    const t2 = tenantBId;

    const u1 = await service.requestUpload({
      tenantId: t1,
      uploadedBy: null,
      originalName: 'first.png',
      contentType: 'image/png',
      checksum,
    });
    createdUserFileIds.push(u1.userFile.id);
    createdFileIds.push(u1.file.id);
    await service.confirmUpload(u1.userFile.id, t1);

    const u2 = await service.requestUpload({
      tenantId: t2,
      uploadedBy: null,
      originalName: 'second.png',
      contentType: 'image/png',
      checksum,
    });
    createdUserFileIds.push(u2.userFile.id);

    await service.remove(u1.userFile.id, t1);
    expect(removeSpy).not.toHaveBeenCalled();

    await service.remove(u2.userFile.id, t2);
    expect(removeSpy).not.toHaveBeenCalled();

    const report = await service.verifyAndCleanupStorage({ gracePeriodMinutes: 0 });
    expect(report.orphanedFilesCleaned).toBeGreaterThanOrEqual(1);
    expect(removeSpy).toHaveBeenCalledWith(u1.file.storageKey);
  });

  describe('uploadWithLocalStaging', () => {
    it('stages to local disk, computes sha256, puts to provider, and unlinks temp file', async () => {
      const putSpy = vi.fn(async () => {});
      const unlinkSpy = vi.spyOn(fs.promises, 'unlink');
      const provider = fakeProvider({ put: putSpy });

      const service = new StorageService(db, {
        provider,
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        maxUploadBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/png'],
      });

      const payload = Buffer.from('staged-upload-content-123');
      const expectedChecksum = createHash('sha256').update(payload).digest('hex');

      const result = await service.uploadWithLocalStaging({
        tenantId: tenantAId,
        uploadedBy: null,
        originalName: 'staged.png',
        contentType: 'image/png',
        stream: Readable.from(payload),
      });

      createdUserFileIds.push(result.userFile.id);
      createdFileIds.push(result.file.id);

      expect(result.deduplicated).toBe(false);
      expect(result.file.status).toBe('ready');
      expect(result.file.checksum).toBe(expectedChecksum);
      expect(result.file.sizeBytes).toBe(payload.length);
      expect(result.userFile.originalName).toBe('staged.png');
      expect(result.userFile.fileId).toBe(result.file.id);

      expect(putSpy).toHaveBeenCalledTimes(1);
      expect(putSpy).toHaveBeenCalledWith(expect.objectContaining({
        key: result.file.storageKey,
        body: payload,
        contentType: 'image/png',
      }));

      expect(unlinkSpy).toHaveBeenCalled();
    });

    it('deduplicates identical content without re-uploading bytes to provider', async () => {
      const putSpy = vi.fn(async () => {});
      const provider = fakeProvider({ put: putSpy });

      const service = new StorageService(db, {
        provider,
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        maxUploadBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/png'],
      });

      const payload = Buffer.from(`unique-content-${randomUUID()}`);

      const first = await service.uploadWithLocalStaging({
        tenantId: tenantAId,
        uploadedBy: null,
        originalName: 'tenant_a.png',
        contentType: 'image/png',
        stream: Readable.from(payload),
      });

      createdUserFileIds.push(first.userFile.id);
      createdFileIds.push(first.file.id);
      expect(first.deduplicated).toBe(false);
      expect(putSpy).toHaveBeenCalledTimes(1);

      const second = await service.uploadWithLocalStaging({
        tenantId: tenantBId,
        uploadedBy: null,
        originalName: 'tenant_b_copy.png',
        contentType: 'image/png',
        stream: Readable.from(payload),
      });

      createdUserFileIds.push(second.userFile.id);
      expect(second.deduplicated).toBe(true);
      expect(second.file.id).toBe(first.file.id);
      expect(second.userFile.fileId).toBe(first.file.id);
      expect(second.userFile.tenantId).toBe(tenantBId);
      expect(second.userFile.originalName).toBe('tenant_b_copy.png');
      expect(putSpy).toHaveBeenCalledTimes(1);
    });

    it('rejects disallowed content types before reading stream', async () => {
      const service = new StorageService(db, {
        provider: fakeProvider(),
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        maxUploadBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/png'],
      });

      await expect(service.uploadWithLocalStaging({
        tenantId: tenantAId,
        uploadedBy: null,
        originalName: 'hack.exe',
        contentType: 'application/x-msdownload',
        stream: Readable.from(Buffer.from('not an image')),
      })).rejects.toMatchObject({
        code: ERROR_CODES.STORAGE_TYPE_NOT_ALLOWED,
        statusCode: 400,
      });
    });
  });

  describe('verifyAndCleanupStorage', () => {
    it('preserves in-flight pending uploads created within grace period', async () => {
      const service = new StorageService(db, {
        provider: fakeProvider(),
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        maxUploadBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/png'],
      });

      const fresh = await service.requestUpload({
        tenantId: tenantAId,
        uploadedBy: null,
        originalName: 'in_flight.png',
        contentType: 'image/png',
      });
      createdUserFileIds.push(fresh.userFile.id);
      createdFileIds.push(fresh.file.id);

      const report = await service.verifyAndCleanupStorage({ gracePeriodMinutes: 120 });

      expect(report.inFlightPendingPreserved).toBeGreaterThanOrEqual(1);

      const { file } = await service.findOwned(fresh.userFile.id, tenantAId);
      expect(file.status).toBe('pending');
      expect(file.deletedAt).toBeNull();
    });

    it('flags missing storage objects as failed during integrity verification', async () => {
      const headSpy = vi.fn(async () => null);
      const provider = fakeProvider({ head: headSpy });

      const service = new StorageService(db, {
        provider,
        uploadUrlTtlSeconds: 900,
        downloadUrlTtlSeconds: 900,
        maxUploadBytes: 5 * 1024 * 1024,
        allowedContentTypes: ['image/png'],
      });

      const res = await service.uploadWithLocalStaging({
        tenantId: tenantAId,
        uploadedBy: null,
        originalName: 'missing_check.png',
        contentType: 'image/png',
        stream: Readable.from(Buffer.from('some content')),
      });
      createdUserFileIds.push(res.userFile.id);
      createdFileIds.push(res.file.id);

      await db.update(files).set({ createdAt: new Date(Date.now() - 5000) }).where(eq(files.id, res.file.id));

      const report = await service.verifyAndCleanupStorage({ gracePeriodMinutes: 0, verifyStorageIntegrity: true });

      expect(report.missingObjectsFlagged).toBeGreaterThanOrEqual(1);

      const { file } = await service.findOwned(res.userFile.id, tenantAId);
      expect(file.status).toBe('failed');
    });
  });
});
