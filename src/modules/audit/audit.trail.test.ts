import type { BuiltApp } from '@/app';
import type { AuditLog } from '@/db/schema';
import type { AuditAction } from '@/shared/constants/audit';
import type { SeededAuthData } from '@/test/fixtures';
import { randomUUID } from 'node:crypto';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '@/app';
import { SYSTEM_ROLES } from '@/config/constants';
import { auditLogs, tenantMemberships, users } from '@/db/schema';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, AUDIT_VERBS, auditAction } from '@/shared/constants/audit';
import { hashPassword } from '@/shared/security/password';
import { createTestDb } from '@/test/db';
import { seedAuthData, TEST_PASSWORD, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { bodyOf } from '@/test/http';

const { db, close } = createTestDb();

let app: BuiltApp;
let data: SeededAuthData;
let auth: Record<string, string>;
let actorId: string;
let actorEmail: string;

const unique = () => randomUUID().slice(0, 8);

async function logFor(entityId: string): Promise<AuditLog | undefined> {
  const [row] = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.entityId, entityId))
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(1);

  return row;
}

beforeAll(async () => {
  app = await buildApp();
  await app.ready();
  data = await seedAuthData(db);

  const [solo] = await db
    .insert(users)
    .values({ email: uniqueEmail('solo'), name: 'Solo Admin', passwordHash: await hashPassword(TEST_PASSWORD) })
    .returning();

  actorId = solo!.id;
  actorEmail = solo!.email!;
  await db.insert(tenantMemberships).values({ userId: actorId, tenantId: data.tenantA.id, roleId: SYSTEM_ROLES.ADMIN });

  const login = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/login',
    headers: { 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' },
    payload: { identifier: solo!.email, password: TEST_PASSWORD },
  });

  auth = { authorization: `Bearer ${bodyOf(login).accessToken}` };
});

afterAll(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.actorId, actorId));
  await db.delete(auditLogs).where(eq(auditLogs.entityType, 'auth'));
  await db.delete(users).where(eq(users.id, actorId));
  await app.close();
  await data.cleanup();
  await close();
});

describe('audit trail', () => {
  it('records a create, an update and a delete, under the resolved tenant', async () => {
    const slug = `audited-${unique()}`;

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: auth,
      payload: { name: 'Audited Service', slug, icon: 'tv' },
    });
    expect(created.statusCode).toBe(201);
    const service = bodyOf<{ id: string }>(created);

    const onCreate = await logFor(service.id);
    expect(onCreate).toMatchObject({
      action: auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.CREATED),
      entityType: AUDIT_ENTITIES.SERVICE,
      entityId: service.id,
      actorType: 'user',
      actorId,
      tenantId: data.tenantA.id,
    });
    expect(onCreate!.newValues).toMatchObject({ name: 'Audited Service', slug });
    expect(onCreate!.requestId).toBeTypeOf('string');

    const updated = await app.inject({
      method: 'PATCH',
      url: `/api/v1/services/${service.id}`,
      headers: auth,
      payload: { name: 'Renamed Service' },
    });
    expect(updated.statusCode).toBe(200);

    const onUpdate = await logFor(service.id);
    expect(onUpdate).toMatchObject({ action: auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.UPDATED), tenantId: data.tenantA.id });
    expect(onUpdate!.changes).toMatchObject({ name: { old: 'Audited Service', new: 'Renamed Service' } });
    expect(onUpdate!.requestId).not.toBe(onCreate!.requestId);

    const removed = await app.inject({ method: 'DELETE', url: `/api/v1/services/${service.id}`, headers: auth });
    expect(removed.statusCode).toBe(204);

    const onDelete = await logFor(service.id);
    expect(onDelete).toMatchObject({ action: auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.DELETED), tenantId: data.tenantA.id });
    expect(onDelete!.oldValues).toMatchObject({ name: 'Renamed Service' });
  });

  it('writes nothing when the change is refused', async () => {
    const service = bodyOf<{ id: string }>(await app.inject({
      method: 'POST',
      url: '/api/v1/services',
      headers: auth,
      payload: { name: 'Has Providers', slug: `held-${unique()}`, icon: 'tv' },
    }));

    await app.inject({
      method: 'POST',
      url: '/api/v1/service-providers',
      headers: auth,
      payload: { serviceId: service.id, name: 'Supplier', slug: `sup-${unique()}` },
    });

    const refused = await app.inject({ method: 'DELETE', url: `/api/v1/services/${service.id}`, headers: auth });
    expect(refused.statusCode).toBe(409);

    const rows = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, service.id), eq(auditLogs.action, auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.DELETED))));

    expect(rows).toHaveLength(0);
  });
});

