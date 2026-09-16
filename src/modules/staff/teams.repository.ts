import type { SQL } from 'drizzle-orm';
import type { Database } from '@/db/client';
import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import { teamLocations, teams, tenantMemberships, users } from '@/db/schema';

export type TeamRecord = typeof teams.$inferSelect & { memberCount: number };

type MembershipStatus = (typeof tenantMemberships.$inferSelect)['status'];

export interface TeamMemberRecord {
  id: string;
  userId: string;
  roleId: string;
  status: MembershipStatus;
  name: string | null;
  phone: string | null;
  email: string | null;
}

const MEMBER_COUNT = sql<number>`(
  SELECT count(*)::int FROM tenancy.tenant_memberships m WHERE m.team_id = tenancy.teams.id
)`;

/** Every read here is scoped to one tenant's live (not disbanded) crews. */
export class TeamsRepository {
  constructor(private readonly db: Database) {}

  /** For the shared grant helpers, which build their own SQL. */
  get database(): Database {
    return this.db;
  }

  async list(tenantId: string, conditions: SQL[], page: { limit: number; offset: number }): Promise<TeamRecord[]> {
    const rows = await this.db
      .select({ team: teams, memberCount: MEMBER_COUNT })
      .from(teams)
      .where(this.live(tenantId, conditions))
      .orderBy(asc(teams.name), asc(teams.id))
      .limit(page.limit)
      .offset(page.offset);

    return rows.map(row => ({ ...row.team, memberCount: row.memberCount }));
  }

  async count(tenantId: string, conditions: SQL[]): Promise<number> {
    const [total] = await this.db
      .select({ total: count() })
      .from(teams)
      .where(this.live(tenantId, conditions));

    return total?.total ?? 0;
  }

  async findById(tenantId: string, id: string): Promise<TeamRecord | null> {
    const [row] = await this.db
      .select({ team: teams, memberCount: MEMBER_COUNT })
      .from(teams)
      .where(and(this.live(tenantId, []), eq(teams.id, id)))
      .limit(1);

    return row === undefined ? null : { ...row.team, memberCount: row.memberCount };
  }

  /** The id back only if the caller's reach covers this crew. */
  async findIdWithin(tenantId: string, id: string, conditions: SQL[]): Promise<string | null> {
    const [row] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(this.live(tenantId, conditions), eq(teams.id, id)))
      .limit(1);

    return row?.id ?? null;
  }

  /** Disbanded crews keep their slug, so this spans them too. */
  async takenSlugs(tenantId: string): Promise<string[]> {
    const rows = await this.db.select({ slug: teams.slug }).from(teams).where(eq(teams.tenantId, tenantId));

    return rows.map(row => row.slug);
  }

  async create(values: typeof teams.$inferInsert, locationIds: readonly string[]): Promise<string> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.insert(teams).values(values).returning({ id: teams.id });

      if (locationIds.length > 0)
        await tx.insert(teamLocations).values(locationIds.map(locationId => ({ teamId: row!.id, locationId })));

      return row!.id;
    });
  }

  async update(tenantId: string, id: string, patch: Partial<typeof teams.$inferInsert>): Promise<void> {
    await this.db
      .update(teams)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, id)));
  }

  async softDelete(tenantId: string, id: string): Promise<void> {
    await this.db
      .update(teams)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, id)));
  }

  async replaceLocations(teamId: string, locationIds: readonly string[]): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.delete(teamLocations).where(eq(teamLocations.teamId, teamId));
      if (locationIds.length > 0)
        await tx.insert(teamLocations).values(locationIds.map(locationId => ({ teamId, locationId })));
    });
  }

  async findMembers(tenantId: string, teamId: string): Promise<TeamMemberRecord[]> {
    return this.db
      .select({
        id: tenantMemberships.id,
        userId: tenantMemberships.userId,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        name: users.name,
        phone: users.phone,
        email: users.email,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.teamId, teamId)))
      .orderBy(asc(users.name), asc(tenantMemberships.id));
  }

  async findMemberUserIds(tenantId: string, teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.teamId, teamId)));

    return rows.map(row => row.userId);
  }

  async isMemberOf(tenantId: string, teamId: string, membershipId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, membershipId),
        eq(tenantMemberships.teamId, teamId),
      ))
      .limit(1);

    return row !== undefined;
  }

  async findUserIdsOf(tenantId: string, membershipIds: readonly string[]): Promise<string[]> {
    if (membershipIds.length === 0)
      return [];

    const rows = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), inArray(tenantMemberships.id, [...membershipIds])));

    return rows.map(row => row.userId);
  }

  private live(tenantId: string, conditions: SQL[]): SQL {
    return and(eq(teams.tenantId, tenantId), isNull(teams.deletedAt), ...conditions)!;
  }
}
