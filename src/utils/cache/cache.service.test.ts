import process from 'node:process';
import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CacheService } from './cache.service';

const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/3', { lazyConnect: true });
const cache = new CacheService(redis, { prefix: 'cabletest:', ttlSeconds: 300 });

beforeEach(async () => {
  await redis.connect().catch(() => {});
  await cache.clear();
});

afterAll(async () => {
  await cache.clear();
  await redis.quit();
});

function parts(over: Partial<Parameters<CacheService['get']>[0]> = {}) {
  return {
    tag: 'customers',
    url: '/api/v1/customers?page=1',
    tenantId: 'tenant-a',
    scopeId: 'user-1',
    ...over,
  };
}

describe('cacheService', () => {
  it('stores and returns a payload', async () => {
    await cache.set(parts(), '{"items":[]}');
    expect(await cache.get(parts())).toBe('{"items":[]}');
  });

  it('applies the TTL', async () => {
    await cache.set(parts(), 'x');
    const keys = await redis.keys('cabletest:customers:v*');
    expect(keys).toHaveLength(1);
    expect(await redis.ttl(keys[0]!)).toBeGreaterThan(290);
  });

  it('misses for a different caller', async () => {
    await cache.set(parts(), 'user-1 rows');
    expect(await cache.get(parts({ scopeId: 'user-2' }))).toBeNull();
  });

  it('misses for a different tenant', async () => {
    await cache.set(parts(), 'tenant-a rows');
    expect(await cache.get(parts({ tenantId: 'tenant-b' }))).toBeNull();
  });

  it('misses for a different url', async () => {
    await cache.set(parts(), 'page 1');
    expect(await cache.get(parts({ url: '/api/v1/customers?page=2' }))).toBeNull();
  });

  it('drops every entry carrying the invalidated tag', async () => {
    await cache.set(parts(), 'list');
    await cache.set(parts({ url: '/api/v1/customers/abc' }), 'one');

    await cache.invalidate('tenant-a', ['customers']);

    expect(await cache.get(parts())).toBeNull();
    expect(await cache.get(parts({ url: '/api/v1/customers/abc' }))).toBeNull();
  });

  it('leaves the tenant\'s other tags alone', async () => {
    await cache.set(parts({ tag: 'packages', url: '/api/v1/packages' }), 'packages');
    await cache.invalidate('tenant-a', ['customers']);

    expect(await cache.get(parts({ tag: 'packages', url: '/api/v1/packages' }))).toBe('packages');
  });

  it('drops several tags in one call', async () => {
    await cache.set(parts(), 'customers');
    await cache.set(parts({ tag: 'packages', url: '/api/v1/packages' }), 'packages');

    await cache.invalidate('tenant-a', ['customers', 'packages']);

    expect(await cache.get(parts())).toBeNull();
    expect(await cache.get(parts({ tag: 'packages', url: '/api/v1/packages' }))).toBeNull();
  });

  it('leaves other tenants alone', async () => {
    await cache.set(parts({ tenantId: 'tenant-b' }), 'tenant-b rows');
    await cache.invalidate('tenant-a', ['customers']);

    expect(await cache.get(parts({ tenantId: 'tenant-b' }))).toBe('tenant-b rows');
  });

  it('shares one entry when the route is tenant-scoped', async () => {
    await cache.set(parts({ scopeId: 'all' }), 'shared');
    expect(await cache.get(parts({ scopeId: 'all' }))).toBe('shared');
  });

  it('survives repeated invalidation without leaking the version counter', async () => {
    for (let i = 0; i < 5; i += 1) {
      await cache.set(parts(), `gen-${i}`);
      await cache.invalidate('tenant-a', ['customers']);
    }

    await cache.set(parts(), 'final');
    expect(await cache.get(parts())).toBe('final');
  });
  it('clears only this backend\'s keys, and counts them', async () => {
    await redis.set('otherproject:keep', 'theirs');
    await redis.set('cabletestX:decoy', 'theirs too');
    await cache.set(parts(), 'ours');
    await cache.set(parts({ tag: 'packages', url: '/api/v1/packages' }), 'ours too');

    expect(await cache.clear()).toBe(2);

    expect(await cache.get(parts())).toBeNull();
    expect(await redis.get('otherproject:keep')).toBe('theirs');
    expect(await redis.get('cabletestX:decoy')).toBe('theirs too');

    await redis.del('otherproject:keep', 'cabletestX:decoy');
  });
});
