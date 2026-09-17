import type {
  Audience,
  BroadcastInput,
  BroadcastResult,
  InboxQuery,
  Notification,
  NotifyInput,
  PushTarget,
  RegisterTokenInput,
} from './notifications.types';
import type { NotificationCategory, NotificationDelivery } from '@/constants/notify';
import type { Database } from '@/db/client';
import type { NewNotification } from '@/db/schema';
import type { MessagingService } from '@/services/messaging/messaging.service';
import type { Page } from '@/utils/pagination';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_DELIVERY,
  NOTIFICATION_STATUS,
  sendsPush,
  SIGNED_OUT_CATEGORY,
} from '@/constants/notify';
import { devices, notifications, sessions, tenantMemberships } from '@/db/schema';
import { notFound } from '@/errors/domain-error';
import { REDACTED_BODY } from './notifications.types';

/**
 * What the app's inbox shows. A WhatsApp or SMS notification is a record that
 * we messaged somebody's phone, not something to read back inside the app.
 */
const READABLE_CHANNELS = ['in_app', 'push'] as const;

export class NotificationService {
  constructor(
    private readonly db: Database,
    private readonly messaging: MessagingService,
  ) {}

  async notify(input: NotifyInput): Promise<Notification> {
    const isTransport = input.channel === 'whatsapp' || input.channel === 'sms';

    if (isTransport && (input.destination == null || input.destination === ''))
      throw new Error(`A ${input.channel} notification needs a destination`);

    const [row] = await this.db.insert(notifications).values(rowFor(input, isTransport)).returning();

    if (!row)
      throw new Error('Notification insert returned no row');

    if (isTransport)
      return this.deliver(row, input.body);

    // in_app rows are pulled by the app on focus; push rows go out now unless
    // their delivery mode says they are in-app only.
    if (row.channel === 'push' && sendsPush(row.delivery) && row.userId != null && row.tenantId != null) {
      const targets = await this.resolveTargets(
        row.tenantId,
        { kind: 'user', userIds: [row.userId] },
        row.category,
      );
      await this.pushTo(targets, row);
    }

    return row;
  }

  private async deliver(row: Notification, body: string): Promise<Notification> {
    try {
      const result = await this.messaging.send({
        to: row.destination ?? '',
        text: body,
        channel: row.channel === 'sms' ? 'sms' : 'whatsapp',
      });

      const [sent] = await this.db.update(notifications)
        .set({ status: NOTIFICATION_STATUS.SENT, sentAt: new Date(), providerMessageId: result.providerMessageId })
        .where(eq(notifications.id, row.id))
        .returning();

      return sent ?? row;
    }
    catch (error) {
      await this.db.update(notifications)
        .set({
          status: NOTIFICATION_STATUS.FAILED,
          failedAt: new Date(),
          error: error instanceof Error ? error.message : String(error),
        })
        .where(eq(notifications.id, row.id));

      throw error;
    }
  }

  // ---------------------------------------------------------------- broadcast

  async broadcast(input: BroadcastInput): Promise<BroadcastResult> {
    const delivery = input.delivery ?? DEFAULT_DELIVERY[input.category];

    // Who is addressed and who can be pushed to are different sets. Membership
    // decides the first, so somebody who never granted notification permission
    // still finds the message in their inbox; a device token decides the
    // second. Deriving the inbox from the push targets would silently drop
    // everyone without a registered token.
    const [userIds, targets] = await Promise.all([
      this.recipientsFor(input.tenantId, input.audience),
      this.resolveTargets(input.tenantId, input.audience, input.category),
    ]);

    if (userIds.length > 0) {
      await this.db.insert(notifications).values(userIds.map(userId => ({
        tenantId: input.tenantId,
        userId,
        channel: sendsPush(delivery) ? ('push' as const) : ('in_app' as const),
        category: input.category,
        delivery,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data ?? null,
        imageUrl: input.imageUrl ?? null,
        status: NOTIFICATION_STATUS.SENT,
        sentAt: new Date(),
      })));
    }

    if (!sendsPush(delivery))
      return { notified: userIds.length, pushed: 0, failed: 0 };

    const { pushed, failed } = await this.pushTo(targets, {
      title: input.title,
      body: input.body,
      category: input.category,
      delivery,
      type: input.type,
      data: input.data ?? null,
      imageUrl: input.imageUrl ?? null,
    });

    return { notified: userIds.length, pushed, failed };
  }

  /**
   * Tells every operator's admins that something they depend on has broken.
   *
   * Tenant-by-tenant because an alert belongs to the operator it affects, and
   * because that reuses the ordinary broadcast path rather than inventing a
   * second one. Never sent over WhatsApp — the thing being reported is usually
   * WhatsApp itself.
   */
  async alertAdmins(input: { type: string; title: string; body: string }): Promise<BroadcastResult> {
    const tenants = await this.db.selectDistinct({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.roleId, 'admin'),
        eq(tenantMemberships.status, 'active'),
      ));

