import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PermissionKey } from '@/security/permissions';
import { readdir, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { eq, sql } from 'drizzle-orm';
import metricsPlugin from 'fastify-metrics';
import fp from 'fastify-plugin';
import { Type } from 'typebox';
import { API_PREFIX, SYSTEM_ROLES } from '@/config/constants';
import { csv, env, exposeErrorDetail, isProduction } from '@/config/env';
import { rolePermissions } from '@/db/schema';
import { DomainError, ERROR_CODES } from '@/errors';

/**
 * Recounted at most once a minute rather than on every scrape: 30 days of
 * retention is a few thousand files, and walking them all every 15 seconds to
 * answer a gauge nobody watches that closely is not a trade worth making.
 */
const LOG_SIZE_TTL_MS = 60_000;
let logSize = { bytes: 0, at: 0 };

async function logDirectoryBytes(): Promise<number> {
  if (Date.now() - logSize.at < LOG_SIZE_TTL_MS)
    return logSize.bytes;

  const entries = await readdir(env.LOG_DIRECTORY, { recursive: true, withFileTypes: true }).catch(() => []);

  const sizes = await Promise.all(entries
    .filter(entry => entry.isFile())
    .map(async entry => stat(path.join(entry.parentPath, entry.name)).then(s => s.size).catch(() => 0)));

  logSize = { bytes: sizes.reduce((total, size) => total + size, 0), at: Date.now() };
  return logSize.bytes;
}

export const ErrorResponse = Type.Object({
  statusCode: Type.Integer(),
  error: Type.String(),
  code: Type.String(),
  message: Type.String(),
  requestId: Type.String(),
  details: Type.Optional(Type.Array(Type.Object({
    field: Type.String(),
    issue: Type.String(),
  }))),
  debug: Type.Optional(Type.Object({
    name: Type.String(),
    message: Type.String(),
    stack: Type.Optional(Type.String()),
    cause: Type.Optional(Type.String()),
  })),
}, { $id: 'ErrorResponse' });

function debugOf(error: Error): { name: string; message: string; stack?: string; cause?: string } {
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
    ...(error.cause === undefined ? {} : { cause: String(error.cause) }),
  };
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

function validationDetails(error: FastifyError): { field: string; issue: string }[] {
  return (error.validation ?? []).map(issue => ({
    field: issue.instancePath.replace(/^\//, '') || String(issue.params.missingProperty ?? ''),
    issue: issue.message ?? 'invalid',
  }));
}

const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;

function toSpecPath(url: string): string {
  const withoutPrefix = url.startsWith(API_PREFIX) ? url.slice(API_PREFIX.length) : url;
  return (withoutPrefix === '' ? '/' : withoutPrefix).replace(/:(\w+)/g, '{$1}');
}

function specForRole(
  spec: Record<string, unknown>,
  routes: readonly { method: string | string[]; url: string; permission: PermissionKey | undefined }[],
  granted: ReadonlySet<string>,
): Record<string, unknown> {
  const required = new Map<string, PermissionKey>();
  for (const route of routes) {
    if (route.permission === undefined)
      continue;

    for (const method of Array.isArray(route.method) ? route.method : [route.method])
      required.set(`${method.toLowerCase()} ${toSpecPath(route.url)}`, route.permission);
  }

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const kept: Record<string, Record<string, unknown>> = {};

  for (const [path, operations] of Object.entries(paths)) {
    const survivors: Record<string, unknown> = {};

    for (const method of METHODS) {
      if (operations[method] === undefined)
        continue;

      const key = required.get(`${method} ${path}`);
      if (key === undefined || granted.has(key))
        survivors[method] = operations[method];
    }

    if (Object.keys(survivors).length > 0)
      kept[path] = survivors;
  }

  return { ...spec, paths: kept };
}

function grantsOf(app: FastifyInstance, roleId: string): ReadonlySet<string> {
  const granted = new Set<string>();

  app.addHook('onReady', async () => {
    const rows = await app.db
      .select({ key: rolePermissions.permissionKey })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    for (const r of rows)
      granted.add(r.key);
  });

  return granted;
}

export default fp(async (app) => {
  // 1. Sensible & Security headers
  await app.register(sensible);

  await app.register(helmet, {
    global: true,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    frameguard: { action: 'deny' },
    hidePoweredBy: true,
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    contentSecurityPolicy: isProduction
      ? {
          directives: {
            defaultSrc: ['\'self\''],
            baseUri: ['\'self\''],
            fontSrc: ['\'self\'', 'https:', 'data:'],
            formAction: ['\'self\''],
            frameAncestors: ['\'none\''],
            imgSrc: ['\'self\'', 'data:', 'https:'],
            objectSrc: ['\'none\''],
            scriptSrc: ['\'self\''],
            scriptSrcAttr: ['\'none\''],
            styleSrc: ['\'self\'', 'https:', '\'unsafe-inline\''],
            upgradeInsecureRequests: [],
          },
        }
      : false,
  });

  app.addHook('onSend', async (_request, reply) => {
    reply.header(
      'permissions-policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), vr=()',
    );
  });

  // 2. CORS
  const origins = csv(env.CORS_ORIGINS);
  if (isProduction && origins.length === 0) {
    throw new Error('CORS_ORIGINS must be set in production — a wildcard origin is not acceptable.');
  }

  await app.register(cors, {
    origin: origins.length > 0 ? origins : true,
    credentials: true,
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-tenant-id',
      'x-device-id',
      'x-platform',
      'x-app-version',
      'x-os-version',
      'x-device-model',
      'x-request-id',
    ],
    exposedHeaders: [
      'content-range',
      'x-content-range',
      'x-request-id',
      'ratelimit-limit',
      'ratelimit-remaining',
      'ratelimit-reset',
      'retry-after',
    ],
    maxAge: 86400,
  });

  // 3. Rate Limit
  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    keyGenerator: request => request.headers.authorization ?? request.ip,
    enableDraftSpec: true,
    errorResponseBuilder: (request, context) => ({
      statusCode: 429,
      error: 'Too Many Requests',
      code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
      message: `Rate limit exceeded. Try again in ${context.after}`,
      requestId: request.id,
    }),
  });

  // 4. Metrics
  //
  // Prometheus scrapes with no credentials, and the request-context hook
  // demands a bearer token from everything that is not marked `public`. The
  // route belongs to fastify-metrics, so the only place to mark it is on the
  // way past. Anyone who can reach this port can now read route timings and
  // process stats: keep :PORT off the public interface, or let only the
  // scraper's address through to /metrics at Nginx.
  app.addHook('onRoute', (route) => {
    if (route.url === '/metrics')
      route.config = { ...route.config, public: true };
  });

  await app.register(metricsPlugin, {
    endpoint: '/metrics',
    defaultMetrics: { enabled: true },
    routeMetrics: { enabled: true },
    // prom-client's registry is module-global, so a second buildApp() in the
    // same process — which is every test file after the first — otherwise dies
    // on "a metric with the name process_cpu_seconds_total is already
    // registered". One app per process in production, so there is nothing to
    // lose by clearing.
    clearRegisterOnInit: true,
  });

  // 4b. Storage
  //
  // prom-client's defaults describe the process and nothing underneath it, and
  // the numbers that end an outage here are all storage: the volume filling,
  // the log directory eating it, and the database growing into it.
  const prom = app.metrics.client;

  const storage = [
    new prom.Gauge({
      name: 'cable_disk_bytes',
      help: 'The filesystem LOG_DIRECTORY sits on, by state.',
      labelNames: ['state'] as const,
      async collect() {
        const fs = await statfs(env.LOG_DIRECTORY).catch(() => null);
        if (fs === null)
          return;

        this.set({ state: 'total' }, fs.blocks * fs.bsize);
        this.set({ state: 'free' }, fs.bavail * fs.bsize);
        this.set({ state: 'used' }, (fs.blocks - fs.bavail) * fs.bsize);
      },
    }),

    new prom.Gauge({
      name: 'cable_log_directory_bytes',
      help: 'What this service has written to LOG_DIRECTORY and not yet aged out.',
      async collect() {
        this.set(await logDirectoryBytes());
      },
    }),

    new prom.Gauge({
      name: 'cable_database_bytes',
      help: 'pg_database_size of the database this service is connected to.',
      async collect() {
        const result = await app.db.execute<{ bytes: string }>(
          sql`SELECT pg_database_size(current_database()) bytes`,
        ).catch(() => null);

        if (result !== null)
          this.set(Number(result.rows[0]?.bytes ?? 0));
      },
    }),
  ];

  app.log.debug(`${storage.length} storage gauges added to /metrics.`);

  // 5. OpenAPI Swagger
  if (!isProduction) {
    await app.register(swagger, {
      openapi: {
        info: {
          title: 'Satya Cable & Broadband API',
          version: '1.0.0',
          description: 'Multi-tenant cable and broadband management platform.',
        },
        components: {
          securitySchemes: {
            bearerAuth: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'JWT',
            },
          },
        },
        security: [{ bearerAuth: [] }],
      },
    });

    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });

    const customerPermissions = grantsOf(app, SYSTEM_ROLES.CUSTOMER);
    app.get('/docs/customer.json', {
      schema: { hide: true },
      config: { public: true },
    }, async () => {
      const full = app.swagger();
      return specForRole(full as Record<string, unknown>, app.routeTable, customerPermissions);
    });
  }

  // 6. Error handling
  app.addSchema(ErrorResponse);

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    request.log.error({ err: error }, 'request failed');

    if (error instanceof DomainError) {
      return reply.status(error.statusCode).send({
        statusCode: error.statusCode,
        error: STATUS_TEXT[error.statusCode] ?? 'Error',
        code: error.code,
        message: error.message,
        requestId: request.id,
        ...(error.details ? { details: error.details } : {}),
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        statusCode: 400,
        error: 'Bad Request',
        code: ERROR_CODES.VALIDATION_FAILED,
        message: 'Request validation failed',
        requestId: request.id,
        details: validationDetails(error),
      });
    }

    const status = error.statusCode ?? 500;

    if (status === 429) {
      return reply.status(429).send({
        statusCode: 429,
        error: 'Too Many Requests',
        code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
        message: 'Rate limit exceeded',
        requestId: request.id,
      });
    }

    if (status === 503) {
      return reply.status(503).send({
        statusCode: 503,
        error: 'Service Unavailable',
        code: ERROR_CODES.SERVER_UNAVAILABLE,
        message: 'Service temporarily unavailable',
        requestId: request.id,
      });
    }

    if (status >= 500) {
      return reply.status(500).send({
        statusCode: 500,
        error: 'Internal Server Error',
        code: ERROR_CODES.SERVER_ERROR,
        message: exposeErrorDetail ? error.message : 'Internal server error',
        requestId: request.id,
        ...(exposeErrorDetail ? { debug: debugOf(error) } : {}),
      });
    }

    return reply.status(status).send({
      statusCode: status,
      error: STATUS_TEXT[status] ?? 'Error',
      code: error.code,
      message: error.message,
      requestId: request.id,
    });
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      statusCode: 404,
      error: 'Not Found',
      code: ERROR_CODES.RESOURCE_NOT_FOUND,
      message: `Route ${request.method} ${request.url} not found`,
      requestId: request.id,
    });
  });
}, { name: 'observability', dependencies: ['db'] });
