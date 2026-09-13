import type { AuditContext } from '@/modules/audit/audit.types';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import auditContextPlugin from './audit-context';

const app = Fastify();

beforeAll(async () => {
  await app.register(fp(async () => {}, { name: 'auth' }));
  await app.register(auditContextPlugin);
  app.get('/context', {
    onRequest: async (request) => {
      request.session = { sub: 'user-1', sid: 'session-1', did: 'device-1', memberships: [] };
    },
  }, async request => request.auditContext);
  await app.ready();
});

afterAll(async () => app.close());

describe('audit request context', () => {
  it('captures the authenticated identity and request metadata', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/context',
      headers: {
        'x-tenant-id': 'tenant-1',
        'x-correlation-id': 'correlation-1',
        'user-agent': 'audit-test',
      },
    });

    const body = response.json<AuditContext>();
    expect(body).toMatchObject({
      tenantId: 'tenant-1',
      actorId: 'user-1',
      actorSessionId: 'session-1',
      actorType: 'user',
      correlationId: 'correlation-1',
      userAgent: 'audit-test',
    });
    expect(body.requestId).toBeTypeOf('string');
    expect(body.ipAddress).toBeTypeOf('string');
  });
});
