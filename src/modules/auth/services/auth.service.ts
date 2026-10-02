import type { TokenPayload } from 'google-auth-library';
import type { UserResponse } from '../auth.schema';
import type { PublicMembership } from '../repositories/auth.repository';
import type { DeviceInfo, SessionsService } from './sessions.service';
import type { AuditAction } from '@/constants/audit';
import type { Database } from '@/db/client';
import type { Session, User } from '@/db/schema';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { AccessTokenClaims, TokenSigner } from '@/security/tokens';
import type { MessagingService } from '@/services/messaging/messaging.service';
import type { MessageChannel } from '@/services/messaging/messaging.types';
import { randomUUID } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { ERROR_CODES } from '@/errors';
import { badRequest, DomainError, forbidden, unauthorized } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { generateOtp, hashOtp, otpMatches } from '@/security/otp';
import { hashPassword, verifyPassword } from '@/security/password';
import { normalisePhone, to10DigitPhone } from '@/services/messaging/messaging.service';

import { normaliseEmail } from '@/utils/email';
import { AuthRepository } from '../repositories/auth.repository';

type PhoneChannel = 'whatsapp' | 'sms';

function isPhoneChannel(channel: MessageChannel): channel is PhoneChannel {
  return channel === 'whatsapp' || channel === 'sms';
}

function reasonOf(error: unknown): string {
  return error instanceof DomainError ? error.code : 'UNKNOWN';
}

let dummyPasswordHash: Promise<string> | null = null;

async function unknownAccountHash(): Promise<string> {
  dummyPasswordHash ??= hashPassword(randomUUID());
  return dummyPasswordHash;
}

export interface AuthConfig {
  otpLength: number;
  otpTtlSeconds: number;
  otpMaxAttempts: number;
  otpResendCooldownSeconds: number;
  defaultCountryCode: string;
  /** A password sign-in has to be finished with an emailed code. */
  emailOtpEnabled: boolean;
  /** How long the proof-of-password is good for. */
  challengeTtlSeconds: number;
  /** Audiences a Google ID token may be issued for. Empty disables Google. */
  googleClientIds: string[];
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type { PublicMembership };

export type PublicUser = UserResponse;

function toClaimMemberships(memberships: PublicMembership[]): AccessTokenClaims['memberships'] {
  return memberships.map(m => ({ t: m.tenantId, r: m.roleId }));
}

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    photoUrl: user.photoUrl,
  };
}

/**
 * A code goes to a phone, or to the email of whoever holds `challengeToken`.
 *
 * The email side is deliberately not addressable by email: the token is proof
 * that the account's password was just accepted, so a code can only be sent to
 * someone who already got that far. Taking a bare email here would turn the
 * endpoint into a way to mail anyone a code, and — paired with verify — a way
 * past the password entirely.
 */
export interface RequestOtpInput {
  phone?: string;
  channel?: 'whatsapp' | 'sms';
  challengeToken?: string;
}

export interface VerifyOtpInput {
  phone?: string;
  challengeToken?: string;
  code: string;
  device: DeviceInfo;
}

/** Where a code is going, and to whom when that is already known. */
interface OtpTarget {
  identifier: string;
  channel: MessageChannel;
  userId: string | null;
}

/** A password was right, but the sign-in is not finished. */
export interface OtpChallenge {
  status: 'otp_required';
  challengeToken: string;
  channel: MessageChannel;
  expiresInSeconds: number;
  nextCooldownSeconds: number;
}

export type SessionResult = AuthTokens & { user: PublicUser; memberships: PublicMembership[] };

export interface LoginInput {
  identifier: string;
  password: string;
  device: DeviceInfo;
}

export class AuthService {
  private readonly repo: AuthRepository;

  constructor(
    repoOrDb: AuthRepository | Database,
    private readonly sessions: SessionsService,
    private readonly deps: {
      messaging: MessagingService;
      tokens: TokenSigner;
      config: AuthConfig;
    },
  ) {
    this.repo = repoOrDb instanceof AuthRepository ? repoOrDb : new AuthRepository(repoOrDb);
  }

  private readonly googleClient = new OAuth2Client();

