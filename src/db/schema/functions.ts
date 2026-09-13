import { sql } from 'drizzle-orm';

export function normalizePhone(value: unknown) {
  return sql<string>`crm.normalize_phone(${value})`;
}

export function scopeRank(value: unknown) {
  return sql<number>`iam.scope_rank(${value})`;
}

export function similarity(left: unknown, right: unknown) {
  return sql<number>`similarity(${left}, ${right})`;
}

export function nextCustomerCode(tenantId: unknown) {
  return sql<string>`crm.next_customer_code(${tenantId})`;
}

export function locationDescendants(rootId: unknown) {
  return sql`geo.location_descendants(${rootId})`;
}

export function locationAncestors(nodeId: unknown) {
  return sql`geo.location_ancestors(${nodeId})`;
}
