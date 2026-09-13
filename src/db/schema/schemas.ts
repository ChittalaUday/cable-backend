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

/** Notifications and their per-channel delivery state. */
export const notify = pgSchema('notify');

/**
 * Files and media: uploads from the app, and artefacts the backend generates.
 *
 * Rows here are METADATA. The bytes live in object storage (Cloudflare R2) and
 * never pass through this service — see §8.4.
 */
export const media = pgSchema('media');

/**
 * Cross-domain READ MODELS only — views and reporting aggregates.
 *
 * §3 forbids a module joining across a boundary in raw SQL. When a read genuinely
 * spans domains (a dashboard over customers, billing and tickets), it belongs
 * here as a named view: reviewable, indexed deliberately, and written once
 * instead of re-derived in three services. Never any tables of its own.
 */
export const analytics = pgSchema('analytics');
