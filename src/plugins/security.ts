import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { csv, env, isProduction } from '@/config/env';

export default fp(async (app) => {
  await app.register(sensible);

  // The API serves JSON only; the CSP that matters is the one on the docs page,
  // which is not served in production.
  await app.register(helmet, isProduction ? {} : { contentSecurityPolicy: false });

  const origins = csv(env.CORS_ORIGINS);

  if (isProduction && origins.length === 0)
    throw new Error('CORS_ORIGINS must be set in production — a wildcard origin is not acceptable.');

  await app.register(cors, {
    origin: origins.length > 0 ? origins : true,
    credentials: true,
    // Everything the client is required to send (§4.4, §4.6).
    allowedHeaders: [
      'content-type',
      'authorization',
      'x-tenant-id',
      'x-device-id',
      'x-platform',
      'x-app-version',
      'x-os-version',
      'x-device-model',
    ],
  });

  await app.register(rateLimit, {
    max: env.RATE_LIMIT_MAX,
    timeWindow: env.RATE_LIMIT_WINDOW,
    // Rate limit per authenticated user where possible, falling back to IP, so
    // one busy office NAT does not throttle every tenant behind it.
    keyGenerator: request => request.headers.authorization ?? request.ip,
  });
}, { name: 'security' });
