import type { DeviceInfo, SessionsService } from './sessions.service';
import type { User } from '@/db/schema';
import type { MessagingService } from '@/modules/notifications';
import type { Database } from '@/plugins/database';
import type { AccessTokenClaims, TokenSigner } from '@/shared/security/tokens';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { otpCodes, tenantMemberships, users } from '@/db/schema';
import { normalisePhone } from '@/modules/notifications';
import { ERROR_CODES } from '@/shared/errors';
import { badRequest, forbidden, unauthorized } from '@/shared/errors/domain-error';
import { generateOtp, hashOtp, otpMatches } from '@/shared/security/otp';
import { verifyPassword } from '@/shared/security/password';

export interface AuthConfig {
  otpLength: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  defaultCountryCode: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/**
 * The user as callers outside this module see them.
 *
 * The service returns this rather than a row, so `passwordHash` and `googleSub`
 * never leave the module at all — the response schema is the second line of
 * defence, not the only one.
 */
export interface PublicUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photoUrl: string | null;
  isSuperAdmin: boolean;
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    photoUrl: user.photoUrl,
    isSuperAdmin: user.isSuperAdmin,
  };
}

export interface RequestOtpInput {
  phone: string;
  channel?: 'whatsapp' | 'sms';
}

export interface VerifyOtpInput {
  phone: string;
  code: string;
  device: DeviceInfo;
}

export interface LoginInput {
  identifier: string;
  password: string;
  device: DeviceInfo;
}

/**
 * Sign-in (AGENTS.md §4.3, §4.3.1).
 *
 * Email signs in with a password; phone signs in with an OTP. A phone number is
 * not a secret, and a second password on the same account is a second thing to
 * leak, so there is no phone + password path.
 */
