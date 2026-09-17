import { sql } from 'drizzle-orm';
import { index, integer, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { DEVICE_PLATFORMS } from '@/constants/auth';
import { auth } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const devices = auth.table('devices', {
  id: uuid('id').primaryKey().defaultRandom(),

  clientDeviceId: text('client_device_id').notNull().unique(),

  platform: text('platform', { enum: DEVICE_PLATFORMS }).notNull(),
  osVersion: text('os_version'),
  manufacturer: text('manufacturer'),
  model: text('model'),
  appVersion: text('app_version'),

  ramMb: integer('ram_mb'),
  screenResolution: text('screen_resolution'),

  // Push registration lives on the device, not the session: a signed-out phone
  // still receives promotional pushes, and lastTenantId is who to address them
  // from once there is no live session to read the tenant off.
  pushToken: text('push_token'),
  pushTokenUpdatedAt: timestamp('push_token_updated_at', { withTimezone: true }),
  lastTenantId: uuid('last_tenant_id').references(() => tenants.id, { onDelete: 'set null' }),

  blockedAt: timestamp('blocked_at', { withTimezone: true }),
  blockedReason: text('blocked_reason'),

  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('devices_blocked_at_idx').on(table.blockedAt),
  index('devices_push_token_idx')
    .on(table.lastTenantId)
    .where(sql`${table.pushToken} IS NOT NULL AND ${table.blockedAt} IS NULL`),
]);

export type Device = typeof devices.$inferSelect;
export type NewDevice = typeof devices.$inferInsert;
