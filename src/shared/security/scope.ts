import type { PermissionScope } from './permissions';
import { SCOPE_RANK } from './permissions';

/**
 * Metadata of the record an action targets. Every field is optional because
 * not every resource carries every dimension.
 */
export interface ResourceMeta {
  createdBy?: string | null;
  assignedTo?: string | null;
  teamId?: string | null;
  areaId?: string | null;
  locationId?: string | null;
}

/** The caller's reach, resolved once per (user, tenant) and cached (AGENTS.md §5). */
export interface AccessContext {
  userId: string;
  teamId: string | null;
  areaIds: ReadonlySet<string>;
  locationIds: ReadonlySet<string>;
}

/** Merge two grants of the same key by taking the wider one. */
export function widerScope(a: PermissionScope, b: PermissionScope): PermissionScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

/**
 * One predicate per scope. Split out of a single switch so each rule reads on
 * its own line — this is the code that decides whether a staff member can touch
 * a record, and it should be readable without tracing branches.
 */
const SCOPE_CHECKS: Record<
  Exclude<PermissionScope, 'ALL'>,
  (ctx: AccessContext, meta: ResourceMeta) => boolean
> = {
  LOCATION: (ctx, meta) => meta.locationId != null && ctx.locationIds.has(meta.locationId),
  AREA: (ctx, meta) => meta.areaId != null && ctx.areaIds.has(meta.areaId),
  TEAM: (ctx, meta) => meta.teamId != null && ctx.teamId != null && meta.teamId === ctx.teamId,
  ASSIGNED: (ctx, meta) => meta.assignedTo != null && meta.assignedTo === ctx.userId,
  OWN: (ctx, meta) => meta.createdBy != null && meta.createdBy === ctx.userId,
};

/**
 * Stage 2 of the authorization check (AGENTS.md §5): does the granted scope
 * actually reach THIS record?
 *
 * Stage 1 (does the user hold the key at all) happens in the route guard. A
 * route guard without this call is a security bug — `customers.update` at scope
 * AREA passes the guard for every customer in the system.
 *
 * Fails closed: a scope that needs a dimension the record does not carry is
 * denied, never waved through.
 */
export function scopeReachesResource(
  granted: PermissionScope,
  ctx: AccessContext,
  meta: ResourceMeta = {},
): boolean {
  if (granted === 'ALL')
    return true;

  return SCOPE_CHECKS[granted](ctx, meta);
}
