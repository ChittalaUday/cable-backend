import { foreignKey, index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { MEMBERSHIP_STATUSES } from '@/constants/tenancy';
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

  status: text('status', { enum: MEMBERSHIP_STATUSES }).notNull().default('active'),

  teamId: uuid('team_id'),

  permissionVersion: integer('permission_version').notNull().default(1),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
}, table => [
  // Stays total, not partial: crm.account_transactions points its collector at
  // (tenant_id, user_id) and Postgres will not hang a foreign key off a partial
  // index. Taking someone back on restores this row instead of inserting a second.
  unique('tenant_memberships_user_tenant_uq').on(table.userId, table.tenantId),

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
