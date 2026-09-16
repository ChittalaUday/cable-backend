import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { csv, env, isProduction } from '@/config/env';
import { ERROR_CODES } from '@/shared/errors';

export default fp(async (app) => {
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
}, { name: 'security' });
