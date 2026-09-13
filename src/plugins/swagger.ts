import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fp from 'fastify-plugin';
import { isProduction } from '@/config/env';

/**
 * OpenAPI generated from the route schemas (AGENTS.md §2). Never hand-written —
 * a hand-maintained spec is a spec that lies within a week.
 */
export default fp(async (app) => {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Satya Cable & Broadband API',
        description: 'Multi-tenant operations API. See AGENTS.md for the rules this service follows.',
        version: '1.0.0',
      },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  // Docs are for developers, not the internet.
  if (!isProduction) {
    await app.register(swaggerUi, {
      routePrefix: '/docs',
      uiConfig: { docExpansion: 'list', deepLinking: true },
    });
  }
}, { name: 'swagger' });
