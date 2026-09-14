import type { AuditAction } from '@/shared/constants/audit';
import { AUDIT_ACTIONS, AUDIT_ENTITIES, AUDIT_VERBS, auditAction } from '@/shared/constants/audit';

/**
 * Every route that changes something, and the audit action it writes.
 *
 * **Adding a mutating route means adding a line here.** `audit.coverage.test.ts`
 * walks the app's real route table and fails if a `POST`/`PUT`/`PATCH`/`DELETE`
 * is missing from this map, or if a line here names a route that no longer
 * exists. That is the whole point: a new endpoint cannot ship without somebody
 * deciding, in writing, what it records.
 *
 * The map declares intent, not proof — it cannot see whether the service method
 * behind the route actually calls `audit.created/updated/deleted`. Pair a new
 * entry with a test that asserts the row, the way `audit.trail.test.ts` does.
 *
 * Actions come from `shared/constants/audit.ts`; see docs/audit-trail.md.
 */
export const AUDITED_ROUTES: Readonly<Record<string, readonly AuditAction[]>> = {
  // ── auth: sign-in is audited on both outcomes (docs/audit-trail.md §2) ──
  'POST /api/v1/auth/otp/request': [AUDIT_ACTIONS.AUTH_OTP_REQUESTED, AUDIT_ACTIONS.AUTH_OTP_REFUSED],
  'POST /api/v1/auth/otp/verify': [AUDIT_ACTIONS.AUTH_OTP_VERIFIED, AUDIT_ACTIONS.AUTH_OTP_FAILED],
  'POST /api/v1/auth/login': [AUDIT_ACTIONS.AUTH_LOGIN_SUCCEEDED, AUDIT_ACTIONS.AUTH_LOGIN_FAILED],
  'POST /api/v1/auth/refresh': [AUDIT_ACTIONS.AUTH_TOKEN_REFRESHED, AUDIT_ACTIONS.AUTH_TOKEN_REFRESH_FAILED, AUDIT_ACTIONS.AUTH_TOKEN_REUSE_DETECTED],
  'POST /api/v1/auth/logout': [AUDIT_ACTIONS.AUTH_LOGOUT],
  'POST /api/v1/auth/logout-all': [AUDIT_ACTIONS.AUTH_LOGOUT_ALL],

  // ── locations ──
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

  // ── catalogue ──
  'POST /api/v1/services': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/services/:id': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/services/:id': [auditAction(AUDIT_ENTITIES.SERVICE, AUDIT_VERBS.DELETED)],
  'POST /api/v1/service-providers': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/service-providers/:id': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/service-providers/:id': [auditAction(AUDIT_ENTITIES.SERVICE_PROVIDER, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/services/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],
  'PUT /api/v1/service-providers/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],
  'PUT /api/v1/packages/:id/coverage': [auditAction(AUDIT_ENTITIES.SERVICE_COVERAGE, AUDIT_VERBS.UPDATED)],

  // ── packages ──
  'POST /api/v1/packages': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.CREATED)],
  'PATCH /api/v1/packages/:id': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.UPDATED)],
  'DELETE /api/v1/packages/:id': [auditAction(AUDIT_ENTITIES.PACKAGE, AUDIT_VERBS.DELETED)],
  'PUT /api/v1/packages/:id/channels': [auditAction(AUDIT_ENTITIES.PACKAGE_CHANNELS, AUDIT_VERBS.UPDATED)],
};

/**
 * Mutating routes that deliberately record nothing, each with the reason.
 *
 * An explicit exemption, not a silent gap — a reader can see the decision was
 * made. Anything not listed in either map fails the coverage test.
 */
export const UNAUDITED_ROUTES: Readonly<Record<string, string>> = {
  // Empty, and that is the current answer: every route that changes something
  // records it. This is the escape hatch, not an invitation.
};

export const MUTATING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;
