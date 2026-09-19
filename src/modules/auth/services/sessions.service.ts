import type { DeviceFingerprint } from '../repositories/sessions.repository';
import type { Database } from '@/db/client';
import type { Device, Session, SessionRevokeReason } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { DomainError, forbidden, unauthorized } from '@/errors/domain-error';
import { generateRefreshToken, hashRefreshToken } from '@/security/tokens';
import { SessionsRepository } from '../repositories/sessions.repository';

export interface DeviceInfo {
  clientDeviceId: string;
  platform: 'ios' | 'android' | 'web';
  osVersion?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  appVersion?: string | null;
  ramMb?: number | null;
  screenResolution?: string | null;
}

export interface SessionsConfig {
  refreshTtlDays: number;
  maxSessionsPerDevice: number;
  /** How long after a rotation the consumed token is still a retry, not theft. */
  refreshGraceSeconds: number;
}

export type OnRevoked = (sessionId: string) => Promise<void>;

export interface IssuedSession {
  session: Session;
  refreshToken: string;
}

function fingerprintOf(info: DeviceInfo): DeviceFingerprint {
  return {
    ...(info.osVersion != null ? { osVersion: info.osVersion } : {}),
    ...(info.manufacturer != null ? { manufacturer: info.manufacturer } : {}),
    ...(info.model != null ? { model: info.model } : {}),
    ...(info.appVersion != null ? { appVersion: info.appVersion } : {}),
    ...(info.ramMb != null ? { ramMb: info.ramMb } : {}),
    ...(info.screenResolution != null ? { screenResolution: info.screenResolution } : {}),
  };
}

export class SessionsService {
  private readonly repo: SessionsRepository;

  constructor(
    repoOrDb: SessionsRepository | Database,
    private readonly config: SessionsConfig,
    private readonly onRevoked: OnRevoked = async () => {},
  ) {
    this.repo = repoOrDb instanceof SessionsRepository ? repoOrDb : new SessionsRepository(repoOrDb);
  }

  async upsertDevice(info: DeviceInfo): Promise<Device> {
    const device = await this.repo.upsertDevice(info.clientDeviceId, info.platform, fingerprintOf(info));

    if (device.blockedAt !== null)
      throw forbidden(ERROR_CODES.AUTH_DEVICE_BLOCKED, 'This device has been blocked');

    return device;
  }

  async issue(userId: string, deviceId: string): Promise<IssuedSession> {
    await this.enforceDeviceLimit(deviceId);

    const refreshToken = generateRefreshToken();

    const session = await this.repo.insertSession({
      userId,
      deviceId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: this.nextExpiry(),
    });

    return { session, refreshToken };
  }

  async rotate(refreshToken: string, onReuse?: (session: Session) => Promise<void>): Promise<IssuedSession> {
    const hash = hashRefreshToken(refreshToken);

    const replayed = await this.repo.findByPrevTokenHash(hash);

    if (replayed !== null) {
      /*
       * A token replayed seconds after it was consumed is far more likely to be
       * the same client asking twice than an attacker: two requests that raced,
       * or a rotation whose response never arrived, leaving the phone holding a
       * token the server has already spent. Revoking there signs out the honest
       * user — permanently, since the token they kept is the dead one.
       *
       * Inside the window the replay is served as the retry it is. Outside it,
       * the token has had time to be stolen, and the session goes.
       */
      const consumedAgo = Date.now() - replayed.lastUsedAt.getTime();

      if (consumedAgo < this.config.refreshGraceSeconds * 1000)
        return this.issueNext(replayed);

      await onReuse?.(replayed);
      await this.revoke(replayed.id, 'reuse_detected');
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_REUSED, 'Refresh token was already used');
    }

    const current = await this.repo.findByTokenHash(hash);

    if (current === null || current.revokedAt !== null)
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

    if (current.expiresAt.getTime() <= Date.now())
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token has expired');

    return this.issueNext(current, hash);
  }

  async revoke(sessionId: string, reason: SessionRevokeReason): Promise<void> {
    await this.repo.revoke(sessionId, reason);
    await this.onRevoked(sessionId);
  }

  async revokeAllForUser(userId: string, reason: SessionRevokeReason): Promise<number> {
    const ids = await this.repo.revokeAllForUser(userId, reason);

    await Promise.all(ids.map(async id => this.onRevoked(id)));
    return ids.length;
  }

  async revokeAllForDevice(deviceId: string, reason: SessionRevokeReason): Promise<number> {
    const ids = await this.repo.revokeAllForDevice(deviceId, reason);

    await Promise.all(ids.map(async id => this.onRevoked(id)));
    return ids.length;
  }

  async findActive(sessionId: string): Promise<Session | null> {
    return this.repo.findActive(sessionId);
  }

  private nextExpiry(): Date {
    return new Date(Date.now() + this.config.refreshTtlDays * 86_400_000);
  }

  /**
   * Swap the session's refresh token for a fresh one.
   *
   * `consuming` is the hash being spent. Passing it makes the update a
   * compare-and-swap and records that hash as the consumed one, so two rotations
   * racing on the same token cannot both win. A graced retry passes none: the
   * window stays anchored to the first rotation instead of sliding forward with
   * every retry, which would keep a spent token alive indefinitely.
   */
  private async issueNext(session: Session, consuming?: string): Promise<IssuedSession> {
    await this.assertDeviceUsable(session.deviceId, session.id);

    const next = generateRefreshToken();
    const updated = await this.repo.rotateToken(session.id, hashRefreshToken(next), this.nextExpiry(), consuming);

    if (updated === null)
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

    return { session: updated, refreshToken: next };
  }

  private async assertDeviceUsable(deviceId: string, sessionId: string): Promise<void> {
    if (await this.repo.findDeviceBlockedAt(deviceId) == null)
      return;

    await this.revoke(sessionId, 'device_blocked');
    throw forbidden(ERROR_CODES.AUTH_DEVICE_BLOCKED, 'This device has been blocked');
  }

  private async enforceDeviceLimit(deviceId: string): Promise<void> {
    const active = await this.repo.activeSessionIdsOfDevice(deviceId);

    const overflow = active.length - this.config.maxSessionsPerDevice + 1;
    if (overflow <= 0)
      return;

    for (const sessionId of active.slice(0, overflow))
      await this.revoke(sessionId, 'session_limit');
  }
}

export { DomainError };
