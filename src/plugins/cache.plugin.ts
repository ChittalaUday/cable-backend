import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { CacheKeyParts } from '@/utils/cache/cache.service';
import { createHash } from 'node:crypto';
import compress from '@fastify/compress';
import etag from '@fastify/etag';
import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '@/config/env';
import { CacheService } from '@/utils/cache/cache.service';

export interface RouteCache {
  tag: string;
  scope?: 'tenant' | 'user';
}

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheService;
    clearCache: () => Promise<number>;
  }

  interface FastifyContextConfig {
    cache?: RouteCache;
    invalidates?: readonly string[];
  }
}

function scopeIdFor(access: RequestAccess): string {
  const grants = [
    access.roleId,
    access.teamId ?? '',
    access.isTeamLeader ? 'leader' : '',
    [...access.locationIds].sort().join(','),
  ].join('|');

  return `${access.userId}.${createHash('sha1').update(grants).digest('hex').slice(0, 12)}`;
}

function partsFor(request: FastifyRequest): CacheKeyParts | null {
  const config = request.routeOptions.config.cache;
  if (config === undefined)
    return null;

  const access = request.access as RequestAccess | undefined;
  if (access === undefined)
    return null;

  return {
    tag: config.tag,
    url: request.url,
    tenantId: request.tenantId ?? null,
    scopeId: config.scope === 'tenant' ? 'all' : scopeIdFor(access),
  };
}

export default fp(async (app) => {
  if (env.CACHE_ENABLED) {
    const redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
    });

    redis.on('error', () => {});

    await redis.connect().catch((error: unknown) => {
      app.log.warn(`Redis unreachable at boot: ${error instanceof Error ? error.message : String(error)}`);
    });

    const cache = new CacheService(redis, {
      prefix: env.CACHE_PREFIX,
      ttlSeconds: env.CACHE_TTL_SECONDS,
    });

    app.decorate('clearCache', async () => {
      const removed = await cache.clear().catch((error: unknown) => {
        app.log.warn(`Cache not cleared: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      });

      app.log.info(`Cache cleared at boot: ${removed} key(s) matching "${env.CACHE_PREFIX}*"`);
      return removed;
    });

    app.decorate('cache', cache);
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => redis.disconnect());
    });

    const lookup: preHandlerAsyncHookHandler = async (request, reply) => {
      const parts = partsFor(request);
      if (parts === null)
        return;

      const hit = await cache.get(parts).catch(() => null);
      if (hit === null)
        return;

      return reply.header('x-cache', 'HIT').type('application/json').send(hit);
    };

    app.addHook('onRoute', (route) => {
      if (route.config?.cache === undefined || route.method !== 'GET')
        return;

      const existing = route.preHandler === undefined
        ? []
        : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];

      route.preHandler = [...existing, lookup];
    });

    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.getHeader('x-cache') === 'HIT')
        return payload;

      const ok = reply.statusCode >= 200 && reply.statusCode < 300;

      const invalidates = request.routeOptions.config.invalidates;
      if (invalidates !== undefined && ok) {
        await cache.invalidate(request.tenantId ?? null, invalidates).catch(() => {});
        return payload;
      }

      if (reply.statusCode !== 200 || typeof payload !== 'string')
        return payload;

      const parts = partsFor(request);
      if (parts === null)
        return payload;

      reply.header('x-cache', 'MISS');
      await cache.set(parts, payload).catch(() => {});

      return payload;
    });
  }
  else {
    app.decorate('clearCache', async () => 0);
    app.log.warn('Cache disabled — every read hits Postgres.');
  }

  app.addHook('onSend', async (request, reply) => {
    if (reply.hasHeader('cache-control'))
      return;

    reply.header(
      'cache-control',
      request.routeOptions.config.cache === undefined
        ? 'no-store'
        : 'private, max-age=0, must-revalidate',
    );
  });

  await app.register(etag, { weak: true });
  await app.register(compress, { threshold: 1024 });
}, { name: 'cache', dependencies: ['db', 'request-context'] });
