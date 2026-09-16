import type { SQL } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { underAnyGrant } from '@/security/location-scope';

export interface CoverageTarget {
  tenantId: string;
  serviceId: SQL | string;
  serviceProviderId: SQL | string | null;
  packageId: SQL | string | null;
}

const NIL = sql`NULL::uuid`;

/**
 * Does this catalogue entry sell anywhere the caller was granted?
 *
 * Availability only changes at a node that carries a coverage row, so probing
 * the granted nodes themselves plus every served node inside their subtrees
 * asks about every distinct region a grant contains — exactly, and without
 * walking the tree. `crm.coverage_allows` stays the single answer to "is this
 * sold here" (docs/services-providers-packages.md §5); this only chooses the
 * places to ask about.
 *
 * An entry nobody has configured coverage for sells everywhere, so it passes —
 * otherwise a tenant that configured nothing would show its staff nothing.
 */
export function coverageReachesGrant(target: CoverageTarget, nodeIds: readonly string[]): SQL {
  if (nodeIds.length === 0)
    return sql`false`;

  return sql`EXISTS (
    SELECT 1 FROM (
      SELECT granted.id FROM unnest(${sql.param([...nodeIds])}::uuid[]) AS granted(id)
      UNION
      SELECT c.location_id
      FROM crm.service_coverage c
      WHERE c.tenant_id = ${target.tenantId}
        AND c.service_id = ${target.serviceId}
        AND c.is_available
        AND ${underAnyGrant(sql`c.location_id`, nodeIds)}
    ) AS probe(id)
    WHERE crm.coverage_allows(
      ${target.tenantId},
      ${target.serviceId},
      ${target.serviceProviderId ?? NIL},
      ${target.packageId ?? NIL},
      probe.id
    )
  )`;
}
