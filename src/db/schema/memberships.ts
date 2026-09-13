import { index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { roles } from './roles';
import { tenancy } from './schemas';
import { tenants } from './tenants';
import { users } from './users';

/**
 * The join that makes multi-tenancy work (AGENTS.md §4.1).
 *
 * A user's ROLE lives here, not on `users`. The same person can be `admin` of
 * one tenant and `customer` of another: one users row, two membership rows.
 */
export const tenantMemberships = tenancy.table('tenant_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id),

  status: text('status', { enum: ['active', 'invited', 'suspended'] }).notNull().default('active'),

  /** Scope anchors for stage-2 authorization checks (§5). */
  teamId: uuid('team_id'),

  /**
   * Bumped to invalidate this membership's cached permission map (§5).
   * Cheaper than evicting by key across instances, and impossible to get wrong.
   */
  permissionVersion: integer('permission_version').notNull().default(1),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('tenant_memberships_user_tenant_uq').on(table.userId, table.tenantId),
  index('tenant_memberships_tenant_idx').on(table.tenantId),
  index('tenant_memberships_user_idx').on(table.userId),
]);

/** Area grants backing the AREA scope. */
export const membershipAreas = tenancy.table('membership_areas', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id').notNull(),
}, table => [
  unique('membership_areas_uq').on(table.membershipId, table.areaId),
]);

/** Location grants backing the LOCATION scope. */
export const membershipLocations = tenancy.table('membership_locations', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull(),
}, table => [
  unique('membership_locations_uq').on(table.membershipId, table.locationId),
]);

export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;
