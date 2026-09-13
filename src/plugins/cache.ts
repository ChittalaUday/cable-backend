import type { FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import Redis from 'ioredis';
import { env } from '@/config/env';
import { CacheService, resourceOf } from '@/shared/cache/cache.service';

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheService;
  }

  interface FastifyContextConfig {
    cache?: false | { scope?: 'user' | 'tenant' };
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export default fp(async (app) => {
  if (!env.CACHE_ENABLED) {
    app.log.warn('Cache disabled — every read hits Postgres.');
    return;
  }

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

  app.decorate('cache', cache);
  app.addHook('onClose', async () => {
    await redis.quit();
  });

  function partsFor(request: FastifyRequest) {
    const config = request.routeOptions.config.cache;
    const tenantId = (request.headers['x-tenant-id'] as string | undefined) ?? null;

    return {
      resource: resourceOf(request.url),
      url: request.url,
      tenantId,
      userId: config !== false && config?.scope === 'tenant'
        ? null
        : (request as { session?: { sub: string } }).session?.sub ?? 'anon',
    };
  }

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.method !== 'GET' || request.routeOptions.config.cache === false)
      return;

    const hit = await cache.get(partsFor(request)).catch(() => null);
    if (hit === null)
      return;

    reply.header('x-cache', 'HIT').type('application/json').send(hit);
  });

  app.addHook('onSend', async (request: FastifyRequest, reply: FastifyReply, payload) => {
    if (reply.getHeader('x-cache') === 'HIT')
      return payload;

    const status = reply.statusCode;

    if (MUTATING.has(request.method) && status >= 200 && status < 300) {
      const { resource, tenantId } = partsFor(request);
      await cache.invalidate(resource, tenantId).catch(() => {});
      return payload;
    }

    if (request.method === 'GET' && status === 200
      && request.routeOptions.config.cache !== false
      && typeof payload === 'string') {
      reply.header('x-cache', 'MISS');
      await cache.set(partsFor(request), payload).catch(() => {});
    }

    return payload;
  });
}, { name: 'cache', dependencies: ['database'] });