export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly deps: { messaging: MessagingService; tokens: TokenSigner; config: AuthConfig },
  ) {}

  /**
   * Issues and sends an OTP.
   *
   * The caller always reports 202 regardless of what happens in here for a known
   * versus unknown number — different answers would turn this into a free
   * user-enumeration oracle (§4.3.1). Delivery failure is the one exception: it
   * throws, because an OTP nobody received must not read as sent.
   */
  get otpTtlSeconds(): number {
    return this.deps.config.otpTtlSeconds;
  }

  async userById(id: string): Promise<PublicUser> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    if (!user)
      throw unauthorized(ERROR_CODES.AUTH_TOKEN_INVALID, 'Account no longer exists');

    return toPublicUser(user);
  }

  async requestOtp(input: RequestOtpInput): Promise<{ channel: 'whatsapp' | 'sms' }> {
    const identifier = normalisePhone(input.phone, this.deps.config.defaultCountryCode);
    const channel = input.channel ?? 'whatsapp';

    await this.assertNotResendingTooSoon(identifier);

    const code = generateOtp(this.deps.config.otpLength);
    const expiresAt = new Date(Date.now() + this.deps.config.otpTtlSeconds * 1000);

    await this.db.transaction(async (tx) => {
      // One live code per identifier: requesting again kills the previous, so a
      // stolen older message is useless.
      await tx.update(otpCodes)
        .set({ supersededAt: new Date() })
        .where(and(
          eq(otpCodes.identifier, identifier),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ));

      await tx.insert(otpCodes).values({
        identifier,
        channel,
        codeHash: hashOtp(code, identifier),
        maxAttempts: this.deps.config.otpMaxAttempts,
        expiresAt,
      });
    });

    await this.deps.messaging.send({
      to: identifier,
      channel,
      text: `${code} is your Satya Cable verification code. It expires in ${Math.round(this.deps.config.otpTtlSeconds / 60)} minutes.`,
    });

    return { channel };
  }

  /** Verifies an OTP and issues tokens, creating the account if the number is new. */
  async verifyOtp(input: VerifyOtpInput): Promise<AuthTokens & { user: PublicUser }> {
    const identifier = normalisePhone(input.phone, this.deps.config.defaultCountryCode);
    const record = await this.findLiveOtp(identifier);

    if (!record)
      throw unauthorized(ERROR_CODES.OTP_EXPIRED, 'No active code for this number');

    if (record.attempts >= record.maxAttempts)
      throw badRequest(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.');

    if (!otpMatches(hashOtp(input.code, identifier), record.codeHash)) {
      // Counted before the failure is returned, so guesses are always capped.
      await this.db.update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(eq(otpCodes.id, record.id));

      throw unauthorized(ERROR_CODES.OTP_INVALID, 'Incorrect code');
    }

    await this.db.update(otpCodes)
      .set({ consumedAt: new Date() })
      .where(eq(otpCodes.id, record.id));

    const user = await this.findOrCreateByPhone(identifier);
    return this.startSession(user, input.device);
  }

  /** Email or phone plus a password. */
  async login(input: LoginInput): Promise<AuthTokens & { user: PublicUser }> {
    const identifier = input.identifier.trim().toLowerCase();
    const asPhone = normalisePhone(identifier, this.deps.config.defaultCountryCode);

    const [user] = await this.db.select().from(users).where(or(eq(users.email, identifier), eq(users.phone, asPhone)));

    // The same error whether the account is missing or the password is wrong —
    // telling them apart is an account-enumeration oracle.
    if (!user)
      throw unauthorized(ERROR_CODES.AUTH_CREDENTIALS_INVALID, 'Invalid credentials');

    if (user.passwordHash === null)
      throw unauthorized(ERROR_CODES.AUTH_PASSWORD_NOT_SET, 'This account signs in with Google');

    if (!await verifyPassword(input.password, user.passwordHash))
      throw unauthorized(ERROR_CODES.AUTH_CREDENTIALS_INVALID, 'Invalid credentials');

    return this.startSession(user, input.device);
  }

  /** Rotates a refresh token and mints a matching access token. */
  async refresh(refreshToken: string): Promise<AuthTokens> {
    const { session, refreshToken: next } = await this.sessions.rotate(refreshToken);

    const [user] = await this.db.select().from(users).where(eq(users.id, session.userId));
    if (!user)
      throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

    this.assertUsable(user);

    const claims = await this.claimsFor(user, session.id, session.deviceId);
    const { token, expiresIn } = await this.deps.tokens.sign(claims);

    return { accessToken: token, refreshToken: next, expiresIn };
  }

  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
  }

  async logoutEverywhere(userId: string): Promise<number> {
    return this.sessions.revokeAllForUser(userId, 'logout_all');
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async startSession(user: User, device: DeviceInfo): Promise<AuthTokens & { user: PublicUser }> {
    this.assertUsable(user);

    const deviceRow = await this.sessions.upsertDevice(device);
    const { session, refreshToken } = await this.sessions.issue(user.id, deviceRow.id);

    const claims = await this.claimsFor(user, session.id, deviceRow.id);
    const { token, expiresIn } = await this.deps.tokens.sign(claims);

    return { accessToken: token, refreshToken, expiresIn, user: toPublicUser(user) };
  }

  private assertUsable(user: User): void {
    if (user.disabledAt !== null)
      throw forbidden(ERROR_CODES.AUTH_ACCOUNT_DISABLED, 'This account has been disabled');
  }

  /** Memberships travel in the token so tenant validation needs no database read (§4.4). */
  private async claimsFor(user: User, sessionId: string, deviceId: string): Promise<AccessTokenClaims> {
    const rows = await this.db.select({
      tenantId: tenantMemberships.tenantId,
      roleId: tenantMemberships.roleId,
    }).from(tenantMemberships).where(and(eq(tenantMemberships.userId, user.id), eq(tenantMemberships.status, 'active')));

    return {
      sub: user.id,
      sid: sessionId,
      did: deviceId,
      sa: user.isSuperAdmin,
      memberships: rows.map(row => ({ t: row.tenantId, r: row.roleId })),
    };
  }

  private async findLiveOtp(identifier: string) {
    const [record] = await this.db.select().from(otpCodes).where(and(
      eq(otpCodes.identifier, identifier),
      isNull(otpCodes.consumedAt),
      isNull(otpCodes.supersededAt),
      sql`${otpCodes.expiresAt} > now()`,
    )).orderBy(desc(otpCodes.createdAt)).limit(1);

    return record ?? null;
  }

  private async assertNotResendingTooSoon(identifier: string): Promise<void> {
    const [recent] = await this.db.select({ lastSentAt: otpCodes.lastSentAt }).from(otpCodes).where(eq(otpCodes.identifier, identifier)).orderBy(desc(otpCodes.createdAt)).limit(1);

    if (!recent)
      return;

    const waited = (Date.now() - recent.lastSentAt.getTime()) / 1000;
    const cooldown = this.deps.config.otpResendCooldownSeconds;

    if (waited < cooldown) {
      throw badRequest(
        ERROR_CODES.OTP_RESEND_TOO_SOON,
        `Wait ${Math.ceil(cooldown - waited)} seconds before requesting another code`,
      );
    }
  }

  private async findOrCreateByPhone(phone: string): Promise<User> {
    const [existing] = await this.db.select().from(users).where(eq(users.phone, phone));
    if (existing)
      return existing;

    const [created] = await this.db.insert(users).values({ phone }).returning();
    if (!created)
      throw new Error('User insert returned no row');

    return created;
  }
}
