import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { devices } from './devices';
import { auth } from './schemas';
import { users } from './users';

export const SESSION_REVOKE_REASONS = [
  'logout',
  'logout_all',
  'reuse_detected',
  'admin_revoked',
  'credentials_changed',
  'device_blocked',
  'session_limit',
] as const;

/**
 * One signed-in ACCOUNT on one device (AGENTS.md §4.6). This is the `sid` claim.
 *
 * `(user_id, device_id)` is deliberately NOT unique — several accounts may be
 * signed in on one device, each with its own refresh token, and signing out of
 * one must not touch the others.
 */
export const sessions = auth.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),

  /** sha-256 of the current refresh token. The token itself is never stored. */
  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  /** The hash this one replaced. A hit here means a replay — see §4.6. */
  prevTokenHash: text('prev_token_hash'),

  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Written on login and refresh ONLY — never per request (§4.6). */
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),

  /** Revoking is a state change, never a delete — a deleted session cannot be investigated. */
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason', { enum: SESSION_REVOKE_REASONS }),
}, table => [
  index('sessions_user_idx').on(table.userId),
  index('sessions_device_idx').on(table.deviceId),
  index('sessions_revoked_at_idx').on(table.revokedAt),
]);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];
