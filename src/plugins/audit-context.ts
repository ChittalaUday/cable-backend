import type { FastifyRequest } from 'fastify';
import type { AuditContext } from '@/modules/audit';
import type { AccessTokenClaims } from '@/shared/security/tokens';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyRequest {
    /** Available to controllers after preHandler hooks have run. */
    auditContext: AuditContext;
  }
}

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function auditContextFor(request: FastifyRequest): AuditContext {
  const session = (request as unknown as { session?: AccessTokenClaims }).session;
  return {
    tenantId: header(request, 'x-tenant-id'),
    actorId: session?.sub ?? null,
    actorSessionId: session?.sid ?? null,
    actorType: session === undefined ? 'anonymous' : 'user',
    requestId: request.id,
    correlationId: header(request, 'x-correlation-id'),
    ipAddress: request.ip,
    userAgent: header(request, 'user-agent'),
  };
}

export default fp(async (app) => {
  app.decorateRequest('auditContext');
  app.addHook('preHandler', async (request) => {
    request.auditContext = auditContextFor(request);
  });
}, { name: 'audit-context', dependencies: ['auth'] });
