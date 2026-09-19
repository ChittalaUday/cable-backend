import type { SQL } from 'drizzle-orm';
import type { Audience, InboxQuery, Notification, PushTarget } from './notifications.types';
import type { NotificationCategory } from '@/constants/notify';
import type { Database } from '@/db/client';
import type { NewNotification } from '@/db/schema';
import { and, count, desc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { devices, notifications, sessions, tenantMemberships } from '@/db/schema';

const READABLE_CHANNELS = ['in_app', 'push'] as const;

/**
 * An `inArray` over an empty list is an error in Drizzle and a tautology in SQL,
 * so an audience that names nobody is spelled as a value nothing can equal.
 */
function oneOf(ids: readonly string[]): string[] {
  return ids.length > 0 ? [...ids] : [''];
}

export class NotificationRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  /** A live, active membership. A removed one must not receive anything. */
  private liveMembership(): SQL[] {
    return [eq(tenantMemberships.status, 'active'), isNull(tenantMemberships.deletedAt)];
  }

  async insertNotification(values: NewNotification): Promise<Notification> {
    const [row] = await this.db.insert(notifications).values(values).returning();

    if (!row)
      throw new Error('Notification insert returned no row');

    return row;
  }

  async insertMany(values: NewNotification[]): Promise<void> {
    if (values.length === 0)
      return;

    await this.db.insert(notifications).values(values);
  }

  async markSent(id: string, providerMessageId: string | null | undefined): Promise<Notification | null> {
    const [sent] = await this.db
      .update(notifications)
      .set({ status: 'sent', sentAt: new Date(), providerMessageId })
      .where(eq(notifications.id, id))
      .returning();

    return sent ?? null;
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ status: 'failed', failedAt: new Date(), error })
      .where(eq(notifications.id, id));
  }

  async tenantsWithAdmins(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ tenantId: tenantMemberships.tenantId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.roleId, 'admin'), ...this.liveMembership()));

    return rows.map(row => row.tenantId);
  }

  async recipientsFor(tenantId: string, audience: Audience): Promise<string[]> {
    const rows = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        ...this.liveMembership(),
        ...(audience.kind === 'role' ? [eq(tenantMemberships.roleId, audience.roleId)] : []),
        ...(audience.kind === 'user' ? [inArray(tenantMemberships.userId, oneOf(audience.userIds))] : []),
      ));

    return [...new Set(rows.map(row => row.userId))];
  }

  async signedInTargets(tenantId: string, audience: Audience): Promise<PushTarget[]> {
    const audienceWhere = audience.kind === 'user'
      ? inArray(sessions.userId, oneOf(audience.userIds))
      : audience.kind === 'role'
        ? eq(tenantMemberships.roleId, audience.roleId)
        : undefined;

    const rows = await this.db
      .select({ deviceId: devices.id, token: devices.pushToken, userId: sessions.userId })
      .from(sessions)
      .innerJoin(devices, eq(devices.id, sessions.deviceId))
      .innerJoin(tenantMemberships, and(
        eq(tenantMemberships.userId, sessions.userId),
        eq(tenantMemberships.tenantId, tenantId),
        ...this.liveMembership(),
      ))
      .where(and(
        isNull(sessions.revokedAt),
        sql`${sessions.expiresAt} > now()`,
        isNotNull(devices.pushToken),
        isNull(devices.blockedAt),
        ...(audienceWhere ? [audienceWhere] : []),
      ));

    const byToken = new Map<string, PushTarget>();
    for (const row of rows) {
      if (row.token != null && !byToken.has(row.token))
        byToken.set(row.token, { deviceId: row.deviceId, token: row.token, userId: row.userId, tenantId });
    }

    return [...byToken.values()];
  }

  /** Devices last seen in this tenant with no live session — nobody is signed in on them. */
  async signedOutTargets(tenantId: string): Promise<PushTarget[]> {
    const rows = await this.db
      .select({ deviceId: devices.id, token: devices.pushToken, tenantId: devices.lastTenantId })
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

    return rows.map(row => ({
      deviceId: row.deviceId,
      token: row.token ?? '',
      userId: null,
      tenantId: row.tenantId,
    }));
  }

  async clearPushTokens(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0)
      return;

    await this.db
      .update(devices)
      .set({ pushToken: null, pushTokenUpdatedAt: new Date() })
      .where(inArray(devices.pushToken, [...tokens]));
  }

  /** A null token deregisters the device — the client sends that on sign-out. */
  async setPushToken(deviceId: string, token: string | null, tenantId: string | null | undefined): Promise<void> {
    await this.db
      .update(devices)
      .set({
        pushToken: token,
        pushTokenUpdatedAt: new Date(),
        lastSeenAt: new Date(),
        ...(tenantId != null ? { lastTenantId: tenantId } : {}),
      })
      .where(eq(devices.id, deviceId));
  }

  async inbox(query: InboxQuery): Promise<{ items: Notification[]; total: number }> {
    const where = and(
      eq(notifications.tenantId, query.tenantId),
      eq(notifications.userId, query.userId),
      inArray(notifications.channel, READABLE_CHANNELS),
      ...(query.unreadOnly ? [isNull(notifications.readAt)] : []),
      ...(query.category ? [eq(notifications.category, query.category)] : []),
      ...(query.delivery && query.delivery.length > 0 ? [inArray(notifications.delivery, [...query.delivery])] : []),
    );

    const [items, [total]] = await Promise.all([
      this.db
        .select()
        .from(notifications)
        .where(where)
        .orderBy(desc(notifications.createdAt))
        .limit(query.limit)
        .offset((query.page - 1) * query.limit),
      this.db.select({ value: count() }).from(notifications).where(where),
    ]);

    return { items, total: total?.value ?? 0 };
  }

  async unreadByCategory(tenantId: string, userId: string): Promise<{ category: string; value: number }[]> {
    return this.db
      .select({ category: notifications.category, value: count() })
      .from(notifications)
      .where(and(
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
        inArray(notifications.channel, READABLE_CHANNELS),
        isNull(notifications.readAt),
      ))
      .groupBy(notifications.category);
  }

  async markRead(id: string, tenantId: string, userId: string): Promise<Notification | null> {
    const [row] = await this.db
      .update(notifications)
      .set({ readAt: sql`coalesce(${notifications.readAt}, now())` })
      .where(and(
        eq(notifications.id, id),
        eq(notifications.tenantId, tenantId),
        eq(notifications.userId, userId),
      ))
      .returning();

    return row ?? null;
  }

  async markAllRead(tenantId: string, userId: string, category?: NotificationCategory): Promise<number> {
    const rows = await this.db
      .update(notifications)
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
