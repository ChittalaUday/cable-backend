/**
 * The error-code catalogue (AGENTS.md §7.1).
 *
 * The HTTP status says what CLASS of thing went wrong; the code says WHICH one.
 * A 403 alone cannot tell a client whether to show "ask your admin", "switch
 * tenant", or "your account was suspended".
 *
 * A shipped code never changes meaning and is never deleted — app builds in the
 * wild branch on it. Add a new code instead.
 *
 * This repo is the source of truth. Clients mirror this file.
 */
export const ERROR_CODES = {
  // ─── Authentication (§4.3, §4.6) ────────────────────────────────────────────
  AUTH_HEADER_MISSING: 'AUTH_HEADER_MISSING',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  /** The one 401 that means "refresh and retry", not "sign out". */
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_REFRESH_INVALID: 'AUTH_REFRESH_INVALID',
  /** A rotated refresh token was replayed; the session family is revoked. */
  AUTH_REFRESH_REUSED: 'AUTH_REFRESH_REUSED',
  AUTH_SESSION_REVOKED: 'AUTH_SESSION_REVOKED',
  AUTH_CREDENTIALS_INVALID: 'AUTH_CREDENTIALS_INVALID',
  /** Password login attempted on a Google-only account. */
  AUTH_PASSWORD_NOT_SET: 'AUTH_PASSWORD_NOT_SET',
  AUTH_GOOGLE_TOKEN_INVALID: 'AUTH_GOOGLE_TOKEN_INVALID',
  AUTH_ACCOUNT_DISABLED: 'AUTH_ACCOUNT_DISABLED',
  AUTH_DEVICE_BLOCKED: 'AUTH_DEVICE_BLOCKED',
  AUTH_DEVICE_HEADER_MISSING: 'AUTH_DEVICE_HEADER_MISSING',

  // ─── Tenancy (§4.4) ─────────────────────────────────────────────────────────
  TENANT_HEADER_MISSING: 'TENANT_HEADER_MISSING',
  TENANT_NOT_A_MEMBER: 'TENANT_NOT_A_MEMBER',
  TENANT_MEMBERSHIP_SUSPENDED: 'TENANT_MEMBERSHIP_SUSPENDED',
  TENANT_INACTIVE: 'TENANT_INACTIVE',
  TENANT_CODE_UNAVAILABLE: 'TENANT_CODE_UNAVAILABLE',

  // ─── Authorization (§5) ─────────────────────────────────────────────────────
  /** Permission key not held at all — stage 1. */
  PERM_DENIED: 'PERM_DENIED',
  /** Key held, but the granted scope does not reach this record — stage 2. */
  PERM_SCOPE_DENIED: 'PERM_SCOPE_DENIED',

  // ─── OTP (§4.3) ─────────────────────────────────────────────────────────────
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_TOO_MANY_ATTEMPTS: 'OTP_TOO_MANY_ATTEMPTS',
  OTP_RESEND_TOO_SOON: 'OTP_RESEND_TOO_SOON',
  /** Delivery failed at the provider. The OTP was NOT sent — never treat as success. */
  OTP_DELIVERY_FAILED: 'OTP_DELIVERY_FAILED',
  OTP_CHANNEL_UNAVAILABLE: 'OTP_CHANNEL_UNAVAILABLE',
  /** Email OTP is deliberately switched off until an email provider is chosen. */
  OTP_EMAIL_NOT_SUPPORTED: 'OTP_EMAIL_NOT_SUPPORTED',

  // ─── Validation ─────────────────────────────────────────────────────────────
  VALIDATION_FAILED: 'VALIDATION_FAILED',

  // ─── Resources ──────────────────────────────────────────────────────────────
  /** Missing, OR owned by another tenant. Deliberately indistinguishable (§4.5). */
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_DUPLICATE_EMAIL: 'RESOURCE_DUPLICATE_EMAIL',
  RESOURCE_DUPLICATE_PHONE: 'RESOURCE_DUPLICATE_PHONE',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  RESOURCE_IN_USE: 'RESOURCE_IN_USE',

  // ─── Storage (§8.4) ─────────────────────────────────────────────────────────
  STORAGE_NOT_CONFIGURED: 'STORAGE_NOT_CONFIGURED',
  STORAGE_FILE_TOO_LARGE: 'STORAGE_FILE_TOO_LARGE',
  STORAGE_TYPE_NOT_ALLOWED: 'STORAGE_TYPE_NOT_ALLOWED',
  /** An upload URL was issued but nothing was uploaded to it. */
  STORAGE_OBJECT_MISSING: 'STORAGE_OBJECT_MISSING',

  // ─── Infrastructure ─────────────────────────────────────────────────────────
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  SERVER_ERROR: 'SERVER_ERROR',
  SERVER_UNAVAILABLE: 'SERVER_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];
