import { sql } from 'drizzle-orm';
import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { SESSION_REVOKE_REASONS } from '@/constants/auth';
import { auth } from '../schemas';
import { devices } from './devices';
import { users } from './users';

export const sessions = auth.table('sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  deviceId: uuid('device_id').notNull().references(() => devices.id, { onDelete: 'cascade' }),

  refreshTokenHash: text('refresh_token_hash').notNull().unique(),
  prevTokenHash: text('prev_token_hash'),

  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),

  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: text('revoked_reason', { enum: SESSION_REVOKE_REASONS }),
}, table => [
  index('sessions_user_idx').on(table.userId),
  index('sessions_device_idx').on(table.deviceId),
  index('sessions_revoked_at_idx').on(table.revokedAt),
  index('sessions_active_prev_token_idx').on(table.prevTokenHash).where(sql`${table.revokedAt} IS NULL AND ${table.prevTokenHash} IS NOT NULL`),
]);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];
