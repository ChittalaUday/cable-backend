/**
 * The audit vocabulary: every entity that can be audited, and every action that
 * can be written about one.
 *
 * It lives in `shared/` for the same reason `security/permissions.ts` does —
 * eight modules write audit rows, the strings have to agree across all of them,
 * and `audited-routes.ts` names the same actions a third time. Three
 * hand-typed copies of `auth.token.reuse_detected` is two too many, and the
 * failure mode is silent: a typo writes a row nobody ever queries.
 *
 * `AuditAction` is the union of everything below, so a misspelling is a
 * compile error rather than a gap discovered during an incident.
 */

/** What a row is *about*. Snake case, singular — it is a table, not a route. */
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
  STORAGE: 'storage',
} as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[keyof typeof AUDIT_ENTITIES];

/**
 * The three verbs `audit.created/updated/deleted` derive an action from.
 *
 * Anything that is not one of these is spelled out in `AUDIT_ACTIONS` — a
 * sign-in is not a "create", and calling it one loses the distinction between
 * succeeded and failed that the whole auth trail rests on.
 */
export const AUDIT_VERBS = {
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
} as const;

export type AuditVerb = (typeof AUDIT_VERBS)[keyof typeof AUDIT_VERBS];

/** Everything that is not a plain create/update/delete. */
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

  /** A whole subtree in one call, so it is not one `location.created` per node. */
  LOCATION_GENERATED: 'location.generated',

  /** Written by the nightly job, with `systemAuditContext` and no tenant. */
  STORAGE_CLEANED: 'storage.cleaned',
} as const;

/**
 * Every action the system may write: the explicit ones above, plus the
 * `<entity>.<verb>` pairs the mutation helpers build.
 */
export type AuditAction
  = | (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS]
    | `${AuditEntity}.${AuditVerb}`;

/** `auditAction('service', 'created')` → `'service.created'`, typed as such. */
export function auditAction<E extends AuditEntity, V extends AuditVerb>(entity: E, verb: V): `${E}.${V}` {
  return `${entity}.${verb}`;
}
