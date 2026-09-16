import type { Device, Session, SessionRevokeReason } from '@/db/schema';
import type { Database } from '@/plugins/database';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { devices, sessions } from '@/db/schema';
import { ERROR_CODES } from '@/shared/errors';
import { DomainError, forbidden, unauthorized } from '@/shared/errors/domain-error';
import { generateRefreshToken, hashRefreshToken } from '@/shared/security/tokens';

export interface DeviceInfo {
  clientDeviceId: string;
  platform: 'ios' | 'android' | 'web';
  osVersion?: string | null;
  model?: string | null;
  appVersion?: string | null;
}

export interface SessionsConfig {
  refreshTtlDays: number;
  maxSessionsPerDevice: number;
}

export type OnRevoked = (sessionId: string) => Promise<void>;

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

export class SessionsService {
  constructor(
    private readonly db: Database,
    private readonly config: SessionsConfig,
    private readonly onRevoked: OnRevoked = async () => {},
  ) {}

  async upsertDevice(info: DeviceInfo): Promise<Device> {
    const [device] = await this.db.insert(devices)
      .values({
        clientDeviceId: info.clientDeviceId,
        platform: info.platform,
        osVersion: info.osVersion ?? null,
        model: info.model ?? null,
        appVersion: info.appVersion ?? null,
      })
      .onConflictDoUpdate({
        target: devices.clientDeviceId,
        set: {
          lastSeenAt: new Date(),
          osVersion: info.osVersion ?? null,
          model: info.model ?? null,
          appVersion: info.appVersion ?? null,
        },
      })
      .returning();

    if (!device)
      throw new Error('Device upsert returned no row');

    if (device.blockedAt !== null) {
      throw forbidden(
        ERROR_CODES.AUTH_DEVICE_BLOCKED,
        'This device has been blocked',
      );
    }

    return device;
  }

  async issue(userId: string, deviceId: string): Promise<IssuedSession> {
    await this.enforceDeviceLimit(deviceId);

    const refreshToken = generateRefreshToken();
    const expiresAt = new Date(Date.now() + this.config.refreshTtlDays * 86_400_000);

    const [session] = await this.db.insert(sessions).values({
      userId,
      deviceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt,
    }).returning();

    if (!session)
      throw new Error('Session insert returned no row');

    return { session, refreshToken };
  }

  async rotate(refreshToken: string, onReuse?: (session: Session) => Promise<void>): Promise<IssuedSession> {
    const hash = hashRefreshToken(refreshToken);

    const [replayed] = await this.db.select().from(sessions).where(and(eq(sessions.prevTokenHash, hash), isNull(sessions.revokedAt)));

    if (replayed) {
      await onReuse?.(replayed);
      await this.revoke(replayed.id, 'reuse_detected');
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_REUSED, 'Refresh token was already used');
    }

    const [current] = await this.db.select().from(sessions).where(eq(sessions.refreshTokenHash, hash));

    if (!current || current.revokedAt !== null)
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

    if (current.expiresAt.getTime() <= Date.now())
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token has expired');

    await this.assertDeviceUsable(current.deviceId, current.id);

    const next = generateRefreshToken();

    const [rotated] = await this.db.update(sessions)
      .set({
        refreshTokenHash: hashRefreshToken(next),
        prevTokenHash: hash,
        lastUsedAt: new Date(),
        expiresAt: new Date(Date.now() + this.config.refreshTtlDays * 86_400_000),
      })
      .where(and(
        eq(sessions.id, current.id),
        eq(sessions.refreshTokenHash, hash),
        isNull(sessions.revokedAt),
      ))
      .returning();

    if (!rotated)
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

    return { session: rotated, refreshToken: next };
  }

  async revoke(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.db.update(sessions)
      .set({ revokedAt: sql`coalesce(${sessions.revokedAt}, now())`, revokedReason: reason })
      .where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

    await this.onRevoked(sessionId);
  }

  async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<number> {
    const rows = await this.db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    await Promise.all(rows.map(async row => this.onRevoked(row.id)));
    return rows.length;
  }

  async revokeAllForDevice(deviceId: string, reason: SessionRevokeReason): Promise<number> {
    const rows = await this.db.update(sessions)
      .set({ revokedAt: new Date(), revokedReason: reason })
      .where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt)))
      .returning({ id: sessions.id });

    await Promise.all(rows.map(async row => this.onRevoked(row.id)));
    return rows.length;
  }

  async findActive(sessionId: string): Promise<Session | null> {
    const [session] = await this.db.select().from(sessions).where(and(eq(sessions.id, sessionId), isNull(sessions.revokedAt)));

    return session ?? null;
  }

  private async assertDeviceUsable(deviceId: string, sessionId: string): Promise<void> {
    const [device] = await this.db.select({ blockedAt: devices.blockedAt })
      .from(devices)
      .where(eq(devices.id, deviceId));

    if (device?.blockedAt == null)
      return;

    await this.revoke(sessionId, 'device_blocked');
    throw forbidden(ERROR_CODES.AUTH_DEVICE_BLOCKED, 'This device has been blocked');
  }

  private async enforceDeviceLimit(deviceId: string): Promise<void> {
    const active = await this.db.select({ id: sessions.id }).from(sessions).where(and(eq(sessions.deviceId, deviceId), isNull(sessions.revokedAt))).orderBy(asc(sessions.lastUsedAt));

    const overflow = active.length - this.config.maxSessionsPerDevice + 1;
    if (overflow <= 0)
      return;

    for (const session of active.slice(0, overflow))
      await this.revoke(session.id, 'session_limit');
  }
}

export { DomainError };
