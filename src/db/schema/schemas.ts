import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * PostgreSQL schemas, one per bounded domain (AGENTS.md §8.2).
 *
 * The modular monolith's boundaries (§3) exist in the database too, not only in
 * the import graph. A query joining `crm.customers` to `auth.users` is visibly
 * crossing a boundary — in the SQL, in a query plan, and in a slow-query log.
 *
 * Nothing lives in `public`.
 */

/** Tenants and the memberships that scope every user to them. */
export const tenancy = pgSchema('tenancy');

/** Identity and credentials: users, sessions, devices, OTPs. */
export const auth = pgSchema('auth');

/** Roles, permissions and their grants. */
export const iam = pgSchema('iam');

/** Subscriber-facing business records. */
export const crm = pgSchema('crm');
