import type Redis from 'ioredis';

export interface CacheConfig {
  prefix: string;
  ttlSeconds: number;
}

export interface CacheKeyParts {
  tag: string;
  url: string;
  tenantId: string | null;
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

  async invalidate(tenantId: string | null, tags: readonly string[]): Promise<void> {
    if (tags.length === 0)
      return;

    const pipeline = this.redis.pipeline();
    for (const tag of tags)
      pipeline.incr(this.versionKey(tenantId, tag));

    await pipeline.exec();
  }

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