  /**
   * What a client may offer on its login screen.
   *
   * The phone channels come from the messaging service's live view, so a
   * provider that has been failing drops out here and the app stops offering
   * it until it recovers.
   */
  loginConfig(): {
    password: boolean;
    passwordNeedsEmailOtp: boolean;
    phoneOtp: boolean;
    phoneOtpChannels: PhoneChannel[];
    defaultPhoneOtpChannel: PhoneChannel | null;
    google: boolean;
  } {
    const live = this.deps.messaging.liveChannels.filter(isPhoneChannel);
    const preferred = this.deps.messaging.defaultChannel;
    const preferredIsLive = isPhoneChannel(preferred) && live.includes(preferred);

    return {
      password: true,
      // An emailed second step needs a configured sender, not just the flag.
      passwordNeedsEmailOtp: this.deps.config.emailOtpEnabled && this.deps.messaging.supports('email'),
      phoneOtp: live.length > 0,
      phoneOtpChannels: preferredIsLive
        ? [preferred, ...live.filter(channel => channel !== preferred)]
        : live,
      defaultPhoneOtpChannel: preferredIsLive ? preferred : live[0] ?? null,
      google: this.deps.config.googleClientIds.length > 0,
    };
  }

  get otpTtlSeconds(): number {
    return this.deps.config.otpTtlSeconds;
  }

  async userById(id: string): Promise<PublicUser> {
    return toPublicUser(await this.userOrFail(id));
  }

  async membershipsFor(userId: string): Promise<PublicMembership[]> {
    return this.repo.findMembershipsFor(userId);
  }

