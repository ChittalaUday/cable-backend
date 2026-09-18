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
