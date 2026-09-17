import type { MessagingService } from '@/services/messaging/messaging.service';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { notifications, tenantMemberships, tenants, users } from '@/db/schema';
import { createTestDb } from '@/test/db';
import { NotificationService } from './notifications.service';
import { REDACTED_BODY } from './notifications.types';

const { db, close } = createTestDb();

function fakeMessaging(behaviour: 'ok' | 'fail' = 'ok') {
  const sent: { to: string; text: string; channel: string }[] = [];
  const messaging = {
    defaultChannel: 'whatsapp' as const,
    async send(message: { to: string; text: string; channel?: string }) {
      if (behaviour === 'fail')
        throw new Error('provider exploded');
      sent.push({ to: message.to, text: message.text, channel: message.channel ?? 'whatsapp' });
      return { providerMessageId: 'provider-1' };
    },
  };
  return { messaging: messaging as unknown as MessagingService, sent };
}

let tenantId: string;
let userId: string;

beforeAll(async () => {
  const [tenant] = await db.insert(tenants)
    .values({ code: `T${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Test Cable' })
    .returning();
  const [user] = await db.insert(users)
    .values({ email: `${randomUUID()}@test.local` })
    .returning();

  tenantId = tenant!.id;
  userId = user!.id;
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.tenantId, tenantId));
  await db.delete(tenantMemberships).where(eq(tenantMemberships.tenantId, tenantId));
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await close();
});

function serviceWith(behaviour: 'ok' | 'fail' = 'ok') {
  const { messaging, sent } = fakeMessaging(behaviour);
  return { service: new NotificationService(db, messaging), sent };
}

describe('in-app notifications', () => {
  it('is sent the moment it is recorded — the row IS the delivery', async () => {
    const { service, sent } = serviceWith();

    const row = await service.notify({
      channel: 'in_app',
      type: 'payment_due',
      title: 'Payment due',
      body: 'Your bill is ready',
      tenantId,
      userId,
    });

    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();
    expect(row.readAt).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('separates delivered from read', async () => {
    const { service } = serviceWith();

    const row = await service.notify({ channel: 'in_app', type: 'x', body: 'b', tenantId, userId });
    expect(row.status).toBe('sent');
    expect(row.readAt).toBeNull();

    const read = await service.markRead(row.id, tenantId, userId);
    expect(read.readAt).not.toBeNull();
  });

  it('counts and clears unread', async () => {
    const { service } = serviceWith();
    const before = (await service.unreadCount(tenantId, userId)).total;

    await service.notify({ channel: 'in_app', type: 'x', body: 'one', tenantId, userId });
    await service.notify({ channel: 'in_app', type: 'x', body: 'two', tenantId, userId });

    expect((await service.unreadCount(tenantId, userId)).total).toBe(before + 2);

    const cleared = await service.markAllRead(tenantId, userId);
    expect(cleared).toBeGreaterThanOrEqual(2);
    expect((await service.unreadCount(tenantId, userId)).total).toBe(0);
  });

  it('does not re-stamp readAt when marked read twice', async () => {
    const { service } = serviceWith();
    const row = await service.notify({ channel: 'in_app', type: 'x', body: 'b', tenantId, userId });

    const first = await service.markRead(row.id, tenantId, userId);
    const second = await service.markRead(row.id, tenantId, userId);

    expect(second.readAt?.getTime()).toBe(first.readAt?.getTime());
  });

  it('hides another tenant\'s notification behind a 404', async () => {
    const { service } = serviceWith();
    const row = await service.notify({ channel: 'in_app', type: 'x', body: 'b', tenantId, userId });

    await expect(service.markRead(row.id, randomUUID(), userId)).rejects.toThrow(/not found/i);
    await expect(service.markRead(row.id, tenantId, randomUUID())).rejects.toThrow(/not found/i);
  });

  it('keeps transport notifications out of the in-app inbox', async () => {
    const { service } = serviceWith();

    await service.notify({
      channel: 'whatsapp',
      type: 'otp',
      body: 'code',
      tenantId,
      userId,
      destination: '918309154716',
    });

    const inbox = await service.inbox({ tenantId, userId, page: 1, limit: 50 });
    expect(inbox.items.every(item => item.channel === 'in_app')).toBe(true);
  });
});

describe('transport notifications', () => {
  it('records the provider message id on success', async () => {
    const { service, sent } = serviceWith();

    const row = await service.notify({
      channel: 'whatsapp',
      type: 'ticket_assigned',
      body: 'Ticket #12 assigned',
      tenantId,
      userId,
      destination: '918309154716',
    });

    expect(row.status).toBe('sent');
    expect(row.providerMessageId).toBe('provider-1');
    expect(sent).toEqual([{ to: '918309154716', text: 'Ticket #12 assigned', channel: 'whatsapp' }]);
  });

  it('records the failure AND rethrows — a message nobody got is not a success', async () => {
    const { service } = serviceWith('fail');

    await expect(service.notify({
      channel: 'sms',
      type: 'x',
      body: 'b',
      tenantId,
      userId,
      destination: '918309154716',
    })).rejects.toThrow(/provider exploded/);

    const [row] = await db.select().from(notifications).where(eq(notifications.tenantId, tenantId)).orderBy(notifications.createdAt);

    const failed = (await db.select().from(notifications).where(eq(notifications.status, 'failed')))
      .find(n => n.tenantId === tenantId);

    expect(row).toBeDefined();
    expect(failed?.error).toMatch(/provider exploded/);
    expect(failed?.failedAt).not.toBeNull();
  });

  it('refuses a transport notification with no destination', async () => {
    const { service } = serviceWith();

    await expect(service.notify({ channel: 'sms', type: 'x', body: 'b', tenantId, userId }))
      .rejects
      .toThrow(/needs a destination/);
  });

  it('stores a redacted body for a sensitive send but transmits the real one', async () => {
    const { service, sent } = serviceWith();

    const row = await service.notify({
      channel: 'whatsapp',
      type: 'otp',
      body: 'Your code is 123456',
      sensitive: true,
      tenantId,
      userId,
      destination: '918309154716',
    });

    expect(row.body).toBe(REDACTED_BODY);
    expect(row.body).not.toContain('123456');
    expect(sent[0]?.text).toBe('Your code is 123456');
  });

  it('accepts a notification with no tenant or user, as an OTP to a stranger has neither', async () => {
    const { service } = serviceWith();

    const row = await service.notify({
      channel: 'whatsapp',
      type: 'otp',
      body: 'code',
      destination: '918309154716',
      sensitive: true,
    });

    expect(row.tenantId).toBeNull();
    expect(row.userId).toBeNull();
    expect(row.status).toBe('sent');

    await db.delete(notifications).where(eq(notifications.id, row.id));
  });
});
