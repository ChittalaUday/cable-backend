import type { Database } from '@/db/client';
import type { PermissionKey, PermissionScope } from '@/security/permissions';
import { and, eq } from 'drizzle-orm';
import { membershipLocations, rolePermissions, teamLocations, teamMemberLocations, teams, tenantMemberships } from '@/db/schema';

export interface MembershipRecord {
  id: string;
  roleId: string;
  status: string;
  teamId: string | null;
  /** The crew this membership leads, if any — a membership leads at most one. */
  ledTeamId: string | null;
}

export interface PermissionGrant {
  key: PermissionKey;
  scope: PermissionScope;
}

export class IamRepository {
  constructor(private readonly db: Database) {}

  async findMembership(userId: string, tenantId: string): Promise<MembershipRecord | null> {
    const [row] = await this.db
      .select({
        id: tenantMemberships.id,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        teamId: tenantMemberships.teamId,
        ledTeamId: teams.id,
      })
      .from(tenantMemberships)
      .leftJoin(teams, eq(teams.leaderMembershipId, tenantMemberships.id))
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, tenantId)))
      .limit(1);

    return row ?? null;
  }

  async findRoleGrants(roleId: string): Promise<PermissionGrant[]> {
    const rows = await this.db
      .select({ key: rolePermissions.permissionKey, scope: rolePermissions.scope })
      .from(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));

    return rows.map(row => ({ key: row.key as PermissionKey, scope: row.scope }));
  }

  async findMembershipNodes(membershipId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: membershipLocations.locationId })
      .from(membershipLocations)
      .where(eq(membershipLocations.membershipId, membershipId));

    return rows.map(row => row.id);
  }

  async findTeamNodes(teamId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: teamLocations.locationId })
      .from(teamLocations)
      .where(eq(teamLocations.teamId, teamId));

    return rows.map(row => row.id);
  }

  async findNarrowedNodes(membershipId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: teamMemberLocations.locationId })
      .from(teamMemberLocations)
      .where(eq(teamMemberLocations.membershipId, membershipId));

    return rows.map(row => row.id);
  }
}
