import type { SQL } from 'drizzle-orm';
import type { AreaGrants } from '../staff.grants';
import type { Database, Transaction } from '@/db/client';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  membershipLocations,
  teamLocations,
  teamMemberLocations,
  teams,
  tenantMemberships,
  users,
} from '@/db/schema';
import { areaGrantsFor, firstNodeOutside } from '../staff.grants';

export interface StaffRow {
  id: string;
  userId: string;
  roleId: string;
  status: string;
  teamId: string | null;
  isTeamLeader: boolean;
  createdAt: Date;
  updatedAt: Date;
  name: string | null;
  email: string | null;
  phone: string | null;
  photoUrl: string | null;
  teamName: string | null;
  teamSlug: string | null;
}

export interface StaffMembershipValues {
  userId: string;
  tenantId: string;
  roleId: string;
  status: typeof tenantMemberships.$inferInsert['status'];
  teamId: string | null;
}

export interface ExistingUser {
  id: string;
  name: string | null;
  deletedAt: Date | null;
}

export class StaffRepository {
  constructor(private readonly db: Database) {}

  /** The audit trail is written by the service but must land on this same executor. */
  get database(): Database {
    return this.db;
  }

  private selectStaff() {
    return this.db
      .select({
        id: tenantMemberships.id,
        userId: tenantMemberships.userId,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        teamId: tenantMemberships.teamId,
        isTeamLeader: sql<boolean>`coalesce(${teams.leaderMembershipId} = ${tenantMemberships.id}, false)`,
        createdAt: tenantMemberships.createdAt,
        updatedAt: tenantMemberships.updatedAt,
        name: users.name,
        email: users.email,
        phone: users.phone,
        photoUrl: users.photoUrl,
        teamName: teams.name,
        teamSlug: teams.slug,
      })
      .from(tenantMemberships)
      .innerJoin(users, and(eq(users.id, tenantMemberships.userId), isNull(users.deletedAt)))
      .leftJoin(teams, eq(teams.id, tenantMemberships.teamId))
      .$dynamic();
  }

  buildFilters(tenantId: string, roleIds: readonly string[], reach: SQL[], query: {
    roleId?: string;
    status?: typeof tenantMemberships.$inferSelect['status'];
    teamId?: string;
    q?: string;
    nodeCondition?: SQL;
  }): (SQL | undefined)[] {
    const filters: (SQL | undefined)[] = [
      eq(tenantMemberships.tenantId, tenantId),
      isNull(tenantMemberships.deletedAt),
      inArray(tenantMemberships.roleId, [...roleIds]),
      ...reach,
    ];

    if (query.roleId !== undefined)
      filters.push(eq(tenantMemberships.roleId, query.roleId));
    if (query.status !== undefined)
      filters.push(eq(tenantMemberships.status, query.status));
    if (query.teamId !== undefined) {
      filters.push(query.teamId === 'null'
        ? isNull(tenantMemberships.teamId)
        : eq(tenantMemberships.teamId, query.teamId));
    }
    if (query.nodeCondition !== undefined)
      filters.push(query.nodeCondition);
    if (query.q !== undefined) {
      const term = `%${query.q}%`;
      filters.push(or(ilike(users.name, term), ilike(users.email, term), ilike(users.phone, term)));
    }

    return filters;
  }

