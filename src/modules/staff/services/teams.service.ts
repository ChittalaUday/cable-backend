import type { SQL } from 'drizzle-orm';
import type { TeamRecord } from '../repositories/teams.repository';
import type {
  CreateTeamBody,
  ListTeamsQuery,
  LocationRef,
  SetLocationsBody,
  TeamMemberResponse,
  TeamResponse,
  UpdateTeamBody,
} from '../staff.schema';
import type { Database } from '@/db/client';
import type { AccessService, RequestAccess } from '@/modules/iam/access.service';
import type { LocationsService } from '@/modules/locations/location.service';
import type { PermissionKey } from '@/security/permissions';
import type { Page, PaginationQuery } from '@/utils/pagination';
import { eq, ilike } from 'drizzle-orm';
import { AUDIT_ENTITIES } from '@/constants/audit';
import { teams } from '@/db/schema';
import { ERROR_CODES, isUniqueViolation } from '@/errors';
import { badRequest, conflict, inUse, notFound } from '@/errors/domain-error';
import { audit } from '@/modules/audit/audit.service';
import { PERMISSIONS } from '@/security/permissions';
import { offsetOf } from '@/utils/pagination';
import { uniqueSlug } from '@/utils/slug';
import { TeamsRepository } from '../repositories/teams.repository';
import { areaGrantsFor, assertWithinGrant, teamReach } from '../staff.grants';

export class TeamsService {
  private readonly repo: TeamsRepository;

  constructor(
    repoOrDb: TeamsRepository | Database,
    private readonly locations: LocationsService,
    private readonly access: AccessService,
  ) {
    this.repo = repoOrDb instanceof TeamsRepository ? repoOrDb : new TeamsRepository(repoOrDb);
  }

  async list(access: RequestAccess, query: ListTeamsQuery): Promise<Page<TeamResponse>> {
    const reach = teamReach(access, PERMISSIONS.STAFF_VIEW);
    if (reach === null)
      return { items: [], total: 0, page: query.page, limit: query.limit };

    const filters: SQL[] = [...reach];

    if (query.status !== undefined)
      filters.push(eq(teams.status, query.status));
    if (query.q !== undefined)
      filters.push(ilike(teams.name, `%${query.q}%`));

    const [rows, total] = await Promise.all([
      this.repo.list(access.tenantId, filters, { limit: query.limit, offset: offsetOf(query as PaginationQuery) }),
      this.repo.count(access.tenantId, filters),
    ]);

    const grants = await this.grantsFor(rows.map(row => row.id));

    return {
      items: rows.map(row => present(row, grants.get(row.id) ?? [])),
      total,
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

    const slug = input.slug ?? uniqueSlug(input.name, await this.repo.takenSlugs(access.tenantId));

    const id = await this.repo.create({
      tenantId: access.tenantId,
      name: input.name,
      slug,
      description: input.description ?? null,
      status: input.status ?? 'active',
    }, nodes).catch((error: unknown) => {
      if (isUniqueViolation(error))
        throw conflict(`A team with slug "${slug}" already exists`);
      throw error;
    });

    const created = await this.byId(access.tenantId, id);
    await audit.created(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, after: created });

    return created;
  }

  async update(access: RequestAccess, id: string, patch: UpdateTeamBody): Promise<TeamResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);

    if (patch.leaderMembershipId !== undefined && patch.leaderMembershipId !== null) {
      if (!await this.repo.isMemberOf(access.tenantId, id, patch.leaderMembershipId))
        throw badRequest(ERROR_CODES.VALIDATION_FAILED, 'A crew may only be led by one of its own members');
    }

    await this.repo.update(access.tenantId, id, patch);

    if (patch.leaderMembershipId !== undefined)
      await this.invalidateLeaders(access.tenantId, [before.leaderMembershipId, patch.leaderMembershipId]);

    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, before, after });

    return after;
  }

  async remove(access: RequestAccess, id: string): Promise<void> {
    if (await this.repo.findById(access.tenantId, id) === null)
      return;

    const before = await this.readFor(access, id, PERMISSIONS.STAFF_DELETE);

    if (before.memberCount > 0)
      throw inUse('This team still has members; move them off it first');

    await this.repo.softDelete(access.tenantId, id);
    await audit.deleted(this.repo.database, access.audit, { entityType: AUDIT_ENTITIES.TEAM, entityId: id, before });
  }

  async setLocations(access: RequestAccess, id: string, input: SetLocationsBody): Promise<TeamResponse> {
    const before = await this.readFor(access, id, PERMISSIONS.STAFF_UPDATE);
    const wanted = [...new Set(input.locationIds)];
    await this.assertGrantable(access, wanted, PERMISSIONS.STAFF_UPDATE);

    const affected = await this.repo.findMemberUserIds(access.tenantId, id);

    await this.repo.replaceLocations(id, wanted);

    for (const userId of affected)
      this.access.invalidate(userId, access.tenantId);

    const after = await this.byId(access.tenantId, id);
    await audit.updated(this.repo.database, access.audit, {
      entityType: AUDIT_ENTITIES.TEAM_LOCATIONS,
      entityId: id,
      before: { locations: before.locations },
      after: { locations: after.locations },
      metadata: { membersAffected: affected.length },
    });

    return after;
  }

  async members(access: RequestAccess, id: string): Promise<TeamMemberResponse[]> {
    const { leaderMembershipId } = await this.readFor(access, id, PERMISSIONS.STAFF_VIEW);

    const rows = await this.repo.findMembers(access.tenantId, id);

    if (rows.length === 0)
      return [];

    const { own: ownBy, narrowed: narrowedBy } = await areaGrantsFor(this.repo.database, {
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
      isTeamLeader: row.id === leaderMembershipId,
      locations: ownBy.get(row.id) ?? [],
      teamAreas: narrowedBy.get(row.id) ?? [],
    })).sort((a, b) => Number(b.isTeamLeader) - Number(a.isTeamLeader));
  }

  private async invalidateLeaders(tenantId: string, ids: readonly (string | null)[]): Promise<void> {
    const wanted = ids.filter((value): value is string => value !== null);

    for (const userId of await this.repo.findUserIdsOf(tenantId, wanted))
      this.access.invalidate(userId, tenantId);
  }

  private async byId(tenantId: string, id: string): Promise<TeamResponse> {
    const row = await this.repo.findById(tenantId, id);

    if (row === null)
      throw notFound('Team');

    const grants = await this.grantsFor([id]);

    return present(row, grants.get(id) ?? []);
  }

  private async readFor(access: RequestAccess, id: string, key: PermissionKey): Promise<TeamResponse> {
    const reach = teamReach(access, key);
    if (reach === null)
      throw notFound('Team');

    if (await this.repo.findIdWithin(access.tenantId, id, reach) === null)
      throw notFound('Team');

    return this.byId(access.tenantId, id);
  }

  private async grantsFor(ids: readonly string[]): Promise<Map<string, LocationRef[]>> {
    const { team } = await areaGrantsFor(this.repo.database, { teamIds: ids });

    return team;
  }

  private async assertGrantable(access: RequestAccess, ids: readonly string[], key: PermissionKey): Promise<void> {
    await this.locations.assertOwned(access, ids);
    await assertWithinGrant(this.repo.database, access, { ids, key });
  }
}

function present(row: TeamRecord, locationRefs: LocationRef[]): TeamResponse {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    leaderMembershipId: row.leaderMembershipId,
    memberCount: row.memberCount,
    locations: locationRefs,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
