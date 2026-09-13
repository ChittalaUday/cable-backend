import type { Static } from 'typebox';
import process from 'node:process';
import { Type } from 'typebox';
import { Assert, Clean, Clone, Convert, Default, Errors } from 'typebox/value';

/**
 * The ONLY place `process.env` is read (AGENTS.md §10). Everything else imports
 * `env` from here, so a missing key fails startup rather than the first request
 * at 2am.
 *
 * Validated with TypeBox rather than @fastify/env because three entry points
 * need it — the API (`server.ts`), the worker (`worker.ts`) and the migration
 * runner — and only one of them is a Fastify instance.
 */
const EnvSchema = Type.Object({
  /**
   * Node's own flag, for libraries that switch on it. Staging runs
   * `NODE_ENV=production` so React, Fastify and friends behave as they will in
   * production — the deployment tier is `APP_ENV`, below.
   */
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('test'),
    Type.Literal('production'),
  ], { default: 'development' }),

  /**
   * The deployment tier (AGENTS.md §2.1). This, not NODE_ENV, decides whether
   * connections must be encrypted and how much an error response reveals.
   */
  APP_ENV: Type.Union([
    Type.Literal('local'),
    Type.Literal('staging'),
    Type.Literal('production'),
  ], { default: 'local' }),

  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 5050 }),
  HOST: Type.String({ default: '0.0.0.0' }),
  LOG_LEVEL: Type.Union([
    Type.Literal('fatal'),
    Type.Literal('error'),
    Type.Literal('warn'),
    Type.Literal('info'),
    Type.Literal('debug'),
    Type.Literal('trace'),
  ], { default: 'info' }),
  LOG_DIRECTORY: Type.String({ minLength: 1, default: './logs' }),
  LOG_MAX_FILE_BYTES: Type.Integer({ minimum: 1024, default: 10 * 1024 * 1024 }),
  LOG_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 30 }),
  LOG_CLEANUP_HOUR_UTC: Type.Integer({ minimum: 0, maximum: 23, default: 2 }),

  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  /**
   * `disable` locally and on staging, where the database is on the same host or
   * a private network. Production rejects `disable` at boot — see `assertTier`.
   */
  DATABASE_SSL: Type.Union([
    Type.Literal('disable'),
    Type.Literal('require'),
    Type.Literal('verify-full'),
  ], { default: 'disable' }),

  // A short secret is a broken secret, so the floor is enforced here rather than
  // documented and hoped for.
  JWT_SECRET: Type.String({ minLength: 32 }),
  ACCESS_TOKEN_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 3600, default: 900 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
  MAX_SESSIONS_PER_DEVICE: Type.Integer({ minimum: 1, maximum: 50, default: 5 }),

  /** Google OAuth client IDs accepted during sign-in. Comma separated. */
  GOOGLE_CLIENT_IDS: Type.String({ default: '' }),

  /** Comma separated. Empty outside production allows any origin. */
  CORS_ORIGINS: Type.String({ default: '' }),

  RATE_LIMIT_MAX: Type.Integer({ minimum: 1, default: 300 }),
  RATE_LIMIT_WINDOW: Type.String({ default: '1 minute' }),
  /**
   * Sign-in is the cheapest thing to attack, so it gets its own ceiling (§2).
   * Separate from RATE_LIMIT_MAX so it can be tightened during an incident
   * without throttling the whole API.
   */
  SIGN_IN_RATE_LIMIT_MAX: Type.Integer({ minimum: 1, default: 10 }),

  // ─── Messaging / OTP ───────────────────────────────────────────────────────
  // The kill switch (§1 rule 5): false falls back to the log provider, so OTPs
  // appear in the log and nothing is delivered. Flips without a deploy.
  MESSAGING_ENABLED: Type.Boolean({ default: false }),
  MESSAGING_BASE_URL: Type.String({ default: '' }),
  MESSAGING_API_KEY: Type.String({ default: '' }),
  MESSAGING_SESSION_ID: Type.String({ default: '' }),
  MESSAGING_TIMEOUT_MS: Type.Integer({ minimum: 500, maximum: 30_000, default: 8000 }),
  MESSAGING_DEFAULT_CHANNEL: Type.Union([
    Type.Literal('whatsapp'),
    Type.Literal('sms'),
  ], { default: 'whatsapp' }),

  // Firebase Admin service account JSON path.
  FIREBASE_SERVICE_ACCOUNT_PATH: Type.String({ default: '' }),

  /** Numbers are entered nationally as often as in E.164, so this fills the gap. */
  DEFAULT_COUNTRY_CODE: Type.String({ pattern: '^[0-9]{1,4}$', default: '91' }),

  OTP_LENGTH: Type.Integer({ minimum: 4, maximum: 8, default: 6 }),
  OTP_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 1800, default: 300 }),
  OTP_MAX_ATTEMPTS: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
  OTP_RESEND_COOLDOWN_SECONDS: Type.Integer({ minimum: 15, maximum: 600, default: 60 }),

  // ─── Cache (§8.5) ──────────────────────────────────────────────────────────
  CACHE_ENABLED: Type.Boolean({ default: true }),
  REDIS_URL: Type.String({ default: 'redis://127.0.0.1:6379/2' }),
  CACHE_TTL_SECONDS: Type.Integer({ minimum: 1, maximum: 86_400, default: 300 }),
  CACHE_PREFIX: Type.String({ default: 'cable:' }),

  // ─── Object storage: Cloudflare R2 (§8.4) ──────────────────────────────────
  // Unset leaves the unconfigured provider in place: every call fails naming the
  // variables it needs, rather than crashing inside the AWS SDK.
  R2_ACCOUNT_ID: Type.String({ default: '' }),
  R2_ENDPOINT: Type.String({ default: '' }),
  R2_JURISDICTION: Type.String({ default: '' }),
  R2_ACCESS_KEY_ID: Type.String({ default: '' }),
  R2_SECRET_ACCESS_KEY: Type.String({ default: '' }),
  R2_BUCKET: Type.String({ default: '' }),
  /** Custom domain in front of a public bucket, if there is one. */
  R2_PUBLIC_BASE_URL: Type.String({ default: '' }),

  UPLOAD_URL_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 3600, default: 900 }),
  DOWNLOAD_URL_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 86_400, default: 300 }),
  MAX_UPLOAD_BYTES: Type.Integer({ minimum: 1024, default: 20 * 1024 * 1024 }),
  /** Empty allows any type. An allowlist is the safer default in production. */
  ALLOWED_UPLOAD_TYPES: Type.String({ default: 'image/jpeg,image/png,image/webp,application/pdf' }),
});

