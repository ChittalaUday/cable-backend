import { sql } from 'drizzle-orm';
import { index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { OTP_PURPOSES } from '@/shared/constants/auth';
import { auth } from '../schemas';

export const otpCodes = auth.table('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),

  identifier: text('identifier').notNull(),
  purpose: text('purpose', { enum: OTP_PURPOSES }).notNull().default('login'),
  channel: text('channel').notNull(),

  codeHash: text('code_hash').notNull(),

  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull(),

  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  supersededAt: timestamp('superseded_at', { withTimezone: true }),

  lastSentAt: timestamp('last_sent_at', { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('otp_codes_identifier_idx').on(table.identifier, table.createdAt.desc()),
  index('otp_codes_expires_at_idx').on(table.expiresAt),
  uniqueIndex('otp_codes_one_active_idx').on(table.identifier, table.purpose).where(sql`${table.consumedAt} IS NULL AND ${table.supersededAt} IS NULL`),
]);

export type OtpCode = typeof otpCodes.$inferSelect;
export type NewOtpCode = typeof otpCodes.$inferInsert;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
