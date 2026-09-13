import { sql } from 'drizzle-orm';
import { check, primaryKey, text, timestamp } from 'drizzle-orm/pg-core';
import { PERMISSION_SCOPES } from '@/shared/security/permissions';
import { iam } from '../schemas';

export const roles = iam.table('roles', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('roles_known_id', sql`${table.id} IN ('admin', 'staff', 'customer')`),
]);

export const rolePermissions = iam.table('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull(),
  scope: text('scope', { enum: PERMISSION_SCOPES }).notNull(),
}, table => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
  check('role_permissions_known_scope', sql`${table.scope} IN ('OWN', 'ASSIGNED', 'TEAM', 'AREA', 'LOCATION', 'ALL')`),
]);

export type Role = typeof roles.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
