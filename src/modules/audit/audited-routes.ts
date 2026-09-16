import type { AuditAction } from '@/constants/audit';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, AUDIT_VERBS, auditAction } from '@/constants/audit';

export const AUDITED_ROUTES: Readonly<Record<string, readonly AuditAction[]>> = {
  'POST /api/v1/auth/otp/request': [AUDIT_ACTIONS.AUTH_OTP_REQUESTED, AUDIT_ACTIONS.AUTH_OTP_REFUSED],
  'POST /api/v1/auth/otp/verify': [AUDIT_ACTIONS.AUTH_OTP_VERIFIED, AUDIT_ACTIONS.AUTH_OTP_FAILED],
  'POST /api/v1/auth/login': [AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, AUDIT_ACTIONS.AUTH_LOGIN_FAILED],
  'POST /api/v1/auth/refresh': [AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED, AUDIT_ACTIONS.AUTH_TOKEN_REFRESH_FAILED, AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED],
  'POST /api/v1/auth/logout': [AUDIT_ACTIONS.AUTH_LOGOUT],
  'POST /api/v1/auth/logout-all': [AUDIT_ACTIONS.AUTH_LOGOUT_ALL],

  'POST /api/v1/location-categories': [auditAction(AUDIT_ENTITIES.LOCATION_CATEGORY, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/location-categories/:id': [auditAction(AUDIT_ENTITIES.LOCATION_CATEGORY, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/location-categories/:id': [auditAction(AUDIT_ENTITIES.LOCATION_CATEGORY, AUDIT_VERBS.DELETED)],
  'POST /api/v1/location-schemas': [auditAction(AUDIT_ENTITIES.LOCATION_SCHEMA, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/location-schemas/:id': [auditAction(AUDIT_ENTITIES.LOCATION_SCHEMA, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/location-schemas/:id': [auditAction(AUDIT_ENTITIES.LOCATION_SCHEMA, AUDIT_VERBS.DELETED)],
  'POST /api/v1/location-schemas/:id/generate': [AUDIT_ACTIONS.LOCATION_GENERATED],
  'POST /api/v1/locations': [auditAction(AUDIT_ENTITIES.LOCATION, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/locations/:id': [auditAction(AUDIT_ENTITIES.LOCATION, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/locations/:id': [auditAction(AUDIT_ENTITIES.LOCATION, AUDIT_VERBS.DELETED)],

  'POST /api/v1/services': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/services/:id': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/services/:id': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.DELETED)],
  'POST /api/v1/service-providers': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/service-providers/:id': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/service-providers/:id': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/services/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],
  'PUT /api/v1/service-providers/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],
  'PUT /api/v1/packages/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],

  'POST /api/v1/staff': [auditAction(AUDIT_ENTITIES.STAFF, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/staff/:id': [auditAction(AUDIT_ENTITIES.STAFF, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/staff/:id': [auditAction(AUDIT_ENTITIES.STAFF, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/staff/:id/locations': [auditAction(AUDIT_ENTITIES.STAFF_LOCATIONS, AUDIT_VERBS.UPDATED)],
  'PUT /api/v1/staff/:id/team-areas': [auditAction(AUDIT_ENTITIES.STAFF_TEAM_AREAS, AUDIT_VERBS.UPDATED)],
  'POST /api/v1/teams': [auditAction(AUDIT_ENTITIES.TEAM, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/teams/:id': [auditAction(AUDIT_ENTITIES.TEAM, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/teams/:id': [auditAction(AUDIT_ENTITIES.TEAM, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/teams/:id/locations': [auditAction(AUDIT_ENTITIES.TEAM_LOCATIONS, AUDIT_VERBS.UPDATED)],

  'POST /api/v1/packages': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/packages/:id': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/packages/:id': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/packages/:id/channels': [auditAction(AUDIT_ENTITIES.PACKAGE_CHANNELS, AUDIT_VERBS.UPDATED)],

  'POST /api/v1/inventory/items': [auditAction(AUDIT_ENTITIES.INVENTORY_ITEM, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/inventory/items/:id': [auditAction(AUDIT_ENTITIES.INVENTORY_ITEM, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/inventory/items/:id': [auditAction(AUDIT_ENTITIES.INVENTORY_ITEM, AUDIT_VERBS.DELETED)],
  'POST /api/v1/inventory/issue': [auditAction(AUDIT_ENTITIES.INVENTORY_CUSTOMER_EQUIPMENT, AUDIT_VERBS.CREATED)],
  'POST /api/v1/inventory/inward': [auditAction(AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT, AUDIT_VERBS.CREATED)],
  'POST /api/v1/inventory/transfer': [auditAction(AUDIT_ENTITIES.INVENTORY_STOCK_MOVEMENT, AUDIT_VERBS.CREATED)],
  'POST /api/v1/inventory/requests': [auditAction(AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST, AUDIT_VERBS.CREATED)],
  'POST /api/v1/inventory/requests/:id/review': [auditAction(AUDIT_ENTITIES.INVENTORY_APPROVAL_REQUEST, AUDIT_VERBS.UPDATED)],

  'POST /api/v1/remotes': [auditAction(AUDIT_ENTITIES.REMOTE, AUDIT_VERBS.CREATED)],
};

export const UNAUDITED_ROUTES: Readonly<Record<string, string>> = {
};

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
