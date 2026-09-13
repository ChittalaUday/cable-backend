import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auth } from '../schemas';

export const OTP_PURPOSES = ['login', 'verify_phone'] as const;

/**
 * A one-time code issued to a phone number (AGENTS.md §4.3.1).
 *
 * The code itself is never stored — only a hash bound to the identifier, so a
 * code minted for one number cannot be replayed against another.
 *
 * There is no `user_id`: a code is issued against a phone number, which may
 * belong to nobody yet. Resolving it to an account happens at verify time.
 */
export const otpCodes = auth.table('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Normalised phone, E.164 digits without `+`. */
  identifier: text('identifier').notNull(),
  purpose: text('purpose', { enum: OTP_PURPOSES }).notNull().default('login'),
  channel: text('channel').notNull(),

  /** sha-256 of `code:identifier`. See `hashOtp` for why a fast hash is right here. */
  codeHash: text('code_hash').notNull(),

  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  /** Set the moment it is used. A consumed code is dead even before it expires. */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  /** Set when a newer code supersedes this one, so only one is ever live. */
  supersededAt: timestamp('superseded_at', { withTimezone: true }),

  /** Drives the resend cooldown. */
  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('otp_codes_identifier_idx').on(table.identifier, table.createdAt.desc()),
  index('otp_codes_expires_at_idx').on(table.expiresAt),
]);

export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
