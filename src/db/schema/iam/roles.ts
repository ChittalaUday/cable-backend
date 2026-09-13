import { boolean, index, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { PERMISSION_SCOPES } from '@/shared/security/permissions';
import { iam } from '../schemas';
import { tenants } from '../tenancy/tenants';

/**
 * A named bundle of permissions (AGENTS.md §5).
 *
 * `tenantId` null means a system role shared by every tenant (`admin`, `staff`,
 * `customer`). A non-null `tenantId` is a custom role owned by that tenant.
 */
export const roles = iam.table('roles', {
  id: text('id').primaryKey(),
  tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  description: text('description'),
  isSystem: boolean('is_system').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  index('roles_tenant_id_idx').on(table.tenantId),
]);

/**
 * One permission grant on a role, carrying the scope it is granted at (§5).
 * The scope is what the service-layer check compares against the record.
 */
export const rolePermissions = iam.table('role_permissions', {
  roleId: text('role_id').notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permissionKey: text('permission_key').notNull(),
  scope: text('scope', { enum: PERMISSION_SCOPES }).notNull(),
}, table => [
  primaryKey({ columns: [table.roleId, table.permissionKey] }),
]);

export type Role = typeof roles.$inferSelect;
export type RolePermission = typeof rolePermissions.$inferSelect;
