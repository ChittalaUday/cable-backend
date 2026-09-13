import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import fp from 'fastify-plugin';
import { csv, env, isProduction } from '@/config/env';

export default fp(async (app) => {
  await app.register(sensible);

  await app.register(helmet, isProduction ? {} : { contentSecurityPolicy: false });

  const origins = csv(env.CORS_ORIGINS);

  if (isProduction && origins.length === 0)
    throw new Error('CORS_ORIGINS must be set in production — a wildcard origin is not acceptable.');

  await app.register(cors, {
    origin: origins.length > 0 ? origins : true,
    credentials: true,
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
    keyGenerator: request => request.headers.authorization ?? request.ip,
  });
}, { name: 'security' });
