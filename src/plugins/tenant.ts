import type { FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { TENANT_HEADER } from '@/config/constants';
import { ERROR_CODES } from '@/shared/errors';
import { forbidden } from '@/shared/errors/domain-error';

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    tenantId: string | undefined;
  }
}

export default fp(async (app) => {
  app.decorateRequest('tenantId');

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (request.method === 'OPTIONS' || request.routeOptions.config.public === true || request.url.startsWith('/docs'))
      return;

    await app.authenticate(request);

    const header = request.headers[TENANT_HEADER];
    const asked = Array.isArray(header) ? header[0] : header;
    const memberships = request.session.memberships;

    if (asked !== undefined && asked !== '') {
      if (!memberships.some(m => m.t === asked))
        throw forbidden(ERROR_CODES.TENANT_NOT_A_MEMBER, 'You are not a member of this tenant');

      request.tenantId = asked;
    }
    else if (memberships.length === 1) {
      request.tenantId = memberships[0]!.t;
    }

    request.log = request.log.child({ tenantId: request.tenantId });
  });
}, { name: 'tenant', dependencies: ['auth'] });
