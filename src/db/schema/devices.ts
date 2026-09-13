import { index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auth } from './schemas';

/**
 * One physical install of the app (AGENTS.md §4.6).
 *
 * A device header is client-supplied data: it identifies an install for support
 * and revocation. It is NOT an authentication factor and grants nothing.
 */
export const devices = auth.table('devices', {
  id: uuid('id').primaryKey().defaultRandom(),

  /** Stable opaque id the app generates once and keeps. */
  clientDeviceId: text('client_device_id').notNull().unique(),

  platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
  osVersion: text('os_version'),
  model: text('model'),
  appVersion: text('app_version'),

  /** Non-null refuses every session on this device (§4.6). */
  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),

  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  /** Written on login and refresh ONLY — never per request (§4.6). */
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('devices_blocked_at_idx').on(table.blockedAt),
]);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
