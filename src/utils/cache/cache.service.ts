import type Redis from 'ioredis';

export interface CacheConfig {
  prefix: string;
  ttlSeconds: number;
}

export interface CacheKeyParts {
  /** The route's own namespace. Only writes that name this tag drop these entries. */
  tag: string;
  /** Full path and query — two different pages of the same list are two entries. */
  url: string;
  tenantId: string | null;
  /** `all` when every member of the tenant sees the same body, otherwise the caller. */
  scopeId: string;
}

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

  /**
   * Bumping a version orphans that tag's keys instead of scanning for them —
   * they expire on their own TTL. A write to `packages` leaves `locations` alone.
   */
  async invalidate(tenantId: string | null, tags: readonly string[]): Promise<void> {
    if (tags.length === 0)
      return;

    const pipeline = this.redis.pipeline();
    for (const tag of tags)
      pipeline.incr(this.versionKey(tenantId, tag));

    await pipeline.exec();
  }

  /**
   * Drops every key this backend owns and answers how many. The instance is
   * shared with other projects, so this matches on `CACHE_PREFIX` — never
   * `FLUSHDB`, which would take their keyspaces with it — and walks with SCAN
   * rather than KEYS, which blocks the whole server while it runs.
   */
  async clear(): Promise<number> {
    let cursor = '0';
    let removed = 0;

    do {
      const [next, keys] = await this.redis.scan(cursor, 'MATCH', `${this.config.prefix}*`, 'COUNT', 500);
      cursor = next;

      if (keys.length > 0)
        removed += await this.redis.unlink(...keys);
    } while (cursor !== '0');

    return removed;
  }

  private versionKey(tenantId: string | null, tag: string): string {
    return `${this.config.prefix}ver:${tenantId ?? 'global'}:${tag}`;
  }

  private async keyFor(parts: CacheKeyParts): Promise<string> {
    const version = await this.redis.get(this.versionKey(parts.tenantId, parts.tag)) ?? '0';
    return `${this.config.prefix}${parts.tag}:v${version}:${parts.tenantId ?? 'global'}:${parts.scopeId}:${parts.url}`;
  }
}
