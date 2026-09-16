import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { PermissionKey } from '@/security/permissions';
import { TENANT_HEADER } from '@/config/constants';
import { ERROR_CODES } from '@/errors';
import { badRequest, forbidden } from '@/errors/domain-error';

export function requirePermission(key: PermissionKey): preHandlerAsyncHookHandler {
  const guard: preHandlerAsyncHookHandler = async (request: FastifyRequest) => {
    if (request.tenantId === undefined) {
      throw badRequest(
        ERROR_CODES.TENANT_HEADER_MISSING,
        `${TENANT_HEADER} is required — you are a member of more than one tenant`,
      );
    }

    const context = await request.server.access.resolve(request.session.sub, request.tenantId);

    if (context === null) {
      throw forbidden(ERROR_CODES.TENANT_MEMBERSHIP_SUSPENDED, 'Your membership of this tenant is not active');
    }

    if (!context.permissions.has(key)) {
      throw forbidden(ERROR_CODES.PERM_DENIED, `Missing permission: ${key}`);
    }

    request.access = { ...context, audit: request.auditContext };
  };

  return Object.assign(guard, { permission: key });
}
