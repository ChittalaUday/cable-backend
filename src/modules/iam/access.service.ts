import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from '@/db/schema';
import type { AuditContext } from '@/modules/audit/audit.types';
import type { PermissionKey, PermissionScope } from '@/shared/security/permissions';
import { and, eq } from 'drizzle-orm';
import { membershipAreas, membershipLocations, rolePermissions, tenantMemberships } from '@/db/schema';
import { widerScope } from '@/shared/security/scope';

export interface AccessContext {
  userId: string;
  tenantId: string;
  membershipId: string;
  roleId: string;
  permissions: ReadonlyMap<PermissionKey, PermissionScope>;
  areaIds: readonly string[];
  locationIds: readonly string[];
}

/**
 * What a service method actually receives: the cached access context plus the
 * audit context of the one request that is calling it.
 *
 * `audit` is deliberately NOT part of `AccessContext` — that object is cached
 * per user+tenant for a minute, so a request id or IP stored on it would be
 * replayed onto everyone else's audit rows. `plugins/rbac.ts` spreads a fresh
 * copy per request instead.
 */
export type RequestAccess = AccessContext & { audit: AuditContext };

type Db = NodePgDatabase<typeof schema>;

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
      .select({ id: tenantMemberships.id, roleId: tenantMemberships.roleId, status: tenantMemberships.status })
      .from(tenantMemberships)
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.tenantId, tenantId)))
      .limit(1);

    if (membership === undefined || membership.status !== 'active')
      return null;

    const [grants, areas, locationGrants] = await Promise.all([
      this.db
        .select({ key: rolePermissions.permissionKey, scope: rolePermissions.scope })
        .from(rolePermissions)
        .where(eq(rolePermissions.roleId, membership.roleId)),
      this.db
        .select({ id: membershipAreas.areaId })
        .from(membershipAreas)
        .where(eq(membershipAreas.membershipId, membership.id)),
      this.db
        .select({ id: membershipLocations.locationId })
        .from(membershipLocations)
        .where(eq(membershipLocations.membershipId, membership.id)),
    ]);

    const permissions = new Map<PermissionKey, PermissionScope>();
    for (const grant of grants) {
      const key = grant.key as PermissionKey;
      const existing = permissions.get(key);
      permissions.set(key, existing === undefined ? grant.scope : widerScope(existing, grant.scope));
    }

    return {
      userId,
      tenantId,
      membershipId: membership.id,
      roleId: membership.roleId,
      permissions,
      areaIds: areas.map(a => a.id),
      locationIds: locationGrants.map(l => l.id),
    };
  }
}

export function scopeFor(context: AccessContext, key: PermissionKey): PermissionScope | null {
  return context.permissions.get(key) ?? null;
}

export function grantedNodes(context: AccessContext, scope: PermissionScope): readonly string[] {
  if (scope === 'LOCATION')
    return [...context.areaIds, ...context.locationIds];

  return scope === 'AREA' ? context.areaIds : [];
}
