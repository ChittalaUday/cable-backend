import { sql } from 'drizzle-orm';
import { boolean, check, index, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { auth } from '../schemas';

/**
 * Global identity — ONE row per human, across every tenant (AGENTS.md §4.1).
 *
 * There is deliberately no `role` column. A user's role is a property of their
 * membership in a tenant, because the same person can be an admin of one tenant
 * and a customer of another.
 */
export const users = auth.table('users', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Sign-in identifier. At least one of email/phone must be present. */
  email: text('email').unique(),

  /** 10-digit Indian mobile number without country code or symbols. */
  phone: varchar('phone', { length: 10 }).unique(),

  /** Null means the account has no password and signs in with Google only. */
  passwordHash: text('password_hash'),
  /** Google's stable subject id. Set when the account is linked to Google. */
  googleSub: text('google_sub').unique(),

  name: text('name'),
  photoUrl: text('photo_url'),

  /** Platform-level role (§4.2). Not tenant-scoped. */
  isSuperAdmin: boolean('is_super_admin').notNull().default(false),

  /** Non-null disables every session everywhere (§4.6). */
  disabledAt: timestamp('disabled_at', { withTimezone: true }),

  /**
   * Bumped whenever credentials change. Sessions issued before this are revoked
   * — see §4.6 "these cascade automatically".
   */
  credentialsChangedAt: timestamp('credentials_changed_at', { withTimezone: true }).notNull().defaultNow(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('users_identifier_present', sql`${table.email} IS NOT NULL OR ${table.phone} IS NOT NULL`),
  check('users_phone_ten_digits', sql`${table.phone} IS NULL OR ${table.phone} ~ '^[0-9]{10}$'`),
  index('users_disabled_at_idx').on(table.disabledAt),
]);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
