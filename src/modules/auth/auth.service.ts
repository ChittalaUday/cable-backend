import type { PublicMembership } from './auth.repository';
import type { DeviceInfo, SessionsService } from './sessions.service';
import type { AuditAction } from '@/constants/audit';
import type { Database } from '@/db/client';
import type { Session, User } from '@/db/schema';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { AccessTokenClaims, TokenSigner } from '@/security/tokens';
import type { MessagingService } from '@/services/messaging/messaging.service';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import { AUDIT_ACTIONS, AUDIT_ENTITIES } from '@/constants/audit';
import { customers, otpCodes, tenantMemberships, tenants, users } from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { badRequest, DomainError, forbidden, unauthorized } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { generateOtp, hashOtp, otpMatches } from '@/security/otp';
import { hashPassword, verifyPassword } from '@/security/password';
import { normalisePhone, to10DigitPhone } from '@/services/messaging/messaging.service';

import { normaliseEmail } from '@/utils/email';

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
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export type { PublicMembership };

export interface PublicUser {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  photoUrl: string | null;
}

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

export interface RequestOtpInput {
  phone: string;
  channel?: 'whatsapp' | 'sms';
}

export interface VerifyOtpInput {
  phone: string;
  code: string;
  device: DeviceInfo;
}

export type SessionResult = AuthTokens & { user: PublicUser; memberships: PublicMembership[] };

export interface LoginInput {
  identifier: string;
  password: string;
  device: DeviceInfo;
}

export class AuthService {
  constructor(
    private readonly db: Database,
    private readonly sessions: SessionsService,
    private readonly deps: { messaging: MessagingService; tokens: TokenSigner; config: AuthConfig },
  ) {}

  get otpTtlSeconds(): number {
    return this.deps.config.otpTtlSeconds;
  }

  async userById(id: string): Promise<PublicUser> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    if (!user)
      throw unauthorized(ERROR_CODES.AUTH_TOKEN_INVALID, 'Account no longer exists');

    return toPublicUser(user);
  }

  async membershipsFor(userId: string): Promise<PublicMembership[]> {
    return this.db.select({
      tenantId: tenantMemberships.tenantId,
      tenantName: tenants.name,
      roleId: tenantMemberships.roleId,
    })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active')));
  }

  async requestOtp(input: RequestOtpInput, context: AuditContext): Promise<{ channel: 'whatsapp' | 'sms' }> {
    const identifier = normalisePhone(input.phone, this.deps.config.defaultCountryCode);
    const channel = input.channel ?? 'whatsapp';

    try {
      await this.assertNotResendingTooSoon(identifier);
    }
    catch (error) {
      await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_REFUSED, actorId: null, entityId: identifier, metadata: { channel, reason: reasonOf(error) } });
      throw error;
    }

    const code = generateOtp(this.deps.config.otpLength);
    const expiresAt = new Date(Date.now() + this.deps.config.otpTtlSeconds * 1000);

    await this.db.transaction(async (tx) => {
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

    await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_REQUESTED, actorId: null, entityId: identifier, metadata: { channel } });

    return { channel };
  }

  async verifyOtp(input: VerifyOtpInput, context: AuditContext): Promise<SessionResult> {
    const identifier = normalisePhone(input.phone, this.deps.config.defaultCountryCode);

    const failed = async (error: unknown): Promise<never> => {
      await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_FAILED, actorId: null, entityId: identifier, metadata: { reason: reasonOf(error) } });
      throw error;
    };

    const record = await this.findLiveOtp(identifier);

    if (!record)
      await failed(unauthorized(ERROR_CODES.OTP_EXPIRED, 'No active code for this number'));

    if (record!.attempts >= record!.maxAttempts)
      await failed(badRequest(ERROR_CODES.OTP_TOO_MANY_ATTEMPTS, 'Too many attempts. Request a new code.'));

    if (!otpMatches(hashOtp(input.code, identifier), record!.codeHash)) {
      await this.db.update(otpCodes)
        .set({ attempts: sql`${otpCodes.attempts} + 1` })
        .where(eq(otpCodes.id, record!.id));

      await failed(unauthorized(ERROR_CODES.OTP_INVALID, 'Incorrect code'));
    }

    await this.db.update(otpCodes)
      .set({ consumedAt: new Date() })
      .where(eq(otpCodes.id, record!.id));

    const user = await this.findOrCreateByPhone(identifier);
    const session = await this.startSession(user, input.device).catch(failed);

    await this.record(context, { action: AUDIT_ACTIONS.AUTH_OTP_VERIFIED, actorId: user.id, entityId: user.id, metadata: { identifier, device: input.device.clientDeviceId } });

    return session;
  }

  async login(input: LoginInput, context: AuditContext): Promise<SessionResult> {
    const identifier = normaliseEmail(input.identifier) ?? '';

    const asPhone = identifier.includes('@')
      ? null
      : to10DigitPhone(identifier);

    const [user] = await this.db.select().from(users).where(
      asPhone === null ? eq(users.email, identifier) : or(eq(users.email, identifier), eq(users.phone, asPhone)),
    ).limit(1);

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

      const [user] = await this.db.select().from(users).where(eq(users.id, session.userId));
      if (!user)
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
    await audit.log(this.db, { ...context, actorId: event.actorId }, {
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
    if (user.disabledAt !== null)
      throw forbidden(ERROR_CODES.AUTH_ACCOUNT_DISABLED, 'This account has been disabled');
  }

  private async claimsFor(user: User, sessionId: string, deviceId: string): Promise<AccessTokenClaims> {
    const rows = await this.db.select({
      tenantId: tenantMemberships.tenantId,
      roleId: tenantMemberships.roleId,
    }).from(tenantMemberships).where(and(eq(tenantMemberships.userId, user.id), eq(tenantMemberships.status, 'active')));

    return {
      sub: user.id,
      sid: sessionId,
      did: deviceId,
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

  private async linkSubscriberMemberships(user: User): Promise<void> {
    if (user.phone === null)
      return;

    await this.db
      .update(customers)
      .set({ userId: user.id, updatedAt: new Date() })
      .where(and(
        eq(customers.phone, user.phone),
        isNull(customers.userId),
        isNull(customers.deletedAt),
      ));

    const owned = await this.db
      .selectDistinct({ tenantId: customers.tenantId })
      .from(customers)
      .where(and(eq(customers.userId, user.id), isNull(customers.deletedAt)));

    if (owned.length === 0)
      return;

    await this.db
      .insert(tenantMemberships)
      .values(owned.map(row => ({ userId: user.id, tenantId: row.tenantId, roleId: SYSTEM_ROLES.CUSTOMER })))
      .onConflictDoNothing({ target: [tenantMemberships.userId, tenantMemberships.tenantId] });
  }

  private async findOrCreateByPhone(phone: string): Promise<User> {
    const nationalPhone = to10DigitPhone(phone);
    const [existing] = await this.db.select().from(users).where(eq(users.phone, nationalPhone));
    if (existing)
      return existing;

    const [created] = await this.db.insert(users).values({ phone: nationalPhone }).returning();
    if (!created)
      throw new Error('User insert returned no row');

    return created;
  }
}
