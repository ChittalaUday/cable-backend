import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import autoload from '@fastify/autoload';
import underPressure from '@fastify/under-pressure';
import Fastify from 'fastify';
import { Type } from 'typebox';
import { API_PREFIX, API_VERSION } from '@/config/constants';
import { isTest } from '@/config/env';
import { createLogger } from '@/shared/logging/logger';

const here = path.dirname(fileURLToPath(import.meta.url));

export interface RouteRecord { method: string | string[]; url: string }

declare module 'fastify' {
  interface FastifyInstance {
    routeTable: RouteRecord[];
  }
}

export async function buildApp() {
  const app = Fastify({
    loggerInstance: createLogger('api'),
    ...(isTest ? { disableRequestLogging: true } : {}),
    trustProxy: true,
    ajv: {
      customOptions: {
        removeAdditional: false,
        allErrors: true,
      },
    },
  }).withTypeProvider<TypeBoxTypeProvider>();

  /**
   * Every route this app registers, for the audit-coverage check in
   * `modules/audit/audited-routes.ts`. Declared before the autoloads because
   * `onRoute` only fires for routes added after the hook.
   */
  const routeTable: RouteRecord[] = [];
  app.decorate('routeTable', routeTable);
  app.addHook('onRoute', (route) => {
    routeTable.push({ method: route.method, url: route.url });
  });

  await app.register(autoload, {
    dir: path.join(here, 'plugins'),
    encapsulate: false,
    ignorePattern: /\.test\.ts$/,
  });

  await app.register(underPressure, {
    exposeStatusRoute: {
      url: '/health',
      routeOpts: { logLevel: 'warn', config: { cache: false, public: true } },
    },
    healthCheck: async () => {
      await app.db.execute('select 1');
      return true;
    },
    healthCheckInterval: 10_000,
  });

  app.get(`${API_PREFIX}/health`, {
    logLevel: 'warn',
    config: { cache: false, public: true },
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
    indexPattern: /^__never_matches__$/,
    options: { prefix: API_PREFIX },
    ignorePattern: /\.test\.(?:ts|js)$/,
  });

  return app;
}

export type BuiltApp = Awaited<ReturnType<typeof buildApp>>;
