import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/shared/security/permissions';
import fp from 'fastify-plugin';
import { TENANT_HEADER } from '@/config/constants';
import { AccessService } from '@/modules/iam/access.service';
import { ERROR_CODES } from '@/shared/errors';
import { badRequest, forbidden } from '@/shared/errors/domain-error';

declare module 'fastify' {
  interface FastifyInstance {
    access: AccessService;
    requirePermission: (key: PermissionKey) => preHandlerAsyncHookHandler;
  }

  interface FastifyRequest {
    access: RequestAccess;
  }
}

export default fp(async (app) => {
  const access = new AccessService(app.db);
  app.decorate('access', access);
  app.decorateRequest('access');

  app.decorate('requirePermission', (key: PermissionKey): preHandlerAsyncHookHandler => {
    return async (request: FastifyRequest) => {
      // A tenant-scoped route with no tenant resolved: the caller belongs to
      // several tenants and did not say which (§4.4).
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

      // A fresh object per request: `context` is the shared cached one, so the
      // audit context goes on the copy, never on the cache.
      request.access = { ...context, audit: request.auditContext };
    };
  });
}, { name: 'rbac', dependencies: ['database', 'auth', 'tenant', 'audit-context'] });
