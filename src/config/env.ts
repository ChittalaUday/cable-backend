import type { Static } from 'typebox';
import process from 'node:process';
import { Type } from 'typebox';
import { Assert, Clean, Clone, Convert, Default, Errors } from 'typebox/value';

export const EnvSchema = Type.Object({
  NODE_ENV: Type.Union([
    Type.Literal('development'),
    Type.Literal('test'),
    Type.Literal('production'),
  ], { default: 'development' }),

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
  /** What reaches the files on disk. The console still gets LOG_LEVEL. */
  LOG_FILE_LEVEL: Type.Union([
    Type.Literal('fatal'),
    Type.Literal('error'),
    Type.Literal('warn'),
    Type.Literal('info'),
    Type.Literal('debug'),
    Type.Literal('trace'),
  ], { default: 'error' }),
  LOG_DIRECTORY: Type.String({ minLength: 1, default: './logs' }),
  LOG_MAX_FILE_BYTES: Type.Integer({ minimum: 1024, default: 10 * 1024 * 1024 }),
  LOG_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 30 }),
  LOG_CLEANUP_CRON: Type.String({ minLength: 1, default: '0 2 * * *' }),
  STORAGE_CLEANUP_CRON: Type.String({ minLength: 1, default: '0 2 * * *' }),
  JOB_HISTORY_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 30 }),

  DATABASE_URL: Type.String({ minLength: 1 }),
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  DATABASE_SSL: Type.Union([
    Type.Literal('disable'),
    Type.Literal('require'),
    Type.Literal('verify-full'),
  ], { default: 'disable' }),

  JWT_SECRET: Type.String({ minLength: 32 }),
  ACCESS_TOKEN_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 3600, default: 900 }),
  REFRESH_TOKEN_TTL_DAYS: Type.Integer({ minimum: 1, maximum: 365, default: 30 }),
  MAX_SESSIONS_PER_DEVICE: Type.Integer({ minimum: 1, maximum: 50, default: 5 }),

  GOOGLE_CLIENT_IDS: Type.String({ default: '' }),

  CORS_ORIGINS: Type.String({ default: '' }),

  RATE_LIMIT_MAX: Type.Integer({ minimum: 1, default: 300 }),
  RATE_LIMIT_WINDOW: Type.String({ default: '1 minute' }),
  SIGN_IN_RATE_LIMIT_MAX: Type.Integer({ minimum: 1, default: 10 }),

  MESSAGING_ENABLED: Type.Boolean({ default: false }),
  MESSAGING_BASE_URL: Type.String({ default: '' }),
  MESSAGING_API_KEY: Type.String({ default: '' }),
  MESSAGING_SESSION_ID: Type.String({ default: '' }),
  MESSAGING_TIMEOUT_MS: Type.Integer({ minimum: 500, maximum: 30_000, default: 8000 }),
  MESSAGING_DEFAULT_CHANNEL: Type.Union([
    Type.Literal('whatsapp'),
    Type.Literal('sms'),
  ], { default: 'whatsapp' }),

  FIREBASE_SERVICE_ACCOUNT_PATH: Type.String({ default: '' }),

  DEFAULT_COUNTRY_CODE: Type.String({ pattern: '^[0-9]{1,4}$', default: '91' }),

  OTP_LENGTH: Type.Integer({ minimum: 4, maximum: 8, default: 6 }),
  OTP_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 1800, default: 300 }),
  OTP_MAX_ATTEMPTS: Type.Integer({ minimum: 1, maximum: 10, default: 5 }),
  OTP_RESEND_COOLDOWN_SECONDS: Type.Integer({ minimum: 15, maximum: 600, default: 60 }),

  CACHE_ENABLED: Type.Boolean({ default: true }),
  REDIS_URL: Type.String({ default: 'redis://127.0.0.1:6379/2' }),
  CACHE_TTL_SECONDS: Type.Integer({ minimum: 1, maximum: 86_400, default: 300 }),
  CACHE_PREFIX: Type.String({ default: 'cable:' }),

  R2_ACCOUNT_ID: Type.String({ default: '' }),
  R2_ENDPOINT: Type.String({ default: '' }),
  R2_JURISDICTION: Type.String({ default: '' }),
  R2_ACCESS_KEY_ID: Type.String({ default: '' }),
  R2_SECRET_ACCESS_KEY: Type.String({ default: '' }),
  R2_BUCKET: Type.String({ default: '' }),
  R2_PUBLIC_BASE_URL: Type.String({ default: '' }),

  UPLOAD_URL_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 3600, default: 900 }),
  DOWNLOAD_URL_TTL_SECONDS: Type.Integer({ minimum: 60, maximum: 86_400, default: 300 }),
  MAX_UPLOAD_BYTES: Type.Integer({ minimum: 1024, default: 20 * 1024 * 1024 }),
  ALLOWED_UPLOAD_TYPES: Type.String({ default: 'image/jpeg,image/png,image/webp,application/pdf' }),
});

export type Env = Static<typeof EnvSchema>;

function loadEnv(): Env {
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

export const isProduction = env.APP_ENV === 'production';
export const isStaging = env.APP_ENV === 'staging';
export const isLocal = env.APP_ENV === 'local';

export const isTest = env.NODE_ENV === 'test';

export const exposeErrorDetail = !isProduction;

export function csv(value: string): string[] {
  return value.split(',').map(part => part.trim()).filter(Boolean);
}
