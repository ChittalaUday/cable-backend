import process from 'node:process';
import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CacheService, resourceOf } from './cache.service';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', { lazyConnect: true });
const cache = new CacheService(redis, { prefix: 'cabletest:', ttlSeconds: 300 });

beforeEach(async () => {
  await redis.connect().catch(() => {});
  await cache.flushAll();
});

afterAll(async () => {
  await cache.flushAll();
  await redis.quit();
});

function parts(over: Partial<Parameters<CacheService['get']>[0]> = {}) {
  return {
    resource: 'customers',
    url: '/api/v1/customers?page=1',
    tenantId: 'tenant-a',
    userId: 'user-1',
    ...over,
  };
}

describe('resourceOf', () => {
  it.each([
    ['/api/v1/customers', 'customers'],
    ['/api/v1/customers/abc-123', 'customers'],
    ['/api/v1/customers?page=2', 'customers'],
    ['/api/v2/packages/1/plans', 'packages'],
  ])('%j → %j', (url, expected) => {
    expect(resourceOf(url)).toBe(expected);
  });
});

describe('cacheService', () => {
  it('stores and returns a payload', async () => {
    await cache.set(parts(), '{"items":[]}');
    expect(await cache.get(parts())).toBe('{"items":[]}');
  });

  it('applies the TTL', async () => {
    await cache.set(parts(), 'x');
    const keys = await redis.keys('cabletest:v*');
    expect(keys).toHaveLength(1);
    expect(await redis.ttl(keys[0]!)).toBeGreaterThan(290);
  });

  it('misses for a different user', async () => {
    await cache.set(parts(), 'user-1 rows');
    expect(await cache.get(parts({ userId: 'user-2' }))).toBeNull();
  });

  it('misses for a different tenant', async () => {
    await cache.set(parts(), 'tenant-a rows');
    expect(await cache.get(parts({ tenantId: 'tenant-b' }))).toBeNull();
  });

  it('misses for a different url', async () => {
    await cache.set(parts(), 'page 1');
    expect(await cache.get(parts({ url: '/api/v1/customers?page=2' }))).toBeNull();
  });

  it('invalidates every key for a resource in one command', async () => {
    await cache.set(parts(), 'list');
    await cache.set(parts({ url: '/api/v1/customers/abc' }), 'one');

    await cache.invalidate('customers', 'tenant-a');

    expect(await cache.get(parts())).toBeNull();
    expect(await cache.get(parts({ url: '/api/v1/customers/abc' }))).toBeNull();
  });

  it('leaves other resources alone', async () => {
    await cache.set(parts({ resource: 'packages', url: '/api/v1/packages' }), 'packages');
    await cache.invalidate('customers', 'tenant-a');

    expect(await cache.get(parts({ resource: 'packages', url: '/api/v1/packages' }))).toBe('packages');
  });

  it('leaves other tenants alone', async () => {
    await cache.set(parts({ tenantId: 'tenant-b' }), 'tenant-b rows');
    await cache.invalidate('customers', 'tenant-a');

    expect(await cache.get(parts({ tenantId: 'tenant-b' }))).toBe('tenant-b rows');
  });

  it('shares one entry when scoped to a tenant', async () => {
    await cache.set(parts({ userId: null }), 'shared');
    expect(await cache.get(parts({ userId: null }))).toBe('shared');
  });

  it('survives repeated invalidation without leaking the version counter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await cache.set(parts(), `gen-${i}`);
      await cache.invalidate('customers', 'tenant-a');
    }

    await cache.set(parts(), 'final');
    expect(await cache.get(parts())).toBe('final');
  });
});
