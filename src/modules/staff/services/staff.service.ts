import type { StaffRow } from '../repositories/staff.repository';
import type { AreaGrants } from '../staff.grants';
import type {
  CreateStaffBody,
  ListStaffQuery,
  LocationRef,
  SetLocationsBody,
  SetTeamAreasBody,
  StaffResponse,
  UpdateStaffBody,
} from '../staff.schema';
import type { Database, Transaction } from '@/db/client';
import type { AccessService, RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page } from '@/utils/pagination';
import { SYSTEM_ROLES } from '@/config/constants';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { MEMBERSHIP_STATUS } from '@/constants/tenancy';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, forbidden, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { scopeFor } from '@/modules/iam/access.service';
import { hashPassword } from '@/security/password';
import { PERMISSIONS } from '@/security/permissions';
import { normaliseEmail } from '@/utils/email';
import { offsetOf } from '@/utils/pagination';
import { StaffRepository } from '../repositories/staff.repository';
import { assertWithinGrant, servesNode, staffReach } from '../staff.grants';

type Grants = AreaGrants;

const EMPTY: LocationRef[] = [];
const STAFF_ROLES = [SYSTEM_ROLES.ADMIN, SYSTEM_ROLES.STAFF] as const;

export class StaffService {
  private readonly repo: StaffRepository;

  constructor(
    repoOrDb: StaffRepository | Database,
    private readonly locations: LocationsService,
    private readonly access: AccessService,
  ) {
    this.repo = repoOrDb instanceof StaffRepository ? repoOrDb : new StaffRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListStaffQuery): Promise<Page<StaffResponse>> {
    const reach = staffReach(access, PERMISSIONS.STAFF_VIEW);
    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters = this.repo.buildFilters(access.tenantId, STAFF_ROLES, reach, {
      ...query,
      ...(query.locationId === undefined ? {} : { nodeCondition: servesNode(query.locationId) }),
    });

    const { rows, total } = await this.repo.listStaff(filters, {
      limit: query.limit,
      offset: offsetOf(query),
    });

    const grants = await this.grantsFor(rows);

    return {
      items: rows.map(row => this.present(row, grants)),
      total,
      page: query.page,
      limit: query.limit,
    };
  }

  async get(access: RequestAccess, id: string): Promise<StaffResponse> {
    const row = await this.findReachable(access, id, PERMISSIONS.STAFF_VIEW);

    return this.present(row, await this.grantsFor([row]));
  }

  async create(access: RequestAccess, input: CreateStaffBody): Promise<StaffResponse> {
    const email = normaliseEmail(input.email);

    if (email === null && input.phone === undefined)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'An email or a phone number is required', [{ field: 'email', issue: 'One of email or phone must be present' }]);

    const roleId = input.roleId ?? SYSTEM_ROLES.STAFF;
    this.assertMayGrantRole(access, roleId, PERMISSIONS.STAFF_CREATE);
    await this.assertGrantable(access, input.locationIds ?? [], PERMISSIONS.STAFF_CREATE);
    await this.assertTeamOfTenant(access.tenantId, input.teamId ?? null);

    const id = await this.repo.inTransaction(async (tx) => {
      const userId = await this.resolveUser(tx, { ...input, email });
      const existing = await this.repo.findMembershipOfUser(tx, access.tenantId, userId);

      if (existing !== null && existing.deletedAt === null)
        throw conflict('This person is already a member of this tenant');

      const membershipId = await this.repo.upsertMembership(tx, {
        userId,
        tenantId: access.tenantId,
        roleId,
        status: input.status ?? 'active' as const,
        teamId: input.teamId ?? null,
      }, existing?.id ?? null);

      // A restored membership must not inherit the areas it carried before.
      await this.repo.replaceOwnLocations(membershipId, [...new Set(input.locationIds ?? [])], tx);

      return membershipId;
    });

