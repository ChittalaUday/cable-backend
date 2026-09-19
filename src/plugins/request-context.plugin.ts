import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import fp from 'fastify-plugin';
import { TENANT_HEADER } from '@/config/constants';
import { ERROR_CODES } from '@/errors';
import { badRequest, forbidden } from '@/errors/domain-error';
import { auditContextFor } from '@/hooks/audit.hook';

declare module 'fastify' {
  interface FastifyContextConfig {
    public?: boolean;
  }

  interface FastifyInstance {
    requirePermission: (key: PermissionKey) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    tenantId: string | undefined;
    auditContext: AuditContext;
    access: RequestAccess;
  }
}

export default fp(async (app) => {
  const { access } = app;

  app.decorateRequest('tenantId');
  app.decorateRequest('auditContext');
  app.decorateRequest('access');

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

  app.addHook('preHandler', async (request: FastifyRequest) => {
    request.auditContext = auditContextFor(request);
  });

  app.decorate('requirePermission', (key: PermissionKey): preHandlerAsyncHookHandler => {
    const guard: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
      if (request.tenantId === undefined) {
        throw badRequest(
          ERROR_CODES.TENANT_HEADER_MISSING,
          `${TENANT_HEADER} is required — you are a member of more than one tenant`,
        );
      }

      const context = await access.resolve(request.session.sub, request.tenantId);

      if (context === null)
        throw forbidden(ERROR_CODES.TENANT_MEMBERSHIP_SUSPENDED, 'Your membership of this tenant is not active');

      if (!context.permissions.has(key))
        throw forbidden(ERROR_CODES.PERM_DENIED, `Missing permission: ${key}`);

      request.access = { ...context, audit: request.auditContext };
    };

    return Object.assign(guard, { permission: key });
  });
}, { name: 'request-context', dependencies: ['db', 'auth', 'iam'] });
