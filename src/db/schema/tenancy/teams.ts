import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/shared/constants/crm';
import { tenancy } from '../schemas';
import { tenants } from './tenants';

export const teams = tenancy.table('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),

  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  unique('teams_tenant_slug_uq').on(table.tenantId, table.slug),

  unique('teams_tenant_id_uq').on(table.tenantId, table.id),

  index('teams_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
