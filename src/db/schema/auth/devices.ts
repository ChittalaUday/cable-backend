import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { auth } from '../schemas';

export const devices = auth.table('devices', {
  id: uuid('id').primaryKey().defaultRandom(),

  clientDeviceId: text('client_device_id').notNull().unique(),

  platform: text('platform', { enum: ['ios', 'android', 'web'] }).notNull(),
  osVersion: text('os_version'),
  model: text('model'),
  appVersion: text('app_version'),

  ramMb: integer('ram_mb'),
  /** Physical pixels as the device reports them, e.g. "1080x2400". */
  screenResolution: text('screen_resolution'),

  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),

  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('devices_blocked_at_idx').on(table.blockedAt),
]);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
