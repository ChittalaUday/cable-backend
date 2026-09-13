import { sql } from 'drizzle-orm';

/**
 * SQL functions this codebase calls by name (AGENTS.md §8.3).
 *
 * The DDL lives in a migration; these are the typed call sites, so a rename
 * breaks the build rather than a query at runtime.
 *
 * Only pure, deterministic, data-shaping helpers belong in the database. A
 * function that encodes a business rule would be a second implementation of
 * that rule, out of reach of the linter, the tests and code review — and §8.1
 * already rejects triggers for the same reason.
 */

/**
 * `crm.normalize_phone(text) → text` — digits only, no `+`, no separators.
 *
 * This exists in the database because an **expression index** needs it there:
 * `create index on crm.customers (crm.normalize_phone(phone))` makes a search
 * for `83091 54716` hit a customer stored as `+91-8309154716`. Application code
 * cannot supply a function to an index.
 */
export function normalizePhone(value: unknown) {
  return sql<string>`crm.normalize_phone(${value})`;
}

/**
 * `iam.scope_rank(text) → int` — the §5 hierarchy as SQL.
 *
 * OWN(1) < ASSIGNED(2) < TEAM(3) < AREA(4) < LOCATION(5) < ALL(6).
 * Mirrors `SCOPE_RANK` in `shared/security/permissions.ts`; a test asserts the
 * two agree, because two copies of a ranking that drift is a privilege bug.
 */
export function scopeRank(value: unknown) {
  return sql<number>`iam.scope_rank(${value})`;
}

/** Trigram similarity, for fuzzy name search once `pg_trgm` is in play (§2). */
export function similarity(left: unknown, right: unknown) {
  return sql<number>`similarity(${left}, ${right})`;
}

/**
 * `crm.next_customer_code(uuid) → text` — atomically increments `customer_seq`
 * on the tenant under row lock and returns `{TENANT_CODE}-{seq}` (e.g. `SSCN-000123`).
 */
export function nextCustomerCode(tenantId: unknown) {
  return sql<string>`crm.next_customer_code(${tenantId})`;
}
