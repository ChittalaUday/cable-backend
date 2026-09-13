import type { Static } from '@sinclair/typebox';
import process from 'node:process';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('test'),
    Type.Literal('production'),
  ], { default: 'development' }),

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

  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),

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

  /** Numbers are entered nationally as often as in E.164, so this fills the gap. */
  DEFAULT_COUNTRY_CODE: Type.String({ pattern: '^[0-9]{1,4}$', default: '91' }),

  OTP_LENGTH: Type.Integer({ minimum: 4, maximum: 8, default: 6 }),
  OTP_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 1800, default: 300 }),
  OTP_MAX_ATTEMPTS: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
  OTP_RESEND_COOLDOWN_SECONDS: Type.Integer({ minimum: 15, maximum: 600, default: 60 }),
});

export type Env = Static<typeof EnvSchema>;

function loadEnv(): Env {
  try {
    return Value.Parse(['Clone', 'Clean', 'Default', 'Convert', 'Assert'], EnvSchema, process.env) as Env;
  }
  catch {
    const problems = [...Value.Errors(EnvSchema, Value.Default(EnvSchema, { ...process.env }))]
      .map(e => `  ${e.path || '/'}: ${e.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
}

export const env: Env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Parse a comma-separated env value into a trimmed, non-empty list. */
export function csv(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}
