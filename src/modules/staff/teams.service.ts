import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type {
  CreateTeamBody,
  ListTeamsQuery,
  LocationRef,
  SetLocationsBody,
  TeamMemberResponse,
  TeamResponse,
  UpdateTeamBody,
} from './staff.schema';
import type * as schema from '@/db/schema';
import type { AccessService, RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/locations.service';
import type { Page, PaginationQuery } from '@/shared/pagination';
import type { PermissionKey } from '@/shared/security/permissions';
import { and, asc, count, desc, eq, ilike, isNull, sql } from 'drizzle-orm';
import {
  teamLocations,
  teams,
  tenantMemberships,
  users,
} from '@/db/schema';
import { audit } from '@/modules/audit/audit.service';
import { AUDIT_ENTITIES } from '@/shared/constants/audit';
import { isUniqueViolation } from '@/shared/errors';
import { conflict, inUse, notFound } from '@/shared/errors/domain-error';
import { offsetOf } from '@/shared/pagination';
import { PERMISSIONS } from '@/shared/security/permissions';
import { uniqueSlug } from '@/shared/utils/slug';
import { areaGrantsFor, assertWithinGrant, teamReach } from './staff.grants';

type Db = NodePgDatabase<typeof schema>;
type TeamRow = typeof teams.$inferSelect & { memberCount: number };

const MEMBER_COUNT = sql<number>`(
  SELECT count(*)::int FROM tenancy.tenant_memberships m WHERE m.team_id = tenancy.teams.id
)`;

export class TeamsService {
  constructor(
    private readonly db: Db,
    private readonly locations: LocationsService,
    private readonly access: AccessService,
  ) {}

  async list(access: RequestAccess, query: ListTeamsQuery): Promise<Page<TeamResponse>> {
    const reach = teamReach(access, PERMISSIONS.STAFF_VIEW);
    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters: (SQL | undefined)[] = [
      eq(teams.tenantId, access.tenantId),
      isNull(teams.deletedAt),
      ...reach,
    ];

    if (query.status !== undefined)
      filters.push(eq(teams.status, query.status));
    if (query.q !== undefined)
      filters.push(ilike(teams.name, `%${query.q}%`));

    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.db
        .select({ team: teams, memberCount: MEMBER_COUNT })
        .from(teams)
        .where(where)
        .orderBy(asc(teams.name), asc(teams.id))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      this.db.select({ total: count() }).from(teams).where(where),
    ]);

    const flat = rows.map(row => ({ ...row.team, memberCount: row.memberCount }));
    const grants = await this.grantsFor(flat.map(row => row.id));

    return {
      items: flat.map(row => present(row, grants.get(row.id) ?? [])),
      total: totals?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(access: RequestAccess, id: string): Promise<TeamResponse> {
    return this.readFor(access, id, PERMISSIONS.STAFF_VIEW);
  }

  async create(access: RequestAccess, input: CreateTeamBody): Promise<TeamResponse> {
    const nodes = [...new Set(input.locationIds ?? [])];
    await this.assertGrantable(access, nodes, PERMISSIONS.STAFF_CREATE);

    const slug = input.slug ?? uniqueSlug(input.name, await this.takenSlugs(access.tenantId));

    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(teams)
        .values({
          tenantId: access.tenantId,
          name: input.name,
          slug,
          description: input.description ?? null,
          status: input.status ?? 'active',
        })
        .returning({ id: teams.id });

      if (nodes.length > 0)
        await tx.insert(teamLocations).values(nodes.map(locationId => ({ teamId: row!.id, locationId })));

      return row!.id;
    }).catch((error: unknown) => {
      if (isUniqueViolation(error))
        throw conflict(`A team with slug "${slug}" already exists`);
      throw error;
    });

    const created = await this.byId(access.tenantId, id);
    await audit.created(this.db, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, after: created });

    return created;
  }

  async update(access: RequestAccess, id: string, patch: UpdateTeamBody): Promise<TeamResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);

    await this.db
      .update(teams)
      .set({ ...patch, updatedAt: new Date() })
      .where(and(eq(teams.tenantId, access.tenantId), eq(teams.id, id)));

    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, access.tenantId), eq(teams.id, id), isNull(teams.deletedAt)))
      .limit(1);

    if (existing === undefined)
      return;

    const before = await this.readFor(access, id, PERMISSIONS.STAFF_DELETE);

    if (before.memberCount > 0)
      throw inUse('This team still has members; move them off it first');

    await this.db
      .update(teams)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(teams.tenantId, access.tenantId), eq(teams.id, id)));

    await audit.deleted(this.db, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, before });
  }

  async setLocations(access: RequestAccess, id: string, input: SetLocationsBody): Promise<TeamResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);
    const wanted = [...new Set(input.locationIds)];
    await this.assertGrantable(access, wanted, PERMISSIONS.STAFF_UPDATE);

    const members = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.teamId, id)));

    await this.db.transaction(async (tx) => {
      await tx.delete(teamLocations).where(eq(teamLocations.teamId, id));
      if (wanted.length > 0)
        await tx.insert(teamLocations).values(wanted.map(locationId => ({ teamId: id, locationId })));
    });

    for (const member of members)
      this.access.invalidate(member.userId, access.tenantId);

    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.TEAM_LOCATIONS,
      entityId: id,
      before: { locations: before.locations },
      after: { locations: after.locations },
      metadata: { membersAffected: members.length },
    });

    return after;
  }

  async members(access: RequestAccess, id: string): Promise<TeamMemberResponse[]> {
    await this.readFor(access, id, PERMISSIONS.STAFF_VIEW);

    const rows = await this.db
      .select({
        id: tenantMemberships.id,
        userId: tenantMemberships.userId,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        isTeamLeader: tenantMemberships.isTeamLeader,
        name: users.name,
        phone: users.phone,
        email: users.email,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.teamId, id)))
      .orderBy(desc(tenantMemberships.isTeamLeader), asc(users.name), asc(tenantMemberships.id));

    if (rows.length === 0)
      return [];

    const { own: ownBy, narrowed: narrowedBy } = await areaGrantsFor(this.db, {
      membershipIds: rows.map(row => row.id),
    });

    return rows.map(row => ({
      id: row.id,
      userId: row.userId,
      name: row.name,
      phone: row.phone,
      email: row.email,
      roleId: row.roleId as TeamMemberResponse['roleId'],
      status: row.status,
      isTeamLeader: row.isTeamLeader,
      locations: ownBy.get(row.id) ?? [],
      teamAreas: narrowedBy.get(row.id) ?? [],
    }));
  }

  private async byId(tenantId: string, id: string): Promise<TeamResponse> {
    const [row] = await this.db
      .select({ team: teams, memberCount: MEMBER_COUNT })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, id), isNull(teams.deletedAt)))
      .limit(1);

    if (row === undefined)
      throw notFound('Team');

    const grants = await this.grantsFor([id]);

    return present({ ...row.team, memberCount: row.memberCount }, grants.get(id) ?? []);
  }

  private async readFor(access: RequestAccess, id: string, key: PermissionKey): Promise<TeamResponse> {
    const reach = teamReach(access, key);
    if (reach === null)
      throw notFound('Team');

    const [row] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, access.tenantId), eq(teams.id, id), isNull(teams.deletedAt), ...reach))
      .limit(1);

    if (row === undefined)
      throw notFound('Team');

    return this.byId(access.tenantId, id);
  }

  private async grantsFor(ids: readonly string[]): Promise<Map<string, LocationRef[]>> {
    const { team } = await areaGrantsFor(this.db, { teamIds: ids });

    return team;
  }

  private async takenSlugs(tenantId: string): Promise<string[]> {
    const rows = await this.db.select({ slug: teams.slug }).from(teams).where(eq(teams.tenantId, tenantId));

    return rows.map(row => row.slug);
  }

  private async assertGrantable(access: RequestAccess, ids: readonly string[], key: PermissionKey): Promise<void> {
    await this.locations.assertOwned(access, ids);
    await assertWithinGrant(this.db, access, { ids, key });
  }
}

function present(row: TeamRow, locationRefs: LocationRef[]): TeamResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    memberCount: row.memberCount,
    locations: locationRefs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
