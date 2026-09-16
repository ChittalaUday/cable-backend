import type { Database } from '@/db/client';
import type { User } from '@/db/schema';
import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { customers, otpCodes, tenantMemberships, tenants, users } from '@/db/schema';

export interface PublicMembership {
  tenantId: string;
  tenantName: string;
  roleId: string;
}

export class AuthRepository {
  constructor(private readonly db: Database) {}

  async findUserById(id: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.id, id));
    return user ?? null;
  }

  async findUserByPhone(phone: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.phone, phone));
    return user ?? null;
  }

  async findUserByEmail(email: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(eq(users.email, email));
    return user ?? null;
  }

  async findUserByIdentifier(identifier: string): Promise<User | null> {
    const [user] = await this.db.select().from(users).where(or(eq(users.email, identifier), eq(users.phone, identifier)));
    return user ?? null;
  }

  async findMembershipsFor(userId: string): Promise<PublicMembership[]> {
    return this.db.select({
      tenantId: tenantMemberships.tenantId,
      tenantName: tenants.name,
      roleId: tenantMemberships.roleId,
    })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, 'active')));
  }

  async findLiveOtp(identifier: string) {
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

  async supersedeAndCreateOtp(data: {
    identifier: string;
    channel: 'whatsapp' | 'sms';
    codeHash: string;
    maxAttempts: number;
    expiresAt: Date;
  }) {
    return this.db.transaction(async (tx) => {
      await tx.update(otpCodes)
        .set({ supersededAt: new Date() })
        .where(and(
          eq(otpCodes.identifier, data.identifier),
          isNull(otpCodes.consumedAt),
          isNull(otpCodes.supersededAt),
        ));

      return tx.insert(otpCodes).values(data);
    });
  }

  async incrementOtpAttempts(id: string) {
    return this.db.update(otpCodes)
      .set({ attempts: sql`${otpCodes.attempts} + 1` })
      .where(eq(otpCodes.id, id));
  }

  async consumeOtp(id: string) {
    return this.db.update(otpCodes)
      .set({ consumedAt: new Date() })
      .where(eq(otpCodes.id, id));
  }

  async createUser(data: { phone?: string | null; email?: string | null; name?: string | null; passwordHash?: string | null; customerCode?: string | null }): Promise<User> {
    const [user] = await this.db.insert(users).values(data).returning();
    return user!;
  }

  async findCustomerRecordsByPhone(phone: string) {
    return this.db.select().from(customers).where(eq(customers.phone, phone));
  }

  async createTenantMembership(data: { tenantId: string; userId: string; roleId: string; status: 'active' }) {
    return this.db.insert(tenantMemberships).values(data).onConflictDoNothing();
  }

  async linkCustomerUser(customerId: string, userId: string) {
    return this.db.update(customers)
      .set({ userId })
      .where(and(eq(customers.id, customerId), isNull(customers.userId)));
  }
}