describe('auth trail', () => {
  const device = () => ({ 'x-device-id': uniqueDeviceId(), 'x-platform': 'ios' });

  async function authRows(action: AuditAction, entityId: string) {
    return db
      .select()
      .from(auditLogs)
      .where(and(
        eq(auditLogs.entityType, AUDIT_ENTITIES.AUTH),
        eq(auditLogs.action, action),
        eq(auditLogs.entityId, entityId),
      ))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));
  }

  it('records a successful sign-in against the user', async () => {
    const before = (await authRows(AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, actorId)).length;

    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: device(),
      payload: { identifier: actorEmail, password: TEST_PASSWORD },
    });
    expect(response.statusCode).toBe(200);

    const rows = await authRows(AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, actorId);
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ actorId, entityId: actorId, actorType: 'anonymous' });
    expect(rows[0]!.metadata).toMatchObject({ identifier: actorEmail.toLowerCase() });
  });

  it('records a refused sign-in against the identifier that was tried', async () => {
    const wrongPassword = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: device(),
      payload: { identifier: actorEmail, password: 'not-the-password' },
    });
    expect(wrongPassword.statusCode).toBe(401);

    const [known] = await authRows(AUDIT_ACTIONS.AUTH_LOGIN_FAILED, actorId);
    expect(known).toMatchObject({ actorId, entityId: actorId });
    expect(known!.metadata).toMatchObject({ reason: 'AUTH_CREDENTIALS_INVALID' });
    expect(JSON.stringify(known)).not.toContain('not-the-password');

    const unknown = uniqueEmail('ghost').toLowerCase();
    const noSuchUser = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: device(),
      payload: { identifier: unknown, password: 'whatever' },
    });
    expect(noSuchUser.statusCode).toBe(401);

    const [ghost] = await authRows(AUDIT_ACTIONS.AUTH_LOGIN_FAILED, unknown);
    expect(ghost).toMatchObject({ actorId: null, entityId: unknown });
  });

  it('names the session a replayed refresh token belonged to', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: device(),
      payload: { identifier: actorEmail, password: TEST_PASSWORD },
    });
    const { refreshToken } = bodyOf(login);

    const rotated = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
    expect(rotated.statusCode).toBe(200);

    const replay = await app.inject({ method: 'POST', url: '/api/v1/auth/refresh', payload: { refreshToken } });
    expect(replay.statusCode).toBe(401);

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED), eq(auditLogs.actorId, actorId)))
      .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id));

    expect(row).toBeDefined();
    expect(row!.entityId).not.toBe('unknown');
    expect(row!.metadata).toHaveProperty('deviceId');
  });

  it('records sign-out against the session it ended', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: device(),
      payload: { identifier: actorEmail, password: TEST_PASSWORD },
    });
    const { accessToken } = bodyOf(login);

    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers: { authorization: `Bearer ${accessToken}` } });
    const { sessionId } = bodyOf(me);

    const out = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(out.statusCode).toBe(200);

    const [row] = await authRows(AUDIT_ACTIONS.AUTH_LOGOUT, sessionId);
    expect(row).toMatchObject({ actorId, actorType: 'user' });
  });
});
