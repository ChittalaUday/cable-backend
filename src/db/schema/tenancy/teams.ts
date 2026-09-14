import { index, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { ENTITY_STATUSES } from '@/shared/constants/crm';
import { tenancy } from '../schemas';
import { tenants } from './tenants';

/**
 * A crew inside one operator — the collection-round staff, the install crew.
 *
 * It exists to give the `TEAM` scope (§5) something to point at: a grant at
 * `TEAM` reaches the rows the holder's own team owns, which needs teams to be
 * rows rather than a string on a membership.
 *
 * **A team belongs to exactly one tenant and can never be shared.** The
 * `(tenant_id, id)` unique constraint below is not decoration — it is what lets
 * `tenant_memberships` carry a composite foreign key on the pair, so putting a
 * member in another operator's team is rejected by the database rather than by
 * a `WHERE tenant_id = ?` somebody can forget.
 */
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

  // The target of the composite FK on `tenant_memberships`. Redundant as an
  // index — `id` is already the primary key — but a composite foreign key can
  // only reference a uniquely constrained set of columns, and this is that set.
  unique('teams_tenant_id_uq').on(table.tenantId, table.id),

  index('teams_tenant_status_idx').on(table.tenantId, table.status),
]);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
