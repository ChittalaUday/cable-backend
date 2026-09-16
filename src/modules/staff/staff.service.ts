import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { AreaGrants } from './staff.grants';
import type {
  CreateStaffBody,
  ListStaffQuery,
  LocationRef,
  SetLocationsBody,
  SetTeamAreasBody,
  StaffResponse,
  UpdateStaffBody,
} from './staff.schema';
import type * as schema from '@/db/schema';
import type { AccessService, RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page, PaginationQuery } from '@/utils/pagination';
import { and, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import { SYSTEM_ROLES } from '@/config/constants';
import { AUDIT_ENTITIES } from '@/constants/audit';
import {
  membershipLocations,
  teamLocations,
  teamMemberLocations,
  teams,
  tenantMemberships,
  users,
} from '@/db/schema';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, forbidden, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { scopeFor } from '@/modules/iam/access.service';
import { underAnyGrant } from '@/security/location-scope';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { normaliseEmail } from '@/utils/email';
import { offsetOf } from '@/utils/pagination';
import { areaGrantsFor, assertWithinGrant, servesNode, staffReach } from './staff.grants';

type Db = NodePgDatabase<typeof schema>;

interface StaffRow {
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

type Grants = AreaGrants;

const EMPTY: LocationRef[] = [];

export class StaffService {
  constructor(
    private readonly db: Db,
    private readonly locations: LocationsService,
    private readonly access: AccessService,
  ) {}

  async list(access: RequestAccess, query: ListStaffQuery): Promise<Page<StaffResponse>> {
    const reach = staffReach(access, PERMISSIONS.STAFF_VIEW);
    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters: (SQL | undefined)[] = [
      eq(tenantMemberships.tenantId, access.tenantId),
      inArray(tenantMemberships.roleId, [SYSTEM_ROLES.ADMIN, SYSTEM_ROLES.STAFF]),
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
    if (query.locationId !== undefined)
      filters.push(servesNode(query.locationId));
    if (query.q !== undefined) {
      const term = `%${query.q}%`;
      filters.push(or(ilike(users.name, term), ilike(users.email, term), ilike(users.phone, term)));
    }

    const where = and(...filters);

    const [rows, [totals]] = await Promise.all([
      this.selectStaff()
        .where(where)
        .orderBy(desc(tenantMemberships.createdAt), desc(tenantMemberships.id))
        .limit(query.limit)
        .offset(offsetOf(query as PaginationQuery)),
      this.db
        .select({ total: count() })
        .from(tenantMemberships)
        .innerJoin(users, eq(users.id, tenantMemberships.userId))
        .leftJoin(teams, eq(teams.id, tenantMemberships.teamId))
        .where(where),
    ]);

    const grants = await this.grantsFor(rows);

    return {
      items: rows.map(row => this.present(row, grants)),
      total: totals?.total ?? 0,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(access: RequestAccess, id: string): Promise<StaffResponse> {
    const row = await this.findReachable(access, id, PERMISSIONS.STAFF_VIEW);

    return this.present(row, await this.grantsFor([row]));
  }

  async create(access: RequestAccess, input: CreateStaffBody): Promise<StaffResponse> {
    if (input.email === undefined && input.phone === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'An email or a phone number is required', [{ field: 'email', issue: 'One of email or phone must be present' }]);

    const roleId = input.roleId ?? SYSTEM_ROLES.STAFF;
    this.assertMayGrantRole(access, roleId, PERMISSIONS.STAFF_CREATE);
    await this.assertGrantable(access, input.locationIds ?? [], PERMISSIONS.STAFF_CREATE);
    await this.assertTeamOfTenant(access.tenantId, input.teamId ?? null);

    const email = normaliseEmail(input.email);

    const id = await this.db.transaction(async (tx) => {
      const userId = await this.resolveUser(tx, { ...input, email });

      const [duplicate] = await tx
        .select({ id: tenantMemberships.id })
        .from(tenantMemberships)
        .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, access.tenantId)))
        .limit(1);

      if (duplicate !== undefined)
        throw conflict('This person is already a member of this tenant');

      const [membership] = await tx
        .insert(tenantMemberships)
        .values({
          userId,
          tenantId: access.tenantId,
          roleId,
          status: input.status ?? 'active',
          teamId: input.teamId ?? null,
        })
        .returning({ id: tenantMemberships.id });

      if (input.locationIds !== undefined && input.locationIds.length > 0) {
        await tx.insert(membershipLocations).values(
          [...new Set(input.locationIds)].map(locationId => ({ membershipId: membership!.id, locationId })),
        );
      }

      return membership!.id;
    });

    const created = await this.byId(access.tenantId, id);
    await audit.created(this.db, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, after: created });

    return created;
  }

  async update(access: RequestAccess, id: string, patch: UpdateStaffBody): Promise<StaffResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);

    if (patch.roleId !== undefined)
      this.assertMayGrantRole(access, patch.roleId, PERMISSIONS.STAFF_UPDATE);
    if (patch.teamId !== undefined)
      await this.assertTeamOfTenant(access.tenantId, patch.teamId);

    const { name, ...membership } = patch;

    const leavesTeam = patch.teamId !== undefined && patch.teamId !== before.team?.id;

    await this.db.transaction(async (tx) => {
      if (Object.keys(membership).length > 0) {
        await tx
          .update(tenantMemberships)
          .set({ ...membership, updatedAt: new Date() })
          .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.id, id)));
      }

      if (leavesTeam) {
        await tx.delete(teamMemberLocations).where(eq(teamMemberLocations.membershipId, id));
        await tx
          .update(teams)
          .set({ leaderMembershipId: null, updatedAt: new Date() })
          .where(and(eq(teams.tenantId, access.tenantId), eq(teams.leaderMembershipId, id)));
      }

      if (name !== undefined)
        await tx.update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, before.userId));
    });

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.db, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    const [existing] = await this.db
      .select({ id: tenantMemberships.id })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.id, id)))
      .limit(1);

    if (existing === undefined)
      return;

    const before = await this.readFor(access, id, PERMISSIONS.STAFF_DELETE);

    if (before.userId === access.userId)
      throw conflict('You cannot remove your own membership');

    await this.db
      .delete(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.id, id)));

    this.access.invalidate(before.userId, access.tenantId);
    await audit.deleted(this.db, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, before });
  }

  async setLocations(access: RequestAccess, id: string, input: SetLocationsBody): Promise<StaffResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);
    const wanted = [...new Set(input.locationIds)];
    await this.assertGrantable(access, wanted, PERMISSIONS.STAFF_UPDATE);

    await this.db.transaction(async (tx) => {
      await tx.delete(membershipLocations).where(eq(membershipLocations.membershipId, id));
      if (wanted.length > 0)
        await tx.insert(membershipLocations).values(wanted.map(locationId => ({ membershipId: id, locationId })));
    });

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.STAFF_LOCATIONS,
      entityId: id,
      before: { locations: before.locations },
      after: { locations: after.locations },
    });

    return after;
  }

  async setTeamAreas(access: RequestAccess, id: string, input: SetTeamAreasBody): Promise<StaffResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);

    if (before.team === null)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'This person is on no team, so there is nothing to narrow');

    const wanted = [...new Set(input.locationIds)];
    await this.locations.assertOwned(access, wanted);
    await this.assertWithinTeamPatch(before.team.id, wanted);

    await this.db.transaction(async (tx) => {
      await tx.delete(teamMemberLocations).where(eq(teamMemberLocations.membershipId, id));
      if (wanted.length > 0)
        await tx.insert(teamMemberLocations).values(wanted.map(locationId => ({ membershipId: id, locationId })));
    });

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.db, access.audit, {
      entityType: AUDIT_ENTITIES.STAFF_TEAM_AREAS,
      entityId: id,
      before: { teamAreas: before.teamAreas },
      after: { teamAreas: after.teamAreas },
      metadata: { teamId: before.team.id },
    });

    return after;
  }

  private async assertWithinTeamPatch(teamId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0)
      return;

    const patch = await this.db
      .select({ id: teamLocations.locationId })
      .from(teamLocations)
      .where(eq(teamLocations.teamId, teamId));

    if (patch.length === 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'This team has no areas yet — grant the team some first');

    const outside = await this.db.execute<{ id: string }>(sql`
      SELECT w.id
      FROM unnest(${sql.param([...ids])}::uuid[]) AS w(id)
      WHERE NOT ${underAnyGrant(sql`w.id`, patch.map(node => node.id))}
      LIMIT 1
    `);

    if (outside.rows.length > 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'That area is outside this team\'s own areas');
  }

  async memberUserIds(tenantId: string, teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: tenantMemberships.userId })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.teamId, teamId)));

    return rows.map(row => row.userId);
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
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .leftJoin(teams, eq(teams.id, tenantMemberships.teamId))
      .$dynamic();
  }

  private async byId(tenantId: string, id: string): Promise<StaffResponse> {
    const [row] = await this.selectStaff()
      .where(and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.id, id)))
      .limit(1);

    if (row === undefined)
      throw notFound('Staff member');

    return this.present(row, await this.grantsFor([row]));
  }

  private async findReachable(access: RequestAccess, id: string, key: PermissionKey): Promise<StaffRow> {
    const reach = staffReach(access, key);
    if (reach === null)
      throw notFound('Staff member');

    const [row] = await this.selectStaff()
      .where(and(eq(tenantMemberships.tenantId, access.tenantId), eq(tenantMemberships.id, id), ...reach))
      .limit(1);

    if (row === undefined)
      throw notFound('Staff member');

    return row;
  }

  private async readFor(access: RequestAccess, id: string, key: PermissionKey): Promise<StaffResponse> {
    const row = await this.findReachable(access, id, key);

    return this.present(row, await this.grantsFor([row]));
  }

  private async grantsFor(rows: readonly StaffRow[]): Promise<Grants> {
    return areaGrantsFor(this.db, {
      membershipIds: rows.map(row => row.id),
      teamIds: rows.map(row => row.teamId).filter((id): id is string => id !== null),
    });
  }

  private present(row: StaffRow, grants: Grants): StaffResponse {
    return {
      id: row.id,
      userId: row.userId,
      name: row.name,
      email: row.email,
      phone: row.phone,
      photoUrl: row.photoUrl,
      roleId: row.roleId as StaffResponse['roleId'],
      status: row.status as StaffResponse['status'],
      team: row.teamId === null
        ? null
        : { id: row.teamId, name: row.teamName ?? '', slug: row.teamSlug ?? '' },
      isTeamLeader: row.isTeamLeader,
      locations: grants.own.get(row.id) ?? EMPTY,
      inheritedLocations: row.teamId === null ? EMPTY : this.inherited(row, grants),
      teamAreas: row.teamId === null ? EMPTY : (grants.narrowed.get(row.id) ?? EMPTY),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private inherited(row: StaffRow, grants: Grants): LocationRef[] {
    const share = grants.narrowed.get(row.id);
    if (share !== undefined && share.length > 0)
      return share;

    return row.teamId === null ? EMPTY : (grants.team.get(row.teamId) ?? EMPTY);
  }

  private async resolveUser(tx: Parameters<Parameters<Db['transaction']>[0]>[0], input: Omit<CreateStaffBody, 'email'> & { email: string | null }): Promise<string> {
    const matches = [
      input.email === null ? undefined : eq(users.email, input.email),
      input.phone === undefined ? undefined : eq(users.phone, input.phone),
    ].filter(clause => clause !== undefined);

    const [existing] = await tx.select({ id: users.id, name: users.name }).from(users).where(or(...matches)).limit(1);

    if (existing !== undefined) {
      if (input.password !== undefined)
        throw conflict('This person already has an account; they set their own password');

      return existing.id;
    }

    try {
      const [created] = await tx
        .insert(users)
        .values({
          name: input.name,
          email: input.email,
          phone: input.phone ?? null,
          passwordHash: input.password === undefined ? null : await hashPassword(input.password),
        })
        .returning({ id: users.id });

      return created!.id;
    }
    catch (error) {
      if (isUniqueViolation(error))
        throw conflict('An account with this email or phone already exists', ERROR_CODES.RESOURCE_CONFLICT);
      throw error;
    }
  }

  private assertMayGrantRole(access: RequestAccess, roleId: string, key: PermissionKey): void {
    if (roleId === SYSTEM_ROLES.ADMIN && scopeFor(access, key) !== 'ALL')
      throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'Only a tenant-wide grant may appoint an admin');
  }

  private async assertTeamOfTenant(tenantId: string, teamId: string | null): Promise<void> {
    if (teamId === null)
      return;

    const [team] = await this.db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.tenantId, tenantId), eq(teams.id, teamId), isNull(teams.deletedAt)))
      .limit(1);

    if (team === undefined)
      throw notFound('Team');
  }

  private async assertGrantable(access: RequestAccess, ids: readonly string[], key: PermissionKey): Promise<void> {
    await this.locations.assertOwned(access, ids);
    await assertWithinGrant(this.db, access, { ids, key });
  }
}
