import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { LocationScope } from '@/shared/security/location-scope';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
import { and, eq } from 'drizzle-orm';
import { membershipLocations, rolePermissions, teamLocations, teamMemberLocations, tenantMemberships } from '@/db/schema';
import { MEMBERSHIP_STATUS } from '@/shared/constants/tenancy';
import { ERROR_CODES } from '@/shared/errors';
import { forbidden } from '@/shared/errors/domain-error';
import { PERMISSIONS } from '@/shared/security/permissions';
import { widerScope } from '@/shared/security/scope';

export interface AccessContext {
  userId: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  teamId: string | null;
  isTeamLeader: boolean;
  permissions: ReadonlyMap<PermissionKey, PermissionScope>;
  locationIds: readonly string[];
}

export type RequestAccess = AccessContext & { audit: AuditContext };

type Db = NodePgDatabase<typeof schema>;

const LEADER_KEYS = [PERMISSIONS.STAFF_VIEW, PERMISSIONS.STAFF_UPDATE] as const;

interface CacheEntry { expiresAt: number; context: AccessContext }

export class AccessService {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly db: Db, private readonly ttlMs: number = 60_000) {}

  async resolve(userId: string, tenantId: string): Promise<AccessContext | null> {
    const key = `${userId}:${tenantId}`;
    const hit = this.cache.get(key);
    if (hit !== undefined && hit.expiresAt > Date.now())
      return hit.context;

    const context = await this.load(userId, tenantId);
    if (context !== null)
      this.cache.set(key, { expiresAt: Date.now() + this.ttlMs, context });

    return context;
  }

  invalidate(userId?: string, tenantId?: string): void {
    if (userId === undefined || tenantId === undefined)
      this.cache.clear();
    else
      this.cache.delete(`${userId}:${tenantId}`);
  }

  private async load(userId: string, tenantId: string): Promise<AccessContext | null> {
    const [membership] = await this.db
      .select({
        id: tenantMemberships.id,
        roleId: tenantMemberships.roleId,
        status: tenantMemberships.status,
        teamId: tenantMemberships.teamId,
        isTeamLeader: tenantMemberships.isTeamLeader,
      })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, tenantId)))
      .limit(1);

    if (membership === undefined || membership.status !== MEMBERSHIP_STATUS.ACTIVE)
      return null;

    const [grants, ownNodes, teamNodes, narrowedNodes] = await Promise.all([
      this.db
        .select({ key: rolePermissions.permissionKey, scope: rolePermissions.scope })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, membership.roleId)),
      this.db
        .select({ id: membershipLocations.locationId })
        .from(membershipLocations)
        .where(eq(membershipLocations.membershipId, membership.id)),
      membership.teamId === null
        ? []
        : this.db
            .select({ id: teamLocations.locationId })
            .from(teamLocations)
            .where(eq(teamLocations.teamId, membership.teamId)),
      membership.teamId === null
        ? []
        : this.db
            .select({ id: teamMemberLocations.locationId })
            .from(teamMemberLocations)
            .where(eq(teamMemberLocations.membershipId, membership.id)),
    ]);

    const permissions = new Map<PermissionKey, PermissionScope>();
    for (const grant of grants) {
      const key = grant.key as PermissionKey;
      const existing = permissions.get(key);
      permissions.set(key, existing === undefined ? grant.scope : widerScope(existing, grant.scope));
    }

    if (membership.isTeamLeader && membership.teamId !== null) {
      for (const key of LEADER_KEYS) {
        const existing = permissions.get(key);
        permissions.set(key, existing === undefined ? 'TEAM' : widerScope(existing, 'TEAM'));
      }
    }

    return {
      userId,
      tenantId,
      membershipId: membership.id,
      roleId: membership.roleId,
      teamId: membership.teamId,
      isTeamLeader: membership.isTeamLeader,
      permissions,
      locationIds: [...new Set([...ownNodes, ...(narrowedNodes.length > 0 ? narrowedNodes : teamNodes)].map(l => l.id))],
    };
  }
}

export function scopeFor(context: AccessContext, key: PermissionKey): PermissionScope | null {
  return context.permissions.get(key) ?? null;
}

export function requireScope(context: AccessContext, key: PermissionKey): PermissionScope {
  const scope = scopeFor(context, key);

  if (scope === null)
    throw forbidden(ERROR_CODES.PERM_DENIED, `Missing permission: ${key}`);

  return scope;
}

export function locationScopeFor(context: AccessContext, key: PermissionKey): LocationScope {
  const scope = requireScope(context, key);

  if (scope === 'ALL')
    return { kind: 'ALL_TENANT_LOCATIONS' };

  return { kind: 'NODES', nodeIds: scope === 'LOCATION' ? context.locationIds : [] };
}

export function grantedNodes(context: AccessContext, scope: PermissionScope): readonly string[] {
  return scope === 'LOCATION' ? context.locationIds : [];
}
