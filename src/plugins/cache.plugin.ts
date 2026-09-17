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
  /** Namespace this route's entries live in. A write invalidates by tag. */
  tag: string;
  /**
   * `user` (the default) when the body is filtered by the caller's location
   * scope — which is every list that calls `locationScopeFor`. `tenant` only
   * when the handler reads nothing off `access` but `tenantId`.
   */
  scope?: 'tenant' | 'user';
}

declare module 'fastify' {
  interface FastifyInstance {
    cache: CacheService;
    /** Empties this backend's keyspace and answers how many keys went. */
    clearCache: () => Promise<number>;
  }

  interface FastifyContextConfig {
    /** Opt this GET into the response cache. Absent means never cached. */
    cache?: RouteCache;
    /** Tags this write drops on a 2xx. */
    invalidates?: readonly string[];
  }
}

/**
 * Every list filters by the caller's granted nodes, so the key carries who is
 * asking *and* what they were granted: re-scoping a staff member changes the
 * fingerprint, and their old rows are unreachable without any write having to
 * name every tag they might have touched.
 */
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

  // `request.access` is only set once `requirePermission` has run; without it
  // there is no caller to key on, so nothing is cached.
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

    // Reconnect storms would otherwise crash the process on an unhandled 'error'.
    redis.on('error', () => {});

    await redis.connect().catch((error: unknown) => {
      app.log.warn(`Redis unreachable at boot: ${error instanceof Error ? error.message : String(error)}`);
    });

    const cache = new CacheService(redis, {
      prefix: env.CACHE_PREFIX,
      ttlSeconds: env.CACHE_TTL_SECONDS,
    });

    // Called from `server.ts`, not here: `buildApp()` also runs for `verify.ts`
    // and for every test file, and none of those should empty the cache a
    // running server is using.
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

    // The lookup is appended to the route's own preHandler chain, so it runs
    // *after* `requirePermission` — a caller who lost the permission gets the
    // 403, not the body someone cached while they still had it.
    app.addHook('onRoute', (route) => {
      if (route.config?.cache === undefined || route.method !== 'GET')
        return;

      const existing = route.preHandler === undefined
        ? []
        : Array.isArray(route.preHandler) ? route.preHandler : [route.preHandler];

      route.preHandler = [...existing, lookup];
    });

    // Storing has to see the JSON string, so it sits on an instance-level
    // onSend: route-level hooks run after these, and by then compress has
    // turned the payload into a stream.
    app.addHook('onSend', async (request, reply, payload) => {
      if (reply.getHeader('x-cache') === 'HIT')
        return payload;

      const ok = reply.statusCode >= 200 && reply.statusCode < 300;

      const invalidates = request.routeOptions.config.invalidates;
      if (invalidates !== undefined && ok) {
        await cache.invalidate(request.tenantId ?? null, invalidates).catch(() => {});
        return payload;
      }

      // 200 only — an error body is never worth five minutes.
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

  // Tenant data must never land in a shared proxy; `max-age=0` still lets the
  // client revalidate with If-None-Match, which is what makes the ETag pay off.
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

  // Order matters: both hook onSend, so they must register after the hooks
  // above — compress replaces the payload with a stream, and anything that
  // needs the raw JSON (the cache write, the ETag) has to run first.
  await app.register(etag, { weak: true });
  await app.register(compress, { threshold: 1024 });
}, { name: 'cache', dependencies: ['db', 'request-context'] });
