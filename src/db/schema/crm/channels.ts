import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, numeric, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { CHANNEL_GENRES, CHANNEL_RESOLUTIONS } from '@/shared/constants/crm';
import { crm } from '../schemas';
import { tenants } from '../tenancy/tenants';
import { serviceProviders } from './service-providers';

export const channels = crm.table('channels', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  /**
   * The supplier whose lineup this channel is on.
   *
   * On the service, `unique(service_id, channel_number)` was a false conflict:
   * two MSOs of the same service both number a channel 101, and both are right.
   */
  serviceProviderId: uuid('service_provider_id').notNull().references(() => serviceProviders.id, { onDelete: 'cascade' }),

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

  metadata: jsonb('metadata'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('channels_provider_number_unq').on(table.serviceProviderId, table.channelNumber),
  unique('channels_provider_slug_unq').on(table.serviceProviderId, table.slug),
  index('channels_provider_idx').on(table.serviceProviderId),
  index('channels_tenant_genre_idx').on(table.tenantId, table.genre),
  index('channels_languages_idx').using('gin', table.languages),
  index('channels_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Channel = typeof channels.$inferSelect;
export type NewChannel = typeof channels.$inferInsert;
