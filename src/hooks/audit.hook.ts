import type { FastifyRequest } from 'fastify';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { AccessTokenClaims } from '@/security/tokens';

function header(request: FastifyRequest, name: string): string | null {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? null : value ?? null;
}

export function auditContextFor(request: FastifyRequest): AuditContext {
  const session = (request as unknown as { session?: AccessTokenClaims }).session;
  return {
    tenantId: request.tenantId ?? header(request, 'x-tenant-id'),
    actorId: session?.sub ?? null,
    actorSessionId: session?.sid ?? null,
    actorType: session === undefined ? 'anonymous' : 'user',
    requestId: request.id,
    correlationId: header(request, 'x-correlation-id'),
    ipAddress: request.ip,
    userAgent: header(request, 'user-agent'),
  };
}

export async function auditHook(request: FastifyRequest): Promise<void> {
  request.auditContext = auditContextFor(request);
}