  async listStaff(filters: (SQL | undefined)[], page: { limit: number; offset: number }): Promise<{ rows: StaffRow[]; total: number }> {
    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.selectStaff()
        .where(where)
        .orderBy(desc(tenantMemberships.createdAt), desc(tenantMemberships.id))
        .limit(page.limit)
        .offset(page.offset),
      this.db
        .select({ total: count() })
        .from(tenantMemberships)
        .innerJoin(users, and(eq(users.id, tenantMemberships.userId), isNull(users.deletedAt)))
        .leftJoin(teams, eq(teams.id, tenantMemberships.teamId))
        .where(where),
    ]);

    return { rows, total: totals?.total ?? 0 };
  }

  async findStaffById(tenantId: string, id: string, reach: SQL[] = []): Promise<StaffRow | null> {
    const [row] = await this.selectStaff()
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, id),
        isNull(tenantMemberships.deletedAt),
        ...reach,
      ))
      .limit(1);

    return row ?? null;
  }

  async membershipExists(tenantId: string, id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, id),
        isNull(tenantMemberships.deletedAt),
      ))
      .limit(1);

    return row !== undefined;
  }

  async teamExists(tenantId: string, teamId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId), isNull(teams.deletedAt)))
      .limit(1);

    return row !== undefined;
  }

  /**
   * An unfiltered `or()` collapses to no WHERE clause, which would hand back an
   * arbitrary account and attach the new membership to a stranger. No identifier
   * means no match, full stop.
   */
  async findUserByIdentity(tx: Transaction, identity: { email: string | null; phone?: string | undefined }): Promise<ExistingUser | null> {
    const matches = [
      identity.email === null ? undefined : eq(users.email, identity.email),
      identity.phone === undefined ? undefined : eq(users.phone, identity.phone),
    ].filter(clause => clause !== undefined);

    if (matches.length === 0)
      return null;

    const [existing] = await tx
      .select({ id: users.id, name: users.name, deletedAt: users.deletedAt })
      .from(users)
      .where(or(...matches))
      .limit(1);

    return existing ?? null;
  }

  async insertUser(tx: Transaction, values: typeof users.$inferInsert): Promise<string> {
    const [created] = await tx.insert(users).values(values).returning({ id: users.id });
    return created!.id;
  }

  async findMembershipOfUser(tx: Transaction, tenantId: string, userId: string) {
    const [existing] = await tx
      .select({ id: tenantMemberships.id, deletedAt: tenantMemberships.deletedAt })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, tenantId)))
      .limit(1);

    return existing ?? null;
  }

  /**
   * Runs the caller's work inside one transaction so a half-created staff member
   * — user row without membership, membership without areas — cannot be left behind.
   */
  async inTransaction<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  async upsertMembership(tx: Transaction, values: StaffMembershipValues, existingId: string | null): Promise<string> {
    const [membership] = existingId === null
      ? await tx.insert(tenantMemberships).values(values).returning({ id: tenantMemberships.id })
      : await tx
          .update(tenantMemberships)
          .set({ ...values, deletedAt: null, updatedAt: new Date() })
          .where(eq(tenantMemberships.id, existingId))
          .returning({ id: tenantMemberships.id });

    return membership!.id;
  }

  async updateMembership(tx: Transaction, tenantId: string, id: string, patch: Partial<typeof tenantMemberships.$inferInsert>): Promise<void> {
    await tx
      .update(tenantMemberships)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, id),
        isNull(tenantMemberships.deletedAt),
      ));
  }

  async softDeleteMembership(tx: Transaction, tenantId: string, id: string, status: typeof tenantMemberships.$inferSelect['status']): Promise<void> {
    await tx
      .update(tenantMemberships)
      .set({ deletedAt: new Date(), status, teamId: null, updatedAt: new Date() })
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.id, id),
        isNull(tenantMemberships.deletedAt),
      ));
  }

  async renameUser(tx: Transaction, userId: string, name: string): Promise<void> {
    await tx
      .update(users)
      .set({ name, updatedAt: new Date() })
      .where(and(eq(users.id, userId), isNull(users.deletedAt)));
  }

  async standDownAsLeader(tx: Transaction, tenantId: string, membershipId: string): Promise<void> {
    await tx
      .update(teams)
      .set({ leaderMembershipId: null, updatedAt: new Date() })
      .where(and(eq(teams.tenantId, tenantId), eq(teams.leaderMembershipId, membershipId)));
  }

  // Area grants are a set with no identity of their own and no deleted_at
  // column: replacing them is delete-then-insert. Dropping them on removal is
  // deliberate — taking someone back on must not silently restore last year's
  // areas.
  async replaceOwnLocations(membershipId: string, locationIds: readonly string[], tx?: Transaction): Promise<void> {
    const client = tx ?? this.db;
    await client.delete(membershipLocations).where(eq(membershipLocations.membershipId, membershipId));

    if (locationIds.length > 0)
      await client.insert(membershipLocations).values(locationIds.map(locationId => ({ membershipId, locationId })));
  }

  async replaceTeamAreas(membershipId: string, locationIds: readonly string[], tx?: Transaction): Promise<void> {
    const client = tx ?? this.db;
    await client.delete(teamMemberLocations).where(eq(teamMemberLocations.membershipId, membershipId));

    if (locationIds.length > 0)
      await client.insert(teamMemberLocations).values(locationIds.map(locationId => ({ membershipId, locationId })));
  }

  async clearTeamAreas(tx: Transaction, membershipId: string): Promise<void> {
    await tx.delete(teamMemberLocations).where(eq(teamMemberLocations.membershipId, membershipId));
  }

  async teamLocationIds(teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: teamLocations.locationId })
      .from(teamLocations)
      .where(eq(teamLocations.teamId, teamId));

    return rows.map(row => row.id);
  }

  async memberUserIds(tenantId: string, teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(
        eq(tenantMemberships.tenantId, tenantId),
        eq(tenantMemberships.teamId, teamId),
        isNull(tenantMemberships.deletedAt),
      ));

    return rows.map(row => row.userId);
  }

  async areaGrants(owners: { membershipIds?: readonly string[]; teamIds?: readonly string[] }): Promise<AreaGrants> {
    return areaGrantsFor(this.db, owners);
  }

  async firstNodeOutside(ids: readonly string[], granted: readonly string[]): Promise<boolean> {
    return firstNodeOutside(this.db, ids, granted);
  }
}
