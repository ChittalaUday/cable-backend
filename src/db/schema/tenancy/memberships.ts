import { index, integer, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { users } from '../auth/users';
import { locations } from '../geo/locations';
import { roles } from '../iam/roles';
import { tenancy } from '../schemas';
import { tenants } from './tenants';

export const tenantMemberships = tenancy.table('tenant_memberships', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  tenantId: uuid('tenant_id').notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  roleId: text('role_id').notNull().references(() => roles.id),

  status: text('status', { enum: ['active', 'invited', 'suspended'] }).notNull().default('active'),

  teamId: uuid('team_id'),

  permissionVersion: integer('permission_version').notNull().default(1),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  unique('tenant_memberships_user_tenant_uq').on(table.userId, table.tenantId),
  index('tenant_memberships_tenant_idx').on(table.tenantId),
  index('tenant_memberships_user_idx').on(table.userId),
]);

export const membershipAreas = tenancy.table('membership_areas', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  areaId: uuid('area_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
}, table => [
  unique('membership_areas_uq').on(table.membershipId, table.areaId),
]);

export const membershipLocations = tenancy.table('membership_locations', {
  membershipId: uuid('membership_id').notNull().references(() => tenantMemberships.id, { onDelete: 'cascade' }),
  locationId: uuid('location_id').notNull().references(() => locations.id, { onDelete: 'cascade' }),
}, table => [
  unique('membership_locations_uq').on(table.membershipId, table.locationId),
]);

export type TenantMembership = typeof tenantMemberships.$inferSelect;
export type NewTenantMembership = typeof tenantMemberships.$inferInsert;