    const totals: BroadcastResult = { notified: 0, pushed: 0, failed: 0 };

    for (const { tenantId } of tenants) {
      const result = await this.broadcast({
        tenantId,
        audience: { kind: 'role', roleId: 'admin' },
        category: 'alert',
        delivery: 'both',
        type: input.type,
        title: input.title,
        body: input.body,
      });

      totals.notified += result.notified;
      totals.pushed += result.pushed;
      totals.failed += result.failed;
    }

    return totals;
  }

  /**
   * Everybody the broadcast is addressed to, by membership alone — no device,
   * no session, no push token required. This is what the inbox is built from,
   * and it is why the admin who sends a tenant-wide message receives it too.
   */
  private async recipientsFor(tenantId: string, audience: Audience): Promise<string[]> {
    const rows = await this.db.select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.status, 'active'),
        ...(audience.kind === 'role' ? [eq(tenantMemberships.roleId, audience.roleId)] : []),
        ...(audience.kind === 'user'
          ? [inArray(tenantMemberships.userId, audience.userIds.length > 0 ? [...audience.userIds] : [''])]
          : []),
      ));

    return [...new Set(rows.map(row => row.userId))];
  }

  /**
   * The one place device tokens are chosen. A signed-out device has no live
   * session, so it is only ever reachable by the signed-out category —
   * enforced here rather than in each caller.
   */
  async resolveTargets(
    tenantId: string,
    audience: Audience,
    category: NotificationCategory,
  ): Promise<PushTarget[]> {
    const signedIn = await this.signedInTargets(tenantId, audience);

    if (category !== SIGNED_OUT_CATEGORY)
      return signedIn;

    // Promotional also reaches phones nobody is signed in on, addressed by the
    // last tenant that device belonged to. A device targeted at one specific
    // user is never in this set: without a session we cannot know whose it is.
    if (audience.kind === 'user')
      return signedIn;

    const signedOut = await this.db.select({
      deviceId: devices.id,
      token: devices.pushToken,
      tenantId: devices.lastTenantId,
    })
      .from(devices)
      .leftJoin(sessions, and(
        eq(sessions.deviceId, devices.id),
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
      ))
      .where(and(
        eq(devices.lastTenantId, tenantId),
        isNotNull(devices.pushToken),
        isNull(devices.blockedAt),
        isNull(sessions.id),
      ));

    return [
      ...signedIn,
      ...signedOut.map(row => ({
        deviceId: row.deviceId,
        token: row.token ?? '',
        userId: null,
        tenantId: row.tenantId,
      })),
    ];
  }

  private async signedInTargets(tenantId: string, audience: Audience): Promise<PushTarget[]> {
    const audienceWhere = audience.kind === 'user'
      ? inArray(sessions.userId, audience.userIds.length > 0 ? audience.userIds : [''])
      : audience.kind === 'role'
        ? eq(tenantMemberships.roleId, audience.roleId)
        : undefined;

    const rows = await this.db.select({
      deviceId: devices.id,
      token: devices.pushToken,
      userId: sessions.userId,
    })
      .from(sessions)
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .innerJoin(tenantMemberships, and(
        eq(tenantMemberships.userId, sessions.userId),
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.status, 'active'),
      ))
      .where(and(
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        isNotNull(devices.pushToken),
        isNull(devices.blockedAt),
        ...(audienceWhere ? [audienceWhere] : []),
      ));

    // One device can hold sessions for several accounts; one push each is wrong.
    const byToken = new Map<string, PushTarget>();
    for (const row of rows) {
      if (row.token != null && !byToken.has(row.token))
        byToken.set(row.token, { deviceId: row.deviceId, token: row.token, userId: row.userId, tenantId });
    }

    return [...byToken.values()];
  }

  // ponytail: one FCM call per token. Fine for a user or a role; swap to
  // sendEachForMulticast (500 tokens a call) before a tenant-wide blast.
  private async pushTo(
    targets: readonly PushTarget[],
    message: { title: string | null; body: string; category: NotificationCategory; delivery: NotificationDelivery; type: string; data: Record<string, unknown> | null; imageUrl: string | null },
  ): Promise<{ pushed: number; failed: number }> {
    if (targets.length === 0)
      return { pushed: 0, failed: 0 };

    const results = await Promise.allSettled(targets.map(async target => this.messaging.send({
      to: target.token,
      text: message.body,
      ...(message.title != null ? { subject: message.title } : {}),
      channel: 'push',
      category: message.category,
      // `delivery` travels with the push because it is what decides whether the
      // app shows a banner in the foreground — the client cannot infer it.
      data: { ...message.data, category: message.category, delivery: message.delivery, type: message.type },
      ...(message.imageUrl != null ? { imageUrl: message.imageUrl } : {}),
    })));

    const failed = results.filter(r => r.status === 'rejected');

    // A token the device no longer holds is dead weight, not an error worth
    // failing the send over — drop it so the next broadcast is cheaper.
    await this.dropDeadTokens(targets, results);

    return { pushed: results.length - failed.length, failed: failed.length };
  }

  private async dropDeadTokens(
    targets: readonly PushTarget[],
    results: readonly PromiseSettledResult<unknown>[],
  ): Promise<void> {
    const dead = targets
      .filter((_, i) => {
        const result = results[i];
        return result?.status === 'rejected' && isUnregistered(result.reason);
      })
      .map(t => t.token);

    if (dead.length > 0) {
      await this.db.update(devices)
        .set({ pushToken: null, pushTokenUpdatedAt: new Date() })
        .where(inArray(devices.pushToken, dead));
    }
  }

  // ------------------------------------------------------------------ devices

  /**
   * Called on app boot, on token refresh and after login — signed in or not.
   * `token: null` is a device that revoked notification permission.
   */
  async registerToken(input: RegisterTokenInput, deviceId: string): Promise<void> {
    await this.db.update(devices)
      .set({
        pushToken: input.token,
        pushTokenUpdatedAt: new Date(),
        lastSeenAt: new Date(),
        ...(input.tenantId != null ? { lastTenantId: input.tenantId } : {}),
      })
      .where(eq(devices.id, deviceId));
  }

  // -------------------------------------------------------------------- inbox

  async inbox(query: InboxQuery): Promise<Page<Notification>> {
    const where = and(
      eq(notifications.tenantId, query.tenantId),
      eq(notifications.userId, query.userId),
      inArray(notifications.channel, READABLE_CHANNELS),
      ...(query.unreadOnly ? [isNull(notifications.readAt)] : []),
      ...(query.category ? [eq(notifications.category, query.category)] : []),
      ...(query.delivery && query.delivery.length > 0 ? [inArray(notifications.delivery, [...query.delivery])] : []),
    );

    const [items, [total]] = await Promise.all([
      this.db.select().from(notifications).where(where).orderBy(desc(notifications.createdAt)).limit(query.limit).offset((query.page - 1) * query.limit),
      this.db.select({ value: count() }).from(notifications).where(where),
    ]);

    return { items, total: total?.value ?? 0, page: query.page, limit: query.limit };
  }

  async unreadCount(tenantId: string, userId: string): Promise<{ total: number; byCategory: Record<string, number> }> {
    const rows = await this.db.select({ category: notifications.category, value: count() })
      .from(notifications)
      .where(and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        inArray(notifications.channel, READABLE_CHANNELS),
        isNull(notifications.readAt),
      ))
      .groupBy(notifications.category);

    return {
      total: rows.reduce((sum, row) => sum + row.value, 0),
      byCategory: Object.fromEntries(rows.map(row => [row.category, row.value])),
    };
  }

  async markRead(id: string, tenantId: string, userId: string): Promise<Notification> {
    const [row] = await this.db.update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(
        eq(notifications.id, id),
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
      ))
      .returning();

    if (!row)
      throw notFound('Notification');

    return row;
  }

  async markAllRead(tenantId: string, userId: string, category?: NotificationCategory): Promise<number> {
    const rows = await this.db.update(notifications)
      .set({ readAt: new Date() })
      .where(and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        inArray(notifications.channel, READABLE_CHANNELS),
        isNull(notifications.readAt),
        ...(category ? [eq(notifications.category, category)] : []),
      ))
      .returning({ id: notifications.id });

    return rows.length;
  }
}

function rowFor(input: NotifyInput, isTransport: boolean): NewNotification {
  const category = input.category ?? 'general';
  const delivery: NotificationDelivery = input.delivery ?? DEFAULT_DELIVERY[category];

  return {
    tenantId: input.tenantId ?? null,
    userId: input.userId ?? null,
    channel: input.channel,
    category,
    delivery,
    type: input.type,
    title: input.title ?? null,
    body: input.sensitive === true ? REDACTED_BODY : input.body,
    data: input.data ?? null,
    destination: input.destination ?? null,
    imageUrl: input.imageUrl ?? null,
    status: isTransport ? 'queued' : 'sent',
    sentAt: isTransport ? null : new Date(),
  };
}

const DEAD_TOKEN = /registration-token-not-registered|invalid-registration-token|invalid-argument/i;

function isUnregistered(reason: unknown): boolean {
  return DEAD_TOKEN.test(reason instanceof Error ? reason.message : String(reason));
}
