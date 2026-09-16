import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { LocationRef } from './staff.schema';
import type * as schema from '@/db/schema';
import type { RequestAccess } from '@/modules/iam/access.service';
import type { PermissionKey } from '@/security/permissions';
import { eq, inArray, sql } from 'drizzle-orm';
import {
  locationPaths,
  locations,
  membershipLocations,
  teamLocations,
  teamMemberLocations,
  teams,
  tenantMemberships,
} from '@/db/schema';
import { ERROR_CODES } from '@/errors';
import { forbidden } from '@/errors/domain-error';
import { grantedNodes, requireScope } from '@/modules/iam/access.service';
import { underAnyGrant, withinGrantedSubtree } from '@/security/location-scope';

type Db = NodePgDatabase<typeof schema>;

const MEMBERSHIP_NODES = sql`
  SELECT ml.location_id FROM tenancy.membership_locations ml
    WHERE ml.membership_id = tenancy.tenant_memberships.id
  UNION ALL
  SELECT tml.location_id FROM tenancy.team_member_locations tml
    WHERE tml.membership_id = tenancy.tenant_memberships.id
  UNION ALL
  -- The crew's whole patch counts only for a member who has not been narrowed
  -- to part of it; the same rule AccessService.load applies.
  SELECT tl.location_id FROM tenancy.team_locations tl
    WHERE tl.team_id = tenancy.tenant_memberships.team_id
      AND NOT EXISTS (
        SELECT 1 FROM tenancy.team_member_locations x
        WHERE x.membership_id = tenancy.tenant_memberships.id
      )
`;

export function staffReach(access: RequestAccess, key: PermissionKey): SQL[] | null {
  const scope = requireScope(access, key);

  if (scope === 'ALL')
    return [];

  if (scope === 'LOCATION') {
    const granted = grantedNodes(access, scope);
    if (granted.length === 0)
      return null;

    return [sql`EXISTS (
      SELECT 1 FROM (${MEMBERSHIP_NODES}) AS reachable(location_id)
      WHERE ${withinGrantedSubtree(sql`reachable.location_id`, granted)}
    )`];
  }

  if (scope === 'TEAM')
    return access.teamId === null ? null : [eq(tenantMemberships.teamId, access.teamId)];

  return [eq(tenantMemberships.id, access.membershipId)];
}

export function teamReach(access: RequestAccess, key: PermissionKey): SQL[] | null {
  const scope = requireScope(access, key);

  if (scope === 'ALL')
    return [];

  if (scope === 'LOCATION') {
    const granted = grantedNodes(access, scope);
    if (granted.length === 0)
      return null;

    return [sql`EXISTS (
      SELECT 1 FROM tenancy.team_locations tl
      WHERE tl.team_id = tenancy.teams.id
        AND ${withinGrantedSubtree(sql`tl.location_id`, granted)}
    )`];
  }

  return access.teamId === null ? null : [eq(teams.id, access.teamId)];
}

export function servesNode(locationId: string): SQL {
  return sql`EXISTS (
    SELECT 1 FROM geo.location_ancestors(${locationId}) AS a
    WHERE a.id IN (${MEMBERSHIP_NODES})
  )`;
}

export async function assertWithinGrant(
  db: Db,
  access: RequestAccess,
  grant: { ids: readonly string[]; key: PermissionKey },
): Promise<void> {
  const scope = requireScope(access, grant.key);

  if (scope === 'ALL' || grant.ids.length === 0)
    return;

  const granted = access.locationIds;
  if (granted.length === 0)
    throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'You hold no area you could grant');

  const outside = await db.execute<{ id: string }>(sql`
    SELECT w.id
    FROM unnest(${sql.param([...grant.ids])}::uuid[]) AS w(id)
    WHERE NOT ${underAnyGrant(sql`w.id`, granted)}
    LIMIT 1
  `);

  if (outside.rows.length > 0)
    throw forbidden(ERROR_CODES.PERM_SCOPE_DENIED, 'That area is outside your own grant');
}

export interface AreaGrants {
  own: Map<string, LocationRef[]>;
  team: Map<string, LocationRef[]>;
  narrowed: Map<string, LocationRef[]>;
}

interface GrantRow { owner: string; id: string; name: string; path: string }

function groupRefs(rows: readonly GrantRow[]): Map<string, LocationRef[]> {
  const grouped = new Map<string, LocationRef[]>();

  for (const row of rows) {
    const list = grouped.get(row.owner) ?? [];
    list.push({ id: row.id, name: row.name, path: row.path });
    grouped.set(row.owner, list);
  }

  return grouped;
}

export async function areaGrantsFor(
  db: Db,
  owners: { membershipIds?: readonly string[]; teamIds?: readonly string[] },
): Promise<AreaGrants> {
  const membershipIds = [...new Set(owners.membershipIds ?? [])];
  const teamIds = [...new Set(owners.teamIds ?? [])];
  const empty: GrantRow[] = [];

  const [own, team, narrowed] = await Promise.all([
    membershipIds.length === 0
      ? empty
      : db
          .select({ owner: membershipLocations.membershipId, id: locations.id, name: locations.name, path: locationPaths.path })
          .from(membershipLocations)
          .innerJoin(locations, eq(locations.id, membershipLocations.locationId))
          .innerJoin(locationPaths, eq(locationPaths.id, locations.id))
          .where(inArray(membershipLocations.membershipId, membershipIds)),
    teamIds.length === 0
      ? empty
      : db
          .select({ owner: teamLocations.teamId, id: locations.id, name: locations.name, path: locationPaths.path })
          .from(teamLocations)
          .innerJoin(locations, eq(locations.id, teamLocations.locationId))
          .innerJoin(locationPaths, eq(locationPaths.id, locations.id))
          .where(inArray(teamLocations.teamId, teamIds)),
    membershipIds.length === 0
      ? empty
      : db
          .select({ owner: teamMemberLocations.membershipId, id: locations.id, name: locations.name, path: locationPaths.path })
          .from(teamMemberLocations)
          .innerJoin(locations, eq(locations.id, teamMemberLocations.locationId))
          .innerJoin(locationPaths, eq(locationPaths.id, locations.id))
          .where(inArray(teamMemberLocations.membershipId, membershipIds)),
  ]);

  return { own: groupRefs(own), team: groupRefs(team), narrowed: groupRefs(narrowed) };
}