  async requestOtp(input: RequestOtpInput, context: AuditContext): Promise<{ channel: MessageChannel; nextCooldownSeconds: number }> {
    const target = await this.otpTarget(input);
    const { identifier } = target;
    let channel = target.channel;

    let previousAttempts = 0;
    try {
      previousAttempts = await this.assertNotResendingTooSoon(identifier);
    }
    catch (error) {
      await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_REFUSED, actorId: null, entityId: identifier, metadata: { channel, reason: reasonOf(error) } });
      throw error;
    }

    const nextResendAttempts = previousAttempts >= 5 ? 1 : previousAttempts + 1;
    const code = generateOtp(this.deps.config.otpLength);
    const expiresAt = new Date(Date.now() + this.deps.config.otpTtlSeconds * 1000);

    const otpId = await this.repo.supersedeAndCreateOtp({
      identifier,
      channel,
      codeHash: hashOtp(code, identifier),
      maxAttempts: this.deps.config.otpMaxAttempts,
      resendAttempts: nextResendAttempts,
      expiresAt,
    });

    try {
      // WhatsApp may be down and the message may have gone by SMS instead. The
      // caller is told which, because the person has to know where to look.
      const sent = await this.deps.messaging.send({
        to: identifier,
        channel,
        subject: 'Your Satya Cable verification code',
        text: `${code} is your Satya Cable verification code. It expires in ${Math.round(this.deps.config.otpTtlSeconds / 60)} minutes.`,
      });

      channel = sent.channel;
    }
    catch (error) {
      // Our failure to deliver must not cost the caller a rung on the ladder,
      // and it must not reset rows other than the one just written.
      await this.repo.resetResendAttempts(otpId).catch(() => {});
      throw error;
    }

    await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_REQUESTED, actorId: null, entityId: identifier, metadata: { channel } });

    return { channel, nextCooldownSeconds: this.cooldownFor(nextResendAttempts) };
  }

  async verifyOtp(input: VerifyOtpInput, context: AuditContext): Promise<SessionResult> {
    const target = await this.otpTarget(input);
    const { identifier } = target;

    const failed = async (error: unknown): Promise<never> => {
      await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_FAILED, actorId: null, entityId: identifier, metadata: { reason: reasonOf(error) } });
      throw error;
    };

    const record = await this.repo.findLiveOtp(identifier);

    if (!record)
      await failed(unauthorized(ERROR_CODES.OTP_EXPIRED, 'No active code for this number'));

    if (record!.attempts >= record!.maxAttempts)
      await failed(badRequest(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.'));

    if (!otpMatches(hashOtp(input.code, identifier), record!.codeHash)) {
      const nextAttempts = record!.attempts + 1;
      await this.repo.countOtpAttempt(record!.id);

      if (nextAttempts >= record!.maxAttempts)
        await failed(badRequest(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.'));

      const remaining = record!.maxAttempts - nextAttempts;
      await failed(unauthorized(
        ERROR_CODES.OTP_INVALID,
        `Incorrect code. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`,
      ));
    }

    await this.repo.consumeOtp(record!.id);

    // A phone code is the sign-up: the number is the account. An emailed one
    // finishes a password sign-in, so the account is already known.
    const user = target.userId === null
      ? await this.findOrCreateByPhone(identifier)
      : await this.userOrFail(target.userId);

    const session = await this.startSession(user, input.device).catch(failed);

    await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_VERIFIED, actorId: user.id, entityId: user.id, metadata: { identifier, device: input.device.clientDeviceId } });

    return session;
  }

  async login(input: LoginInput, context: AuditContext): Promise<SessionResult | OtpChallenge> {
    const identifier = normaliseEmail(input.identifier) ?? '';

    const asPhone = identifier.includes('@')
      ? null
      : to10DigitPhone(identifier);

    const user = await this.repo.findUserByLogin(identifier, asPhone);

    const failed = async (error: unknown): Promise<never> => {
      await this.record(context, {
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        actorId: user?.id ?? null,
        entityId: user?.id ?? identifier,
        metadata: { identifier, reason: reasonOf(error), device: input.device.clientDeviceId },
      });
      throw error;
    };

    if (!user) {
      await verifyPassword(input.password, await unknownAccountHash());
      await failed(unauthorized(ERROR_CODES.AUTH_CREDENTIALS_INVALID, 'Invalid credentials'));
    }

    if (user!.passwordHash === null)
      await failed(unauthorized(ERROR_CODES.AUTH_PASSWORD_NOT_SET, 'This account signs in with Google'));

    if (!await verifyPassword(input.password, user!.passwordHash!))
      await failed(unauthorized(ERROR_CODES.AUTH_CREDENTIALS_INVALID, 'Invalid credentials'));

    /*
     * With email codes on, the password is only the first half. The account
     * needs an address to send to, so a phone-only login is let straight
     * through rather than being locked out of a factor it cannot receive.
     */
    if (this.deps.config.emailOtpEnabled && user!.email !== null) {
      const challenge = await this.challengeByEmail(user!, context);

      await this.record(context, {
        action: AUDIT_ACTIONS.AUTH_LOGIN_OTP_REQUIRED,
        actorId: user!.id,
        entityId: user!.id,
        metadata: { identifier, channel: challenge.channel, device: input.device.clientDeviceId },
      });

      return challenge;
    }

    const session = await this.startSession(user!, input.device).catch(failed);

    await this.record(context, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      actorId: user!.id,
      entityId: user!.id,
      metadata: { identifier, device: input.device.clientDeviceId },
    });

    return session;
  }

  async refresh(refreshToken: string, context: AuditContext): Promise<AuthTokens> {
    let userId: string | null = null;
    let sessionId: string | null = null;

    try {
      const { session, refreshToken: next } = await this.sessions.rotate(refreshToken, async (replayed) => {
        sessionId = replayed.id;
        userId = replayed.userId;
        await this.record(context, {
          action: AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED,
          actorId: replayed.userId,
          entityId: replayed.id,
          metadata: { deviceId: replayed.deviceId },
        });
      });

      userId = session.userId;
      sessionId = session.id;

      const user = await this.repo.findUserById(session.userId);
      if (user === null)
        throw unauthorized(ERROR_CODES.AUTH_REFRESH_INVALID, 'Refresh token is not valid');

      this.assertUsable(user);
      await this.assertCredentialsUnchanged(user, session);

      const claims = await this.claimsFor(user, session.id, session.deviceId);
      const { token, expiresIn } = await this.deps.tokens.sign(claims);

      await this.record(context, { action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED, actorId: user.id, entityId: session.id });

      return { accessToken: token, refreshToken: next, expiresIn };
    }
    catch (error) {
      await this.record(context, {
        action: AUDIT_ACTIONS.AUTH_TOKEN_REFRESH_FAILED,
        actorId: userId,
        entityId: sessionId ?? userId ?? 'unknown',
        metadata: { reason: reasonOf(error) },
      });
      throw error;
    }
  }

  async logout(sessionId: string, context: AuditContext): Promise<void> {
    await this.sessions.revoke(sessionId, 'logout');
    await this.record(context, { action: AUDIT_ACTIONS.AUTH_LOGOUT, actorId: context.actorId, entityId: sessionId });
  }

  async logoutEverywhere(userId: string, context: AuditContext): Promise<number> {
    const revoked = await this.sessions.revokeAllForUser(userId, 'logout_all');
    await this.record(context, { action: AUDIT_ACTIONS.AUTH_LOGOUT_ALL, actorId: userId, entityId: userId, metadata: { revokedSessions: revoked } });

    return revoked;
  }

  private async record(
    context: AuditContext,
    event: { action: AuditAction; actorId: string | null; entityId: string; metadata?: Record<string, unknown> },
  ): Promise<void> {
    await audit.log(this.repo.database, { ...context, actorId: event.actorId }, {
      action: event.action,
      entityType: AUDIT_ENTITIES.AUTH,
      entityId: event.entityId,
      metadata: event.metadata ?? null,
    });
  }

  private async startSession(user: User, device: DeviceInfo): Promise<SessionResult> {
    this.assertUsable(user);

    await this.linkSubscriberMemberships(user);

    const deviceRow = await this.sessions.upsertDevice(device);
    const { session, refreshToken } = await this.sessions.issue(user.id, deviceRow.id);

    const memberships = await this.membershipsFor(user.id);
    const { token, expiresIn } = await this.deps.tokens.sign({
      sub: user.id,
      sid: session.id,
      did: deviceRow.id,
      memberships: toClaimMemberships(memberships),
    });

    return {
      accessToken: token,
      refreshToken,
      expiresIn,
      user: toPublicUser(user),
      memberships,
    };
  }

  private async assertCredentialsUnchanged(user: User, session: Session): Promise<void> {
    if (session.issuedAt.getTime() >= user.credentialsChangedAt.getTime())
      return;

    await this.sessions.revoke(session.id, 'credentials_changed');
    throw unauthorized(ERROR_CODES.AUTH_SESSION_REVOKED, 'Credentials changed — sign in again');
  }

  private assertUsable(user: User): void {
    if (user.deletedAt !== null)
      throw unauthorized(ERROR_CODES.AUTH_TOKEN_INVALID, 'Account no longer exists');

    if (user.disabledAt !== null)
      throw forbidden(ERROR_CODES.AUTH_ACCOUNT_DISABLED, 'This account has been disabled');
  }

  private async claimsFor(user: User, sessionId: string, deviceId: string): Promise<AccessTokenClaims> {
    const rows = await this.repo.findClaimMemberships(user.id);

    return {
      sub: user.id,
      sid: sessionId,
      did: deviceId,
      memberships: rows.map(row => ({ t: row.tenantId, r: row.roleId })),
    };
  }

  /**
   * Sign in with a Google ID token.
   *
   * The token is only accepted if it was minted for one of our own client ids —
   * otherwise any app's Google token would work here.
   */
  async googleSignIn(idToken: string, device: DeviceInfo, context: AuditContext): Promise<SessionResult> {
    const failed = async (error: unknown): Promise<never> => {
      await this.record(context, {
        action: AUDIT_ACTIONS.AUTH_LOGIN_FAILED,
        actorId: null,
        entityId: 'google',
        metadata: { method: 'google', reason: reasonOf(error), device: device.clientDeviceId },
      });
      throw error;
    };

    if (this.deps.config.googleClientIds.length === 0)
      await failed(forbidden(ERROR_CODES.AUTH_GOOGLE_TOKEN_INVALID, 'Google sign-in is not enabled'));

    let payload: TokenPayload | undefined;

    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: this.deps.config.googleClientIds,
      });
      payload = ticket.getPayload();
    }
    catch {
      await failed(unauthorized(ERROR_CODES.AUTH_GOOGLE_TOKEN_INVALID, 'Google token is not valid'));
    }

    // An unverified address must not be able to claim an existing account.
    if (payload?.sub === undefined || payload.email === undefined || payload.email_verified !== true)
      await failed(unauthorized(ERROR_CODES.AUTH_GOOGLE_TOKEN_INVALID, 'Google token is missing a verified email'));

    const user = await this.findOrCreateByGoogle(payload!.sub, normaliseEmail(payload!.email)!, payload!.name ?? null, payload!.picture ?? null);

    if (user.disabledAt !== null)
      await failed(forbidden(ERROR_CODES.AUTH_ACCOUNT_DISABLED, 'This account has been disabled'));

    const session = await this.startSession(user, device).catch(failed);

    await this.record(context, {
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED,
      actorId: user.id,
      entityId: user.id,
      metadata: { method: 'google', identifier: user.email, device: device.clientDeviceId },
    });

    return session;
  }

  /** Mail a code to the account and hand back proof the password was accepted. */
  private async challengeByEmail(user: User, context: AuditContext): Promise<OtpChallenge> {
    const { token } = await this.deps.tokens.signChallenge(user.id, this.deps.config.challengeTtlSeconds);

    /*
     * Signing in twice in quick succession must not be refused for asking too
     * soon — the code already in their inbox is still the live one, so the
     * cooldown is reported rather than raised.
     */
    const sent = await this.requestOtp({ challengeToken: token }, context).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.code === ERROR_CODES.OTP_RESEND_TOO_SOON)
        return { channel: 'email' as MessageChannel, nextCooldownSeconds: await this.liveCooldown(user.email!) };

      throw error;
    });

    return {
      status: 'otp_required',
      challengeToken: token,
      channel: sent.channel,
      expiresInSeconds: this.deps.config.otpTtlSeconds,
      nextCooldownSeconds: sent.nextCooldownSeconds,
    };
  }

  /**
   * Resolve who a code is for.
   *
   * A challenge token names the account and pins the channel to its email; a
   * phone number stands on its own and takes the channel the caller asked for.
   */
  private async otpTarget(input: RequestOtpInput | VerifyOtpInput): Promise<OtpTarget> {
    if (input.challengeToken !== undefined && input.challengeToken !== '') {
      if (!this.deps.config.emailOtpEnabled)
        throw badRequest(ERROR_CODES.OTP_EMAIL_NOT_SUPPORTED, 'Email codes are not enabled');

      const userId = await this.deps.tokens.verifyChallenge(input.challengeToken)
        .catch(() => { throw unauthorized(ERROR_CODES.AUTH_TOKEN_INVALID, 'This sign-in attempt has expired. Start again.'); });

      const user = await this.userOrFail(userId);

      if (user.email === null)
        throw badRequest(ERROR_CODES.OTP_EMAIL_NOT_SUPPORTED, 'This account has no email address');

      return { identifier: user.email, channel: 'email', userId: user.id };
    }

    if (input.phone === undefined || input.phone === '')
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A phone number is required');

    return {
      identifier: normalisePhone(input.phone, this.deps.config.defaultCountryCode),
      channel: ('channel' in input ? input.channel : undefined) ?? this.deps.messaging.defaultChannel,
      userId: null,
    };
  }

  /** The escalating ladder: each unverified resend costs one more interval. */
  private cooldownFor(resendAttempts: number): number {
    return this.deps.config.otpResendCooldownSeconds * Math.max(1, resendAttempts);
  }

  /** What the ladder is asking for right now, without sending anything. */
  private async liveCooldown(identifier: string): Promise<number> {
    const recent = await this.repo.findStandingOtp(identifier);

    return this.cooldownFor(recent?.resendAttempts ?? 1);
  }

  private async userOrFail(id: string): Promise<User> {
    const user = await this.repo.findLiveUserById(id);

    if (user === null)
      throw unauthorized(ERROR_CODES.AUTH_TOKEN_INVALID, 'Account no longer exists');

    return user;
  }

  private async findOrCreateByGoogle(googleSub: string, email: string, name: string | null, photoUrl: string | null): Promise<User> {
    const bySub = await this.repo.findUserByGoogleSub(googleSub);
    if (bySub !== null)
      return bySub;

    // A password account signing in with Google for the first time keeps its id
    // and its memberships — linking beats creating a second account.
    const byEmail = await this.repo.findLiveUserByEmail(email);

    if (byEmail !== null)
      return await this.repo.linkGoogleSub(byEmail.id, googleSub, byEmail.photoUrl ?? photoUrl) ?? byEmail;

    const created = await this.repo.createUser({ email, googleSub, name, photoUrl });

    await this.linkSubscriberMemberships(created);
    return created;
  }

  private async assertNotResendingTooSoon(identifier: string): Promise<number> {
    // Only a code still standing holds the ladder. A used one has done its job —
    // the next request is a fresh sign-in, not a resend, and throttling it would
    // leave the caller holding a challenge with no code to answer. A superseded
    // one has a successor, which is the row this then finds.
    const recent = await this.repo.findStandingOtp(identifier);

    if (recent === null)
      return 0;

    const waited = (Date.now() - recent.lastSentAt.getTime()) / 1000;
    const cooldown = this.cooldownFor(recent.resendAttempts);

    if (waited < cooldown) {
      throw badRequest(
        ERROR_CODES.OTP_RESEND_TOO_SOON,
        `Wait ${Math.ceil(cooldown - waited)} seconds before requesting another code`,
      );
    }

    return recent.resendAttempts;
  }

  private async linkSubscriberMemberships(user: User): Promise<void> {
    if (user.phone === null)
      return;

    const tenantIds = await this.repo.claimCustomerRecords(user.id, user.phone);
    await this.repo.restoreSubscriberMemberships(user.id, tenantIds);
  }

  private async findOrCreateByPhone(phone: string): Promise<User> {
    const nationalPhone = to10DigitPhone(phone);
    const existing = await this.repo.findUserByPhone(nationalPhone);

    return existing ?? this.repo.createUser({ phone: nationalPhone });
  }
}
