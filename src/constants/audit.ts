export const AUDIT_ENTITIES = {
  AUTH: 'auth',
  LOCATION: 'location',
  LOCATION_CATEGORY: 'location_category',
  LOCATION_SCHEMA: 'location_schema',
  PACKAGE: 'package',
  PACKAGE_CHANNELS: 'package_channels',
  SERVICE: 'service',
  SERVICE_COVERAGE: 'service_coverage',
  SERVICE_PROVIDER: 'service_provider',
  STAFF: 'staff',
  STAFF_LOCATIONS: 'staff_locations',
  STAFF_TEAM_AREAS: 'staff_team_areas',
  STORAGE: 'storage',
  TEAM: 'team',
  TEAM_LOCATIONS: 'team_locations',
  INVENTORY_ITEM: 'inventory_item',
  INVENTORY_EQUIPMENT: 'inventory_equipment',
  INVENTORY_CUSTOMER_EQUIPMENT: 'inventory_customer_equipment',
  INVENTORY_STOCK_MOVEMENT: 'inventory_stock_movement',
  INVENTORY_APPROVAL_REQUEST: 'inventory_approval_request',
  REMOTE: 'remote',
} as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];

export const AUDIT_VERBS = {
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
} as const;

export type AuditVerb = (typeof AUDIT_VERBS)[keyof typeof AUDIT_VERBS];

export const AUDIT_ACTIONS = {
  AUTH_OTP_REQUESTED: 'auth.otp.requested',
  AUTH_OTP_REFUSED: 'auth.otp.refused',
  AUTH_OTP_VERIFIED: 'auth.otp.verified',
  AUTH_OTP_FAILED: 'auth.otp.failed',

  AUTH_LOGIN_SUCCEEDED: 'auth.login.succeeded',
  AUTH_LOGIN_FAILED: 'auth.login.failed',

  AUTH_TOKEN_REFRESHED: 'auth.token.refreshed',
  AUTH_TOKEN_REFRESH_FAILED: 'auth.token.refresh_failed',
  AUTH_TOKEN_REUSE_DETECTED: 'auth.token.reuse_detected',

  AUTH_LOGOUT: 'auth.logout',
  AUTH_LOGOUT_ALL: 'auth.logout_all',

  LOCATION_GENERATED: 'location.generated',

  STORAGE_CLEANED: 'storage.cleaned',
} as const;

export type AuditAction
  = | (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
    | `${AuditEntity}.${AuditVerb}`;

export function auditAction<E extends AuditEntity, V extends AuditVerb>(entity: E, verb: V): `${E}.${V}` {
  return `${entity}.${verb}`;
}
