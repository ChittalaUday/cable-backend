import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/constants/crm';
import { tenancy } from '../schemas';
// Circular by nature: a crew names its leader, a membership names its crew.
// Safe because this side is a lazy, explicitly typed thunk — it breaks both the
// module-evaluation cycle and the type-inference cycle.
import { tenantMemberships } from './tenant-memberships';
import { tenants } from './tenants';

export const teams = tenancy.table('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),

  name: text('name').notNull(),
  slug: text('slug').notNull(),
  description: text('description'),

  status: text('status', { enum: ENTITY_STATUSES }).notNull().default('active'),

  leaderMembershipId: uuid('leader_membership_id').references((): AnyPgColumn => tenantMemberships.id, { onDelete: 'set null' }),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  unique('teams_tenant_slug_uq').on(table.tenantId, table.slug),

  unique('teams_tenant_id_uq').on(table.tenantId, table.id),

  // One membership leads at most one crew.
  unique('teams_leader_membership_uq').on(table.leaderMembershipId),

  index('teams_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