    const created = await this.byId(access.tenantId, id);
    await audit.created(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, after: created });

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

    await this.repo.inTransaction(async (tx) => {
      if (Object.keys(membership).length > 0)
        await this.repo.updateMembership(tx, access.tenantId, id, membership);

      if (leavesTeam) {
        await this.repo.clearTeamAreas(tx, id);
        await this.repo.standDownAsLeader(tx, access.tenantId, id);
      }

      if (name !== undefined)
        await this.repo.renameUser(tx, before.userId, name);
    });

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    if (!await this.repo.membershipExists(access.tenantId, id))
      return;

    const before = await this.readFor(access, id, PERMISSIONS.STAFF_DELETE);

    if (before.userId === access.userId)
      throw conflict('You cannot remove your own membership');

    await this.repo.inTransaction(async (tx) => {
      await this.repo.softDeleteMembership(tx, access.tenantId, id, MEMBERSHIP_STATUS.SUSPENDED);

      // The grants went with the membership when this was a hard delete; they still do,
      // so taking the person back on does not silently restore last year's areas.
      await this.repo.replaceOwnLocations(id, [], tx);
      await this.repo.replaceTeamAreas(id, [], tx);
      await this.repo.standDownAsLeader(tx, access.tenantId, id);
    });

    this.access.invalidate(before.userId, access.tenantId);
    await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.STAFF, entityId: id, before });
  }

  async setLocations(access: RequestAccess, id: string, input: SetLocationsBody): Promise<StaffResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);
    const wanted = [...new Set(input.locationIds)];
    await this.assertGrantable(access, wanted, PERMISSIONS.STAFF_UPDATE);

    await this.repo.replaceOwnLocations(id, wanted);

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.repo.database, access.audit, {
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

    await this.repo.replaceTeamAreas(id, wanted);

    this.access.invalidate(before.userId, access.tenantId);
    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.STAFF_TEAM_AREAS,
      entityId: id,
      before: { teamAreas: before.teamAreas },
      after: { teamAreas: after.teamAreas },
      metadata: { teamId: before.team.id },
    });

    return after;
  }

  async memberUserIds(tenantId: string, teamId: string): Promise<string[]> {
    return this.repo.memberUserIds(tenantId, teamId);
  }

  private async assertWithinTeamPatch(teamId: string, ids: readonly string[]): Promise<void> {
    if (ids.length === 0)
      return;

    const patch = await this.repo.teamLocationIds(teamId);

    if (patch.length === 0)
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'This team has no areas yet — grant the team some first');

    if (await this.repo.firstNodeOutside(ids, patch))
      throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'That area is outside this team\'s own areas');
  }

  private async byId(tenantId: string, id: string): Promise<StaffResponse> {
    const row = await this.repo.findStaffById(tenantId, id);

    if (row === null)
      throw notFound('Staff member');

    return this.present(row, await this.grantsFor([row]));
  }

  private async findReachable(access: RequestAccess, id: string, key: PermissionKey): Promise<StaffRow> {
    const reach = staffReach(access, key);
    if (reach === null)
      throw notFound('Staff member');

    const row = await this.repo.findStaffById(access.tenantId, id, reach);

    if (row === null)
      throw notFound('Staff member');

    return row;
  }

  private async readFor(access: RequestAccess, id: string, key: PermissionKey): Promise<StaffResponse> {
    const row = await this.findReachable(access, id, key);

    return this.present(row, await this.grantsFor([row]));
  }

  private async grantsFor(rows: readonly StaffRow[]): Promise<Grants> {
    return this.repo.areaGrants({
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

  private async resolveUser(tx: Transaction, input: Omit<CreateStaffBody, 'email'> & { email: string | null }): Promise<string> {
    const existing = await this.repo.findUserByIdentity(tx, { email: input.email, phone: input.phone });

    if (existing !== null) {
      // The row still holds the email/phone, so it must be restored rather than re-created.
      if (existing.deletedAt !== null)
        throw conflict('This email or phone belongs to a removed account; restore it first');

      if (input.password !== undefined)
        throw conflict('This person already has an account; they set their own password');

      return existing.id;
    }

    try {
      return await this.repo.insertUser(tx, {
        name: input.name,
        email: input.email,
        phone: input.phone ?? null,
        passwordHash: input.password === undefined ? null : await hashPassword(input.password),
      });
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

    if (!await this.repo.teamExists(tenantId, teamId))
      throw notFound('Team');
  }

  private async assertGrantable(access: RequestAccess, ids: readonly string[], key: PermissionKey): Promise<void> {
    await this.locations.assertOwned(access, ids);
    await assertWithinGrant(this.repo, access, { ids, key });
  }
}
