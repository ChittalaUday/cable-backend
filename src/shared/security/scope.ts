import type { PermissionScope } from './permissions';
import { SCOPE_RANK } from './permissions';

export interface ResourceMeta {
  createdBy?: string | null;
  assignedTo?: string | null;
  teamId?: string | null;
  locationId?: string | null;
}

export interface AccessContext {
  userId: string;
  teamId: string | null;
  locationIds: ReadonlySet<string>;
}

export function widerScope(a: PermissionScope, b: PermissionScope): PermissionScope {
  return SCOPE_RANK[a] >= SCOPE_RANK[b] ? a : b;
}

const SCOPE_CHECKS: Record<
  Exclude<PermissionScope, 'ALL'>,
  (ctx: AccessContext, meta: ResourceMeta) => boolean
> = {
  LOCATION: (ctx, meta) => meta.locationId != null && ctx.locationIds.has(meta.locationId),
  TEAM: (ctx, meta) => meta.teamId != null && ctx.teamId != null && meta.teamId === ctx.teamId,
  ASSIGNED: (ctx, meta) => meta.assignedTo != null && meta.assignedTo === ctx.userId,
  OWN: (ctx, meta) => meta.createdBy != null && meta.createdBy === ctx.userId,
};

export function scopeReachesResource(
  granted: PermissionScope,
  ctx: AccessContext,
  meta: ResourceMeta = {},
): boolean {
  if (granted === 'ALL')
    return true;

  return SCOPE_CHECKS[granted](ctx, meta);
}
