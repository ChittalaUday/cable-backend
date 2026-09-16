import type { RemoteDeviceType, RemoteSource } from '@/constants/remotes';
import type { RemoteButton } from '@/types/remotes';
import { boolean, index, jsonb, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { remotesSchema } from '../schemas';
import { tenants } from '../tenancy/tenants';

export const remotes = remotesSchema.table('remotes', {
  id: uuid('id').primaryKey().defaultRandom(),

  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),

  deviceType: text('device_type').$type<RemoteDeviceType>().notNull(),
  brand: text('brand').notNull(),
  model: text('model').notNull(),

  source: text('source').$type<RemoteSource>().notNull().default('library'),

  verified: boolean('verified').notNull().default(false),

  notes: text('notes'),

  buttons: jsonb('buttons').$type<RemoteButton[]>().notNull(),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('remotes_tenant_model_uq')
    .on(table.tenantId, table.deviceType, table.brand, table.model)
    .nullsNotDistinct(),
  index('remotes_device_type_idx').on(table.deviceType),
  index('remotes_tenant_idx').on(table.tenantId),
]);

export type RemoteRecord = typeof remotes.$inferSelect;
export type NewRemoteRecord = typeof remotes.$inferInsert;

export type { IrCommand, RemoteButton } from '@/types/remotes';
