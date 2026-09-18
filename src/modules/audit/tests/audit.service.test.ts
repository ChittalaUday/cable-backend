import type { AuditContext } from '../audit.types';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { auditLogs } from '@/db/schema';
import { createTestDb } from '@/test/db';
import { audit } from '../audit.service';

const { db, close } = createTestDb();
const entityType = AUDIT_ENTITIES.SERVICE;
const tenantId = randomUUID();
const actorId = randomUUID();
const context: AuditContext = { tenantId, actorId, actorType: 'user', requestId: 'request-1' };

afterAll(async () => {
  await db.delete(auditLogs).where(eq(auditLogs.tenantId, tenantId));
  await close();
});

describe('audit service', () => {
  it('stores created and deleted snapshots', async () => {
    const created = await audit.created(db, context, {
      entityType,
      entityId: 'customer-1',
      after: { name: 'Asha' },
    });
    const deleted = await audit.deleted(db, context, {
      entityType,
      entityId: 'customer-1',
      before: { name: 'Asha' },
    });

    expect(created).toMatchObject({ action: `${entityType}.created`, oldValues: null, newValues: { name: 'Asha' } });
    expect(deleted).toMatchObject({ action: `${entityType}.deleted`, oldValues: { name: 'Asha' }, newValues: null });
  });

  it('stores only changed update fields and redacts every payload', async () => {
    const row = await audit.updated(db, context, {
      entityType,
      entityId: 'customer-2',
      before: { name: 'Asha', phone: null, status: 'active', passwordHash: 'old' },
      after: { name: 'Asha', phone: '9876543210', status: 'inactive', passwordHash: 'new' },
      metadata: { reason: 'manual', accessToken: 'secret' },
    });

    expect(row.oldValues).toMatchObject({ passwordHash: '[REDACTED]' });
    expect(row.newValues).toMatchObject({ passwordHash: '[REDACTED]' });
    expect(row.metadata).toEqual({ reason: 'manual', accessToken: '[REDACTED]' });
    expect(row.changes).toEqual({
      phone: { old: null, new: '9876543210' },
      status: { old: 'active', new: 'inactive' },
    });
  });

  it('supports null-tenant system events', async () => {
    const row = await audit.log(db, { tenantId: null, actorId: null, actorType: 'system' }, {
      action: AUDIT_ACTIONS.STORAGE_CLEANED,
      entityType,
      entityId: 'worker',
    });

    expect(row).toMatchObject({ tenantId: null, actorId: null, actorType: 'system' });
  });

  it('uses the caller transaction and leaves no row after rollback', async () => {
    const entityId = randomUUID();
    await expect(db.transaction(async (tx) => {
      await audit.created(tx, context, { entityType, entityId, after: { ok: true } });
      const [inside] = await tx.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
      expect(inside).toBeDefined();
      tx.rollback();
    })).rejects.toThrow('Rollback');

    const [outside] = await db.select().from(auditLogs).where(eq(auditLogs.entityId, entityId));
    expect(outside).toBeUndefined();
  });

  it('does not leave an orphan when a business transaction fails', async () => {
    const entityId = randomUUID();
    await expect(db.transaction(async (tx) => {
      await audit.created(tx, context, { entityType, entityId, after: { ok: true } });
      throw new Error('business write failed');
    })).rejects.toThrow('business write failed');

    const [orphan] = await db.select().from(auditLogs).where(and(
      eq(auditLogs.entityType, entityType),
      eq(auditLogs.entityId, entityId),
    ));
    expect(orphan).toBeUndefined();
  });

  it('queries only the requested tenant and action', async () => {
    const wanted = await audit.log(db, context, { action: AUDIT_ACTIONS.AUTH_LOGOUT, entityType, entityId: 'payment-1' });
    await audit.log(db, { ...context, tenantId: randomUUID() }, { action: AUDIT_ACTIONS.AUTH_LOGOUT, entityType, entityId: 'payment-2' });

    const rows = await audit.list(db, { tenantId, action: AUDIT_ACTIONS.AUTH_LOGOUT });
    expect(rows.map(row => row.id)).toContain(wanted.id);
    expect(rows.every(row => row.tenantId === tenantId && row.action === AUDIT_ACTIONS.AUTH_LOGOUT)).toBe(true);
  });
});
