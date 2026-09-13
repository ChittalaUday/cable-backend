import type Redis from 'ioredis';

export interface CacheConfig {
  prefix: string;
  ttlSeconds: number;
}

export interface CacheKeyParts {
  resource: string;
  url: string;
  tenantId: string | null;
  /** Null for a tenant-scoped entry shared by everyone in that tenant. */
  userId: string | null;
}

/**
 * Invalidation is by version counter, not by SCAN. A mutation INCRs
 * `ver:<tenant>:<resource>`, which orphans every key built from the old version
 * in one O(1) command. SCAN-and-delete is O(keyspace) and races with writes.
 */
export class CacheService {
  constructor(
    private readonly redis: Redis,
    private readonly config: CacheConfig,
  ) {}

  get ttlSeconds(): number {
    return this.config.ttlSeconds;
  }

  async ping(): Promise<void> {
    await this.redis.ping();
  }

  async get(parts: CacheKeyParts): Promise<string | null> {
    return this.redis.get(await this.keyFor(parts));
  }

  async set(parts: CacheKeyParts, payload: string): Promise<void> {
    await this.redis.set(await this.keyFor(parts), payload, 'EX', this.config.ttlSeconds);
  }

  async invalidate(resource: string, tenantId: string | null): Promise<void> {
    await this.redis.incr(this.versionKey(resource, tenantId));
  }

  /** Used by tests and by an admin flush; never on a request path. */
  async flushAll(): Promise<void> {
    const keys = await this.redis.keys(`${this.config.prefix}*`);
    if (keys.length > 0)
      await this.redis.del(...keys);
  }

  private versionKey(resource: string, tenantId: string | null): string {
    return `${this.config.prefix}ver:${tenantId ?? 'global'}:${resource}`;
  }

  private async keyFor(parts: CacheKeyParts): Promise<string> {
    // Absent counter is 0, not 1: the first INCR must produce a version that
    // differs from the default, or the first invalidation silently does nothing.
    const version = await this.redis.get(this.versionKey(parts.resource, parts.tenantId)) ?? '0';
    const scope = parts.userId ?? 'tenant';
    return `${this.config.prefix}v${version}:${parts.tenantId ?? 'global'}:${scope}:${parts.url}`;
  }
}

/** First path segment after the API prefix: `/api/v1/customers/123` → `customers`. */
export function resourceOf(url: string): string {
  return url.replace(/^\/api\/v\d+\//, '').split(/[/?]/)[0] ?? 'root';
}
