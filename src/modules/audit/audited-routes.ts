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
 * Actions read `<entity>.<verb>`; see docs/audit-trail.md.
 */
export const AUDITED_ROUTES: Readonly<Record<string, readonly string[]>> = {
  // ── auth: sign-in is audited on both outcomes (docs/audit-trail.md §2) ──
  'POST /api/v1/auth/otp/request': ['auth.otp.requested', 'auth.otp.refused'],
  'POST /api/v1/auth/otp/verify': ['auth.otp.verified', 'auth.otp.failed'],
  'POST /api/v1/auth/login': ['auth.login.succeeded', 'auth.login.failed'],
  'POST /api/v1/auth/refresh': ['auth.token.refreshed', 'auth.token.refresh_failed', 'auth.token.reuse_detected'],
  'POST /api/v1/auth/logout': ['auth.logout'],
  'POST /api/v1/auth/logout-all': ['auth.logout_all'],

  // ── locations ──
  'POST /api/v1/location-categories': ['location_category.created'],
  'PATCH /api/v1/location-categories/:id': ['location_category.updated'],
  'DELETE /api/v1/location-categories/:id': ['location_category.deleted'],
  'POST /api/v1/location-schemas': ['location_schema.created'],
  'PATCH /api/v1/location-schemas/:id': ['location_schema.updated'],
  'DELETE /api/v1/location-schemas/:id': ['location_schema.deleted'],
  'POST /api/v1/location-schemas/:id/generate': ['location.generated'],
  'POST /api/v1/locations': ['location.created'],
  'PATCH /api/v1/locations/:id': ['location.updated'],
  'DELETE /api/v1/locations/:id': ['location.deleted'],

  // ── catalogue ──
  'POST /api/v1/services': ['service.created'],
  'PATCH /api/v1/services/:id': ['service.updated'],
  'DELETE /api/v1/services/:id': ['service.deleted'],
  'POST /api/v1/service-providers': ['service_provider.created'],
  'PATCH /api/v1/service-providers/:id': ['service_provider.updated'],
  'DELETE /api/v1/service-providers/:id': ['service_provider.deleted'],
  'PUT /api/v1/services/:id/coverage': ['service_coverage.updated'],
  'PUT /api/v1/service-providers/:id/coverage': ['service_coverage.updated'],

  // ── packages ──
  'POST /api/v1/packages': ['package.created'],
  'PATCH /api/v1/packages/:id': ['package.updated'],
  'DELETE /api/v1/packages/:id': ['package.deleted'],
  'PUT /api/v1/packages/:id/channels': ['package_channels.updated'],
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
