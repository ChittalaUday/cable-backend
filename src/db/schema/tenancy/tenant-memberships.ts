import { foreignKey, index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { roles } from '../iam/roles';
import { tenancy } from '../schemas';
import { teams } from './teams';
import { tenants } from './tenants';

export const tenantMemberships = tenancy.table('tenant_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id),

  status: text('status', { enum: ['active', 'invited', 'suspended'] }).notNull().default('active'),

  /**
   * The member's crew, or null for someone on none. Tied to `teams` through the
   * composite key below, never by `team_id` alone — see that constraint.
   */
  teamId: uuid('team_id'),

  permissionVersion: integer('permission_version').notNull().default(1),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('tenant_memberships_user_tenant_uq').on(table.userId, table.tenantId),

  /**
   * `(tenant_id, team_id)` rather than `team_id` alone, so a membership can only
   * join a team belonging to the same tenant it is a membership of. A plain FK
   * on `team_id` would happily accept another operator's team id.
   *
   * `team_id` is nullable and the default MATCH SIMPLE skips the check when any
   * referencing column is null, so "no team" stays legal.
   */
  foreignKey({
    columns: [table.tenantId, table.teamId],
    foreignColumns: [teams.tenantId, teams.id],
    name: 'tenant_memberships_team_fk',
  }),
  index('tenant_memberships_tenant_idx').on(table.tenantId),
  index('tenant_memberships_team_idx').on(table.teamId),
  index('tenant_memberships_user_idx').on(table.userId),
]);

export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;
