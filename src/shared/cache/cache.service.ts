import type Redis from 'ioredis';

export interface CacheConfig {
  prefix: string;
  ttlSeconds: number;
}

export interface CacheKeyParts {
  resource: string;
  url: string;
  tenantId: string | null;
  userId: string | null;
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

  async invalidate(tenantId: string | null): Promise<void> {
    await this.redis.incr(this.versionKey(tenantId));
  }

  async flushAll(): Promise<void> {
    const keys = await this.redis.keys(`${this.config.prefix}*`);
    if (keys.length > 0)
      await this.redis.del(...keys);
  }

  private versionKey(tenantId: string | null): string {
    return `${this.config.prefix}ver:${tenantId ?? 'global'}`;
  }

  private async keyFor(parts: CacheKeyParts): Promise<string> {
    const version = await this.redis.get(this.versionKey(parts.tenantId)) ?? '0';
    const scope = parts.userId ?? 'tenant';
    return `${this.config.prefix}v${version}:${parts.tenantId ?? 'global'}:${scope}:${parts.url}`;
  }
}

export function resourceOf(url: string): string {
  return url.replace(/^\/api\/v\d+\//, '').split(/[/?]/)[0] ?? 'root';
}
