import type { Database } from '@/db/client';
import type { OtpCode, User } from '@/db/schema';
import type { PermissionKey, PermissionScope } from '@/security/permissions';
import { and, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import { customers, otpCodes, rolePermissions, tenantMemberships, tenants, users } from '@/db/schema';

export interface MembershipPermission {
  key: PermissionKey;
  scope: PermissionScope;
}

export interface PublicMembership {
  membershipId: string;
  tenantId: string;
  tenantName: string;
  roleId: string;
  status: string;
  teamId: string | null;
  permissionVersion: number;
  permissions: MembershipPermission[];
}

export interface ClaimMembership {
  tenantId: string;
  roleId: string;
}

export interface NewOtp {
  identifier: string;
  channel: OtpCode['channel'];
  codeHash: string;
  maxAttempts: number;
  resendAttempts: number;
  expiresAt: Date;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  async findLiveUserById(id: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)))
      .limit(1);

    return user ?? null;
  }

  /** Used on refresh, where `assertUsable` — not the query — decides on a dead row. */
  async findUserById(id: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id)).limit(1);
    return user ?? null;
  }

  async findUserByPhone(phone: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.phone, phone)).limit(1);
    return user ?? null;
  }

  async findUserByGoogleSub(googleSub: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.googleSub, googleSub)).limit(1);
    return user ?? null;
  }

  async findLiveUserByEmail(email: string): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(and(eq(users.email, email), isNull(users.deletedAt)))
      .limit(1);

    return user ?? null;
  }

  /** Sign-in lookup: an email, or an email-or-phone when the input parses as a number. */
  async findUserByLogin(email: string, phone: string | null): Promise<User | null> {
    const [user] = await this.db
      .select()
      .from(users)
      .where(phone === null ? eq(users.email, email) : or(eq(users.email, email), eq(users.phone, phone)))
      .limit(1);

    return user ?? null;
  }

  async createUser(values: typeof users.$inferInsert): Promise<User> {
    const [created] = await this.db.insert(users).values(values).returning();

    if (!created)
      throw new Error('User insert returned no row');

    return created;
  }

  async linkGoogleSub(userId: string, googleSub: string, photoUrl: string | null): Promise<User | null> {
    const [linked] = await this.db
      .update(users)
      .set({ googleSub, photoUrl, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .returning();

    return linked ?? null;
  }

  async findMembershipsFor(userId: string): Promise<PublicMembership[]> {
    const rows = await this.db
      .select({
        membershipId: tenantMemberships.id,
        tenantId: tenantMemberships.tenantId,
        tenantName: tenants.name,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        teamId: tenantMemberships.teamId,
        permissionVersion: tenantMemberships.permissionVersion,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(
        eq(tenantMemberships.userId, userId),
        isNull(tenantMemberships.deletedAt),
        eq(tenantMemberships.status, 'active'),
      ));

    if (rows.length === 0)
      return [];

    const roleIds = [...new Set(rows.map(row => row.roleId))];
    const grants = await this.db
      .select({ roleId: rolePermissions.roleId, key: rolePermissions.permissionKey, scope: rolePermissions.scope })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, roleIds));

    const grantsByRole = new Map<string, MembershipPermission[]>();
    for (const grant of grants) {
      const list = grantsByRole.get(grant.roleId) ?? [];
      list.push({ key: grant.key as PermissionKey, scope: grant.scope });
      grantsByRole.set(grant.roleId, list);
    }

    return rows.map(row => ({ ...row, permissions: grantsByRole.get(row.roleId) ?? [] }));
  }

  /**
   * Memberships that go into an access token. `deleted_at` matters here as much
   * as it does in `findMembershipsFor`: without it a removed staff member keeps
   * naming the tenant in every token they refresh.
   */
  async findClaimMemberships(userId: string): Promise<ClaimMembership[]> {
    return this.db
      .select({ tenantId: tenantMemberships.tenantId, roleId: tenantMemberships.roleId })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.userId, userId),
        isNull(tenantMemberships.deletedAt),
        eq(tenantMemberships.status, 'active'),
      ));
  }

  async findLiveOtp(identifier: string): Promise<OtpCode | null> {
    const [record] = await this.db
      .select()
      .from(otpCodes)
      .where(and(
        eq(otpCodes.identifier, identifier),
        isNull(otpCodes.consumedAt),
        isNull(otpCodes.supersededAt),
        sql`${otpCodes.expiresAt} > now()`,
      ))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    return record ?? null;
  }

  /** The standing code for an identifier, expired or not — it still holds the resend ladder. */
  async findStandingOtp(identifier: string): Promise<Pick<OtpCode, 'id' | 'lastSentAt' | 'resendAttempts'> | null> {
    const [recent] = await this.db
      .select({ id: otpCodes.id, lastSentAt: otpCodes.lastSentAt, resendAttempts: otpCodes.resendAttempts })
      .from(otpCodes)
      .where(and(
        eq(otpCodes.identifier, identifier),
        isNull(otpCodes.consumedAt),
        isNull(otpCodes.supersededAt),
      ))
      .orderBy(desc(otpCodes.createdAt))
      .limit(1);

    return recent ?? null;
  }

  /** Supersede whatever is standing and insert the new code in one transaction. */
  async supersedeAndCreateOtp(data: NewOtp): Promise<string> {
    return this.db.transaction(async (tx) => {
      await tx
        .update(otpCodes)
        .set({ supersededAt: new Date() })
        .where(and(
          eq(otpCodes.identifier, data.identifier),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ));

      const [created] = await tx.insert(otpCodes).values(data).returning({ id: otpCodes.id });
      return created!.id;
    });
  }

  /** Delivery failed, so the attempt must not count against the ladder. */
  async resetResendAttempts(otpId: string): Promise<void> {
    await this.db.update(otpCodes).set({ resendAttempts: 0 }).where(eq(otpCodes.id, otpId));
  }

  async countOtpAttempt(otpId: string): Promise<void> {
    await this.db
      .update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, otpId));
  }

  async consumeOtp(otpId: string): Promise<void> {
    await this.db
      .update(otpCodes)
      .set({ consumedAt: new Date(), resendAttempts: 0 })
      .where(eq(otpCodes.id, otpId));
  }

  /** Claim the customer rows that carry this phone, then return the tenants they sit in. */
  async claimCustomerRecords(userId: string, phone: string): Promise<string[]> {
    await this.db
      .update(customers)
      .set({ userId, updatedAt: new Date() })
      .where(and(
        eq(customers.phone, phone),
        isNull(customers.userId),
        isNull(customers.deletedAt),
      ));

    const owned = await this.db
      .selectDistinct({ tenantId: customers.tenantId })
      .from(customers)
      .where(and(eq(customers.userId, userId), isNull(customers.deletedAt)));

    return owned.map(row => row.tenantId);
  }

  // A subscriber whose membership was removed still owns the account rows, so
  // signing in again restores it; DO NOTHING would leave them without one.
  async restoreSubscriberMemberships(userId: string, tenantIds: readonly string[]): Promise<void> {
    if (tenantIds.length === 0)
      return;

    await this.db
      .insert(tenantMemberships)
      .values(tenantIds.map(tenantId => ({ userId, tenantId, roleId: SYSTEM_ROLES.CUSTOMER })))
      .onConflictDoUpdate({
        target: [tenantMemberships.userId, tenantMemberships.tenantId],
        set: { deletedAt: null, updatedAt: new Date() },
        setWhere: isNotNull(tenantMemberships.deletedAt),
      });
  }
}
