import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

export type LocationScope
  = | { kind: 'ALL_TENANT_LOCATIONS' }
    | { kind: 'NODES'; nodeIds: readonly string[] };

export function withinGrantedSubtree(column: SQL, nodeIds: readonly string[]): SQL {
  if (nodeIds.length === 0)
    return sql`false`;

  return sql`EXISTS (
    SELECT 1
    FROM unnest(${sql.param([...nodeIds])}::uuid[]) AS granted(id),
         geo.location_descendants(granted.id) AS d
    WHERE d.id = ${column}
  )`;
}

export function underAnyGrant(nodeId: SQL | string, nodeIds: readonly string[]): SQL {
  if (nodeIds.length === 0)
    return sql`false`;

  return sql`EXISTS (
    SELECT 1 FROM geo.location_ancestors(${nodeId}) AS a
    WHERE a.id = ANY(${sql.param([...nodeIds])}::uuid[])
  )`;
}

export function overlapsAnyGrant(column: SQL, nodeIds: readonly string[]): SQL {
  if (nodeIds.length === 0)
    return sql`false`;

  return sql`(${underAnyGrant(column, nodeIds)} OR EXISTS (
    SELECT 1
    FROM unnest(${sql.param([...nodeIds])}::uuid[]) AS granted(id),
         geo.location_ancestors(granted.id) AS a
    WHERE a.id = ${column}
  ))`;
}
