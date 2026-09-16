import type { Database } from '@/db/client';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { LocationScope } from '@/security/location-scope';
import type { PermissionKey, PermissionScope } from '@/security/permissions';
import { MEMBERSHIP_STATUS } from '@/constants/tenancy';
import { ERROR_CODES } from '@/errors';
import { forbidden } from '@/errors/domain-error';
import { PERMISSIONS } from '@/security/permissions';
import { widerScope } from '@/security/scope';
import { IamRepository } from './iam.repository';

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

const LEADER_KEYS = [PERMISSIONS.STAFF_VIEW, PERMISSIONS.STAFF_UPDATE] as const;

interface CacheEntry { expiresAt: number; context: AccessContext }

export class AccessService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly repo: IamRepository;

  constructor(repoOrDb: IamRepository | Database, private readonly ttlMs: number = 60_000) {
    this.repo = repoOrDb instanceof IamRepository ? repoOrDb : new IamRepository(repoOrDb);
  }

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
    const membership = await this.repo.findMembership(userId, tenantId);

    if (membership === null || membership.status !== MEMBERSHIP_STATUS.ACTIVE)
      return null;

    const teamId = membership.teamId;

    const [grants, ownNodes, teamNodes, narrowedNodes] = await Promise.all([
      this.repo.findRoleGrants(membership.roleId),
      this.repo.findMembershipNodes(membership.id),
      teamId === null ? [] : this.repo.findTeamNodes(teamId),
      teamId === null ? [] : this.repo.findNarrowedNodes(membership.id),
    ]);

    const permissions = new Map<PermissionKey, PermissionScope>();
    for (const grant of grants) {
      const existing = permissions.get(grant.key);
      permissions.set(grant.key, existing === undefined ? grant.scope : widerScope(existing, grant.scope));
    }

    const isTeamLeader = membership.ledTeamId !== null && membership.ledTeamId === teamId;

    if (isTeamLeader) {
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
      teamId,
      isTeamLeader,
      permissions,
      locationIds: [...new Set([...ownNodes, ...(narrowedNodes.length > 0 ? narrowedNodes : teamNodes)])],
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
