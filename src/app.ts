import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autoload from '@fastify/autoload';
import underPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import { Type } from 'typebox';
import { API_PREFIX, API_VERSION } from '@/config/constants';
import { env, isProduction, isTest } from '@/config/env';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Builds the application without listening.
 *
 * `server.ts` calls this and then listens; tests call it and use `inject()`,
 * so an end-to-end test needs no socket and no free port (AGENTS.md §10).
 */
export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(isProduction || isTest
        ? {}
        : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
      // Tokens and passwords must never reach a log line.
      redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.refreshToken'],
    },
    // Only set when true: merely naming this option emits a Fastify 6
    // deprecation warning on every boot, and its replacement takes a class.
    ...(isTest ? { disableRequestLogging: true } : {}),
    trustProxy: true,
    ajv: {
      customOptions: {
        // A request carrying a field the schema does not declare is a client
        // bug, and silently dropping it hides the bug until it matters.
        removeAdditional: false,
        allErrors: true,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(autoload, {
    dir: path.join(here, 'plugins'),
    // Loaded in dependency order by fastify-plugin's `name`, not by filename.
    encapsulate: false,
    ignorePattern: /\.test\.ts$/,
  });

  await app.register(underPressure, {
    exposeStatusRoute: {
      url: '/health',
      // A cached health check reports a database that is already gone.
      routeOpts: { logLevel: 'warn', config: { cache: false } },
    },
    healthCheck: async () => {
      // A health check that does not touch the database reports "ok" while
      // every request 500s.
      await app.db.execute('select 1');
      return true;
    },
    healthCheckInterval: 10_000,
  });

  // Duplicated under the prefix on purpose: probes want an unversioned
  // `/health` that survives a v2, but a client only knows `baseUrl`.
  // `isUnderPressure()` reads the cached 10s check — no query per poll.
  app.get(`${API_PREFIX}/health`, {
    logLevel: 'warn',
    config: { cache: false },
    schema: {
      tags: ['health'],
      summary: 'Service health, under the API version prefix',
      response: {
        200: Type.Object({
          status: Type.Literal('ok'),
          version: Type.String(),
        }),
        503: Type.Object({
          status: Type.Literal('unavailable'),
          version: Type.String(),
        }),
      },
      security: [],
    },
  }, async (_request, reply) => {
    if (app.isUnderPressure())
      return reply.status(503).send({ status: 'unavailable' as const, version: API_VERSION });

    return reply.status(200).send({ status: 'ok' as const, version: API_VERSION });
  });

  await app.register(autoload, {
    dir: path.join(here, 'modules'),
    matchFilter: /\.routes\.(?:ts|js)$/,
    dirNameRoutePrefix: false,
    // A module's `index.ts` is its public surface (§3), not a Fastify plugin.
    // Autoload's default treats an index file as THE module for its directory
    // and skips every sibling, which silently registers no routes at all.
    indexPattern: /^__never_matches__$/,
    options: { prefix: API_PREFIX },
    ignorePattern: /\.test\.(?:ts|js)$/,
  });

  return app;
}

export type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