export type Env = Static<typeof EnvSchema>;

function loadEnv(): Env {
  // Env values arrive as strings, so Convert runs before Assert; Clean drops the
  // hundreds of unrelated variables a shell carries.
  const shaped = Clean(EnvSchema, Default(EnvSchema, Convert(EnvSchema, Clone({ ...process.env }))));

  try {
    Assert(EnvSchema, shaped);
  }
  catch {
    const problems = [...Errors(EnvSchema, shaped)]
      .map(issue => `  ${issue.instancePath || '/'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid environment configuration:\n${problems}`);
  }

  return shaped;
}

/**
 * Production must not be reachable with the conveniences the other tiers rely
 * on. These are checked at boot, because a missing `sslmode` discovered in
 * production is discovered by the wrong person at the wrong time.
 */
function assertTier(config: Env): Env {
  if (config.APP_ENV !== 'production')
    return config;

  const problems: string[] = [];

  if (config.DATABASE_SSL === 'disable')
    problems.push('DATABASE_SSL must be "require" or "verify-full" in production');

  if (config.CORS_ORIGINS.trim() === '')
    problems.push('CORS_ORIGINS must list explicit origins in production');

  if (config.JWT_SECRET.length < 48)
    problems.push('JWT_SECRET must be at least 48 characters in production');

  if (problems.length > 0)
    throw new Error(`Production configuration rejected:\n${problems.map(p => `  ${p}`).join('\n')}`);

  return config;
}

export const env: Env = assertTier(loadEnv());

/** Deployment tier (§2.1). Prefer these over reading NODE_ENV. */
export const isProduction = env.APP_ENV === 'production';
export const isStaging = env.APP_ENV === 'staging';
export const isLocal = env.APP_ENV === 'local';

/** Node's flag, not the tier. Only for behaviour that is genuinely about tests. */
export const isTest = env.NODE_ENV === 'test';

/**
 * Whether an error response may carry the real message, stack and cause.
 *
 * Local and staging: yes — staging exists to be diagnosed from, and a generic
 * "Internal server error" there wastes the environment's whole purpose.
 * Production: no. A stack trace names file paths, library versions and query
 * fragments, and the `requestId` is how a real incident gets traced instead.
 */
export const exposeErrorDetail = !isProduction;

/** Parse a comma-separated env value into a trimmed, non-empty list. */
export function csv(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}
