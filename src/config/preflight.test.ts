import type { BuiltApp } from '@/app';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runPreflight } from './preflight';

type MockApp = BuiltApp & {
  cache: {
    ping: ReturnType<typeof vi.fn>;
  };
};

describe('runPreflight', () => {
  let mockApp: MockApp;

  beforeEach(() => {
    mockApp = {
      db: {
        execute: vi.fn().mockImplementation(async (query: { strings: string[] }) => {
          const sql = query.strings.join('');
          if (sql.includes('select 1'))
            return { rows: [{ '?column?': 1 }] };
          if (sql.includes('pg_namespace')) {
            return {
              rows: ['tenancy', 'auth', 'iam', 'crm', 'notify', 'media', 'analytics', 'audit'].map(nspname => ({ nspname })),
            };
          }
          if (sql.includes('__drizzle_migrations'))
            return { rows: [{ count: '5' }] };
          return { rows: [] };
        }),
      },
      cache: {
        ping: vi.fn().mockResolvedValue('PONG'),
      },
      messaging: {
        knownChannels: ['whatsapp', 'push', 'sms', 'email'],
        supports: vi.fn((ch: string) => ch === 'whatsapp'),
        providerFor: vi.fn(() => 'openwa'),
      },
      storage: {
        configured: true,
        bucket: 'test-bucket',
        ping: vi.fn().mockResolvedValue(undefined),
      },
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
    } as unknown as MockApp;
  });

  it('reports ok when storage ping succeeds', async () => {
    const result = await runPreflight(mockApp);
    const storageCheck = result.checks.find(c => c.name === 'object storage');

    expect(storageCheck?.status).toBe('ok');
    expect(storageCheck?.detail).toContain('bucket "test-bucket" connected');
  });

  it('reports degraded when storage ping fails with AccessDenied', async () => {
    (mockApp.storage.ping as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Access Denied'));

    const result = await runPreflight(mockApp);
    const storageCheck = result.checks.find(c => c.name === 'object storage');

    expect(storageCheck?.status).toBe('warn');
    expect(storageCheck?.detail).toContain('configured for "test-bucket" but unreachable: Access Denied');
  });

  it('reports degraded when cache ping fails', async () => {
    mockApp.cache.ping.mockRejectedValue(new Error('Connection refused'));

    const result = await runPreflight(mockApp);
    const cacheCheck = result.checks.find(c => c.name === 'cache');

    expect(cacheCheck?.status).toBe('warn');
    expect(cacheCheck?.detail).toContain('redis unreachable: Connection refused');
  });

  it('reports fail when database is unreachable', async () => {
    (mockApp.db.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Connection terminated'));

    const result = await runPreflight(mockApp);
    const dbCheck = result.checks.find(c => c.name === 'database');

    expect(dbCheck?.status).toBe('fail');
    expect(result.failed).toBe(true);
  });
});
