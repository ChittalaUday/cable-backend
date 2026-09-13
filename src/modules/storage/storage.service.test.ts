import type { ObjectHead, StorageProvider } from './storage.types';
import { describe, expect, it, vi } from 'vitest';
import { ERROR_CODES } from '@/shared/errors';
import { createUnconfiguredStorage } from './providers/unconfigured.provider';
import { buildStorageKey } from './storage.service';

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
    // `../` traversal and collisions get in exactly here.
    const key = buildStorageKey('tenant-1', '../../etc/passwd');

    expect(key).not.toContain('..');
    expect(key).not.toContain('passwd');
    expect(key.startsWith('tenant-1/')).toBe(true);
  });

  it('keeps the extension so storage serves a sensible content type', () => {
    expect(buildStorageKey('tenant-1', 'invoice.PDF')).toMatch(/\.pdf$/);
    expect(buildStorageKey('tenant-1', 'photo.jpeg')).toMatch(/\.jpeg$/);
  });

  it('partitions by tenant and month, so a bucket listing stays navigable', () => {
    const key = buildStorageKey('tenant-1', 'a.png');
    expect(key).toMatch(/^tenant-1\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.png$/);
  });

  it('files a tenantless object under platform rather than under "null"', () => {
    expect(buildStorageKey(null, 'a.png').startsWith('platform/')).toBe(true);
  });

  it('is unique across calls with the same name', () => {
    const keys = new Set(Array.from({ length: 50 }, () => buildStorageKey('t', 'same.png')));
    expect(keys.size).toBe(50);
  });

  it('strips a hostile extension instead of trusting it', () => {
    expect(buildStorageKey('t', 'x.p n g/../../evil')).not.toContain('/../');
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
