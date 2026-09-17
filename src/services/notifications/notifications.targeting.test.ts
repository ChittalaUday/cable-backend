import type { MessagingService } from '@/services/messaging/messaging.service';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devices, notifications, sessions, tenantMemberships, tenants, users } from '@/db/schema';
import { createTestDb } from '@/test/db';
import { seedRoles, uniqueDeviceId, uniqueEmail } from '@/test/fixtures';
import { NotificationService } from './notifications.service';

const { db, close } = createTestDb();

function fakeMessaging() {
  const sent: { to: string; category: string | undefined; imageUrl: string | null | undefined; data: Record<string, unknown> | null | undefined }[] = [];
  const messaging = {
    defaultChannel: 'whatsapp' as const,
    async send(message: { to: string; category?: string; imageUrl?: string | null; data?: Record<string, unknown> | null }) {
      sent.push({ to: message.to, category: message.category, imageUrl: message.imageUrl, data: message.data });
      return { providerMessageId: 'p1' };
    },
  };
  return { service: new NotificationService(db, messaging as unknown as MessagingService), sent };
}

let tenantId: string;
let signedInUser: string;
let tokenlessUser: string;
const SIGNED_IN_TOKEN = 'token-signed-in';
const SIGNED_OUT_TOKEN = 'token-signed-out';

beforeAll(async () => {
  await seedRoles(db);

  const [tenant] = await db.insert(tenants)
    .values({ code: `T${randomUUID().slice(0, 4).toUpperCase()}`, name: 'Targeting Cable' })
    .returning();
  tenantId = tenant!.id;

  const [user] = await db.insert(users).values({ email: uniqueEmail('signed-in') }).returning();
  signedInUser = user!.id;

  await db.insert(tenantMemberships).values({ userId: signedInUser, tenantId, roleId: 'customer' });

  // A member who never granted notification permission: no device, no token.
  const [tokenless] = await db.insert(users).values({ email: uniqueEmail('tokenless') }).returning();
  tokenlessUser = tokenless!.id;
  await db.insert(tenantMemberships).values({ userId: tokenlessUser, tenantId, roleId: 'admin' });

  // One phone somebody is signed in on, one phone nobody is signed in on.
  const [live] = await db.insert(devices).values({
    clientDeviceId: uniqueDeviceId(),
    platform: 'android',
    pushToken: SIGNED_IN_TOKEN,
    lastTenantId: tenantId,
  }).returning();

  await db.insert(devices).values({
    clientDeviceId: uniqueDeviceId(),
    platform: 'android',
    pushToken: SIGNED_OUT_TOKEN,
    lastTenantId: tenantId,
  });

  await db.insert(sessions).values({
    userId: signedInUser,
    deviceId: live!.id,
    refreshTokenHash: randomUUID(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
});

afterAll(async () => {
  await db.delete(notifications).where(eq(notifications.tenantId, tenantId));
  await db.delete(sessions).where(eq(sessions.userId, signedInUser));
  await db.delete(devices).where(eq(devices.lastTenantId, tenantId));
  await db.delete(tenantMemberships).where(eq(tenantMemberships.tenantId, tenantId));
  await db.delete(users).where(inArray(users.id, [signedInUser, tokenlessUser]));
  await db.delete(tenants).where(eq(tenants.id, tenantId));
  await close();
});

describe('what a broadcast carries', () => {
  it('passes an image through to the push and files it on the row', async () => {
    const { service, sent } = fakeMessaging();
    const image = 'https://cdn.example.com/offer.png';

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'promotional',
      delivery: 'both',
      type: 'offer',
      title: 'Look at this',
      body: 'A picture says more',
      imageUrl: image,
    });

    expect(sent[0]?.imageUrl).toBe(image);

    const inbox = await service.inbox({ tenantId, userId: signedInUser, page: 1, limit: 5 });
    expect(inbox.items[0]).toMatchObject({ imageUrl: image });
  });

  it('tells the app how to present the message', async () => {
    const { service, sent } = fakeMessaging();

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'general',
      delivery: 'both',
      type: 'announcement',
      title: 'Notice',
      body: 'Something happened',
    });

    // The client gates its in-app banner on delivery, so delivery has to travel
    // with the push — gating on category silently dropped every `both` banner.
    expect(sent[0]?.data).toMatchObject({ delivery: 'both', category: 'general' });
  });
});

