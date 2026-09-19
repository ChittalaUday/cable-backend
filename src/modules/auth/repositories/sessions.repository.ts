import type { Database } from '@/db/client';
import type { Device, Session, SessionRevokeReason } from '@/db/schema';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { devices, sessions } from '@/db/schema';

export interface DeviceFingerprint {
  osVersion?: string;
  manufacturer?: string;
  model?: string;
  appVersion?: string;
  ramMb?: number;
  screenResolution?: string;
}

export class SessionsRepository {
  constructor(private readonly db: Database) {}

  get database(): Database {
    return this.db;
  }

  async upsertDevice(
    clientDeviceId: string,
    platform: Device['platform'],
    fingerprint: DeviceFingerprint,
  ): Promise<Device> {
    const [device] = await this.db
      .insert(devices)
      .values({ clientDeviceId, platform, ...fingerprint })
      .onConflictDoUpdate({
        target: devices.clientDeviceId,
        set: { lastSeenAt: new Date(), ...fingerprint },
      })
      .returning();

    if (!device)
      throw new Error('Device upsert returned no row');

    return device;
  }

  async findDeviceBlockedAt(deviceId: string): Promise<Date | null | undefined> {
    const [device] = await this.db
      .select({ blockedAt: devices.blockedAt })
      .from(devices)
      .where(eq(devices.id, deviceId))
      .limit(1);

    return device?.blockedAt;
  }

  async insertSession(values: typeof sessions.$inferInsert): Promise<Session> {
    const [session] = await this.db.insert(sessions).values(values).returning();

    if (!session)
      throw new Error('Session insert returned no row');

    return session;
  }

  async findByPrevTokenHash(hash: string): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.prevTokenHash, hash), isNull(sessions.revokedAt)))
      .limit(1);

    return row ?? null;
  }

  async findByTokenHash(hash: string): Promise<Session | null> {
    const [row] = await this.db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash)).limit(1);
    return row ?? null;
  }

  async findActive(sessionId: string): Promise<Session | null> {
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)))
      .limit(1);

    return row ?? null;
  }

  async activeSessionIdsOfDevice(deviceId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
      .orderBy(asc(sessions.lastUsedAt));

    return rows.map(row => row.id);
  }

  /**
   * Swap the refresh token. When `consuming` is given the WHERE turns this into
   * a compare-and-swap, so two rotations racing on one token cannot both win.
   */
  async rotateToken(sessionId: string, nextHash: string, expiresAt: Date, consuming?: string): Promise<Session | null> {
    const [updated] = await this.db
      .update(sessions)
      .set({
        refreshTokenHash: nextHash,
        expiresAt,
        ...(consuming === undefined ? {} : { prevTokenHash: consuming, lastUsedAt: new Date() }),
      })
      .where(and(
        eq(sessions.id, sessionId),
        isNull(sessions.revokedAt),
        ...(consuming === undefined ? [] : [eq(sessions.refreshTokenHash, consuming)]),
      ))
      .returning();

    return updated ?? null;
  }

  async revoke(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: sql`coalesce(${sessions.revokedAt}, now())`, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));
  }

  async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<string[]> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.map(row => row.id);
  }

  async revokeAllForDevice(deviceId: string, reason: SessionRevokeReason): Promise<string[]> {
    const rows = await this.db
      .update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    return rows.map(row => row.id);
  }

  /** Session ids revoked since `cutoff`, to warm the in-process revocation cache. */
  async revokedSince(cutoff: Date): Promise<string[]> {
    const rows = await this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(sql`${sessions.revokedAt} is not null`, sql`${sessions.revokedAt} > ${cutoff}`));

    return rows.map(row => row.id);
  }

  async notifyRevoked(channel: string, sessionId: string): Promise<void> {
    await this.db.execute(sql`SELECT pg_notify(${channel}, ${sessionId})`);
  }
}
