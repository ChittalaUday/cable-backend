/**
 * The canonical permission catalogue (AGENTS.md §5).
 *
 * This repo is the source of truth. Clients mirror this file; a key that exists
 * only on a client is not a permission, it is a suggestion.
 */

/** Access boundaries a grant can carry. */
export const PERMISSION_SCOPES = ['OWN', 'ASSIGNED', 'TEAM', 'AREA', 'LOCATION', 'ALL'] as const;

export type PermissionScope = (typeof PERMISSION_SCOPES)[number];

/**
 * Scope ranking: a higher rank includes everything below it.
 * ALL > LOCATION > AREA > TEAM > ASSIGNED > OWN
 */
export const SCOPE_RANK: Record<PermissionScope, number> = {
  OWN: 1,
  ASSIGNED: 2,
  TEAM: 3,
  AREA: 4,
  LOCATION: 5,
  ALL: 6,
};

/** `resource.action` keys. Values are the wire format and never change once shipped. */
export const PERMISSIONS = {
  USERS_VIEW: 'users.view',
  USERS_CREATE: 'users.create',
  USERS_UPDATE: 'users.update',
  USERS_DELETE: 'users.delete',

  TENANTS_VIEW: 'tenants.view',
  TENANTS_CREATE: 'tenants.create',
  TENANTS_UPDATE: 'tenants.update',
  TENANTS_DELETE: 'tenants.delete',

  CUSTOMERS_VIEW: 'customers.view',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_UPDATE: 'customers.update',
  CUSTOMERS_DELETE: 'customers.delete',

  STAFF_VIEW: 'staff.view',
  STAFF_CREATE: 'staff.create',
  STAFF_UPDATE: 'staff.update',
  STAFF_DELETE: 'staff.delete',

  CONNECTIONS_VIEW: 'connections.view',
  CONNECTIONS_CREATE: 'connections.create',
  CONNECTIONS_UPDATE: 'connections.update',
  CONNECTIONS_DELETE: 'connections.delete',

  PACKAGES_VIEW: 'packages.view',
  PACKAGES_CREATE: 'packages.create',
  PACKAGES_UPDATE: 'packages.update',
  PACKAGES_DELETE: 'packages.delete',

  SERVICES_VIEW: 'services.view',
  SERVICES_CREATE: 'services.create',
  SERVICES_UPDATE: 'services.update',
  SERVICES_DELETE: 'services.delete',

  PAYMENTS_VIEW: 'payments.view',
  PAYMENTS_CREATE: 'payments.create',
  PAYMENTS_UPDATE: 'payments.update',
  PAYMENTS_DELETE: 'payments.delete',
  PAYMENTS_COLLECT: 'payments.collect',

  TICKETS_VIEW: 'tickets.view',
  TICKETS_CREATE: 'tickets.create',
  TICKETS_UPDATE: 'tickets.update',
  TICKETS_ASSIGN: 'tickets.assign',
  TICKETS_RESOLVE: 'tickets.resolve',
  TICKETS_DELETE: 'tickets.delete',

  INVENTORY_VIEW: 'inventory.view',
  INVENTORY_UPDATE: 'inventory.update',

  REPORTS_VIEW: 'reports.view',
  REPORTS_EXPORT: 'reports.export',

  SETTINGS_VIEW: 'settings.view',
  SETTINGS_UPDATE: 'settings.update',

  ROLES_VIEW: 'roles.view',
  ROLES_CREATE: 'roles.create',
  ROLES_UPDATE: 'roles.update',
  ROLES_DELETE: 'roles.delete',
  PERMISSIONS_VIEW: 'permissions.view',

  AUDIT_VIEW: 'audit.view',

  DEVICES_VIEW: 'devices.view',
  DEVICES_BLOCK: 'devices.block',

  SESSIONS_VIEW: 'sessions.view',
  SESSIONS_REVOKE: 'sessions.revoke',
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSION_KEYS = Object.values(PERMISSIONS) as PermissionKey[];

/**
 * True when `granted` reaches at least as far as `required`.
 * Pure comparison of the hierarchy — it says nothing about a specific record.
 */
export function scopeReaches(granted: PermissionScope, required: PermissionScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}