describe('who a broadcast reaches', () => {
  it('files a row for a member with no push token at all', async () => {
    const { service, sent } = fakeMessaging();

    const result = await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'general',
      type: 'announcement',
      title: 'Office closed',
      body: 'We are shut on Friday',
    });

    // Both members are addressed; only the one with a device is pushed to.
    expect(result).toMatchObject({ notified: 2, pushed: 1 });
    expect(sent.map(s => s.to)).toEqual([SIGNED_IN_TOKEN]);

    const inbox = await service.inbox({ tenantId, userId: tokenlessUser, page: 1, limit: 10 });
    expect(inbox.items.map(item => item.title)).toContain('Office closed');
  });

  it('keeps account information off a phone nobody is signed in on', async () => {
    const { service, sent } = fakeMessaging();

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'billing',
      type: 'payment_due',
      title: 'Payment due',
      body: 'Your bill is ready',
    });

    expect(sent.map(s => s.to)).toEqual([SIGNED_IN_TOKEN]);
  });

  it('still reaches that phone with a promotional message', async () => {
    const { service, sent } = fakeMessaging();

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'promotional',
      delivery: 'both',
      type: 'offer',
      title: 'Half price',
      body: 'This month only',
    });

    expect(sent.map(s => s.to).sort()).toEqual([SIGNED_IN_TOKEN, SIGNED_OUT_TOKEN].sort());
  });

  it('never guesses which signed-out phone belongs to a named person', async () => {
    const { service, sent } = fakeMessaging();

    await service.broadcast({
      tenantId,
      audience: { kind: 'user', userIds: [signedInUser] },
      category: 'promotional',
      delivery: 'both',
      type: 'offer',
      title: 'Just for you',
      body: 'A personal offer',
    });

    expect(sent.map(s => s.to)).toEqual([SIGNED_IN_TOKEN]);
  });

  it('files an in-app message without pushing anything', async () => {
    const { service, sent } = fakeMessaging();

    const result = await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'promotional',
      delivery: 'in_app',
      type: 'campaign',
      title: 'Welcome back',
      body: 'Have a look at what is new',
    });

    expect(sent).toEqual([]);
    expect(result).toMatchObject({ notified: 2, pushed: 0 });

    const pending = await service.inbox({
      tenantId,
      userId: signedInUser,
      page: 1,
      limit: 10,
      delivery: ['in_app'],
      unreadOnly: true,
    });

    expect(pending.items).toHaveLength(1);
    expect(pending.items[0]).toMatchObject({ title: 'Welcome back', channel: 'in_app' });
  });
});

describe('alerting admins that something is down', () => {
  it('reaches admins and nobody else', async () => {
    const { service } = fakeMessaging();

    await service.alertAdmins({
      type: 'whatsapp_session_down',
      title: 'WhatsApp is not sending',
      body: 'Customers cannot receive a sign-in code until it is back.',
    });

    // tokenlessUser is the admin of this tenant, signedInUser is a customer.
    const admin = await service.inbox({ tenantId, userId: tokenlessUser, page: 1, limit: 5 });
    const customer = await service.inbox({ tenantId, userId: signedInUser, page: 1, limit: 5 });

    expect(admin.items[0]).toMatchObject({
      type: 'whatsapp_session_down',
      // `alert` is the high-importance Android channel, and `both` is what puts
      // it in front of somebody whether or not the app is already open.
      category: 'alert',
      delivery: 'both',
    });

    // An operational failure is not a customer's problem, and telling them the
    // operator's WhatsApp is down would be worse than telling them nothing.
    expect(customer.items.map(item => item.type)).not.toContain('whatsapp_session_down');
  });
});

describe('reaching a device that cannot receive push', () => {
  it('serves both in-app and both-delivery messages to one query', async () => {
    const { service } = fakeMessaging();

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'promotional',
      delivery: 'in_app',
      type: 'pull_only',
      title: 'Pull only',
      body: 'never pushed',
    });

    await service.broadcast({
      tenantId,
      audience: { kind: 'tenant' },
      category: 'alert',
      delivery: 'both',
      type: 'push_or_pull',
      title: 'Push or pull',
      body: 'pushed where it can be',
    });

    const base = { tenantId, userId: signedInUser, page: 1, limit: 20, unreadOnly: true } as const;

    // An iOS Simulator, or anyone who refused permission, has no push token at
    // all — asking only for `in_app` would leave the `both` message invisible.
    const withoutPush = await service.inbox({ ...base, delivery: ['in_app', 'both'] });
    expect(withoutPush.items.map(i => i.type)).toEqual(
      expect.arrayContaining(['pull_only', 'push_or_pull']),
    );

    // Where push works, `both` arrives as a push and must not be pulled too.
    const withPush = await service.inbox({ ...base, delivery: ['in_app'] });
    expect(withPush.items.map(i => i.type)).toContain('pull_only');
    expect(withPush.items.map(i => i.type)).not.toContain('push_or_pull');
  });
});
