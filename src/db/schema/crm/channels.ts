import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CHANNEL_GENRES, CHANNEL_RESOLUTIONS } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { services } from './services';

/**
 * TV / IPTV channel catalog.
 *
 * Each channel belongs to a service offering / provider (e.g. ACT Cable TV, IPTV).
 * Logical Channel Number (LCN) is bound directly to the service provider,
 * with a unique constraint ensuring no two channels share the same LCN under a provider.
 */
export const channels = crm.table('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  serviceId: uuid('service_id').notNull().references(() => services.id, { onDelete: 'cascade' }),

  /** Logical Channel Number (LCN) assigned by this service provider. */
  channelNumber: integer('channel_number').notNull(),

  name: text('name').notNull(),
  slug: text('slug').notNull(),

  genre: text('genre', { enum: CHANNEL_GENRES }).notNull().default('General'),
  languages: text('languages').array().notNull().default(sql`ARRAY['Telugu']::text[]`),
  resolution: text('resolution', { enum: CHANNEL_RESOLUTIONS }).notNull().default('SD'),

  isFta: boolean('is_fta').notNull().default(false),
  broadcaster: text('broadcaster'),
  price: numeric('price', { precision: 12, scale: 2 }).notNull().default('0'),
  logoUrl: text('logo_url'),

  status: text('status', { enum: ['active', 'inactive'] }).notNull().default('active'),

  /** Provider-specific metadata (carrier frequency, audio PID, video PID, transponder, stream URL). */
  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('channels_service_number_unq').on(table.serviceId, table.channelNumber),
  unique('channels_service_slug_unq').on(table.serviceId, table.slug),
  index('channels_service_idx').on(table.serviceId),
  index('channels_tenant_genre_idx').on(table.tenantId, table.genre),
  index('channels_languages_idx').using('gin', table.languages),
  index('channels_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
