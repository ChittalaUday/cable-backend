import type { BuiltApp } from '@/app';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { env, isProduction } from '@/config/env';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface PreflightResult {
  checks: Check[];
  failed: boolean;
}

const REQUIRED_SCHEMAS = ['tenancy', 'auth', 'iam', 'crm', 'geo', 'notify', 'media', 'analytics', 'audit', 'inventory'];
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

const ok = (name: string, detail: string): Check => ({ name, status: 'ok', detail });
const warn = (name: string, detail: string): Check => ({ name, status: 'warn', detail });
const fail = (name: string, detail: string): Check => ({ name, status: 'fail', detail });

function degraded(name: string, detail: string): Check {
  return isProduction ? fail(name, detail) : warn(name, detail);
}

export async function runPreflight(app: BuiltApp): Promise<PreflightResult> {
  const checks: Check[] = [
    tierCheck(),
    jwtCheck(),
    ...await databaseChecks(app),
    await cacheCheck(app),
    ...await messagingChecks(app),
    await firebaseCheck(app),
    await storageCheck(app),
  ];

  return { checks, failed: checks.some(check => check.status === 'fail') };
}

function tierCheck(): Check {
  const name = 'environment';
  const detail = `APP_ENV=${env.APP_ENV} NODE_ENV=${env.NODE_ENV}`;

  if (env.APP_ENV !== 'local' && env.NODE_ENV !== 'production') {
    return warn(name, `${detail} — staging and production should run NODE_ENV=production so libraries behave as they will in production`);
  }

  return ok(name, detail);
}

function jwtCheck(): Check {
  const name = 'jwt secret';

  if (env.JWT_SECRET.includes('change-me') || env.JWT_SECRET.startsWith('test-secret'))
    return fail(name, 'still set to an example value');

  if (env.JWT_SECRET.length < 48)
    return degraded(name, `${env.JWT_SECRET.length} characters; 48+ recommended`);

  return ok(name, `${env.JWT_SECRET.length} characters`);
}

async function databaseChecks(app: BuiltApp): Promise<Check[]> {
  const checks: Check[] = [];

  try {
    await app.db.execute(sql`select 1`);
    checks.push(ok('database', `connected, ssl=${env.DATABASE_SSL}`));
  }
  catch (error) {
    return [fail('database', message(error))];
  }

  try {
    const found = await app.db.execute<{ nspname: string }>(sql`SELECT nspname FROM pg_namespace`);
    const present = new Set(found.rows.map(row => row.nspname));
    const missing = REQUIRED_SCHEMAS.filter(schema => !present.has(schema));

    checks.push(missing.length === 0
      ? ok('database schemas', `${REQUIRED_SCHEMAS.length} present`)
      : fail('database schemas', `missing: ${missing.join(', ')} — run pnpm db:migrate`));
  }
  catch (error) {
    checks.push(fail('database schemas', message(error)));
  }

  checks.push(await migrationsCheck(app));
  return checks;
}

async function migrationsCheck(app: BuiltApp): Promise<Check> {
  const name = 'migrations';

  try {
    const journal = JSON.parse(
      await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
    ) as { entries: { tag: string }[] };

    const applied = await app.db.execute<{ count: string }>(
      sql`SELECT count(*)::text AS count FROM drizzle.__drizzle_migrations`,
    );

    const expected = journal.entries.length;
    const actual = Number(applied.rows[0]?.count ?? 0);

    if (actual < expected)
      return fail(name, `${actual}/${expected} applied — run pnpm db:migrate`);

    if (actual > expected)
      return warn(name, `${actual} applied but only ${expected} on disk — this build is older than the database`);

    return ok(name, `${actual}/${expected} applied`);
  }
  catch (error) {
    if ((error as { cause?: { code?: string } }).cause?.code === '42P01')
      return fail(name, 'none applied — run pnpm db:migrate');

    return fail(name, message(error));
  }
}

async function cacheCheck(app: BuiltApp): Promise<Check> {
  const name = 'cache';

  if (!env.CACHE_ENABLED)
    return degraded(name, 'disabled — every read hits Postgres');

  try {
    await app.cache.ping();
    return ok(name, `redis reachable, ttl=${env.CACHE_TTL_SECONDS}s prefix="${env.CACHE_PREFIX}"`);
  }
  catch (error) {
    return degraded(name, `redis unreachable: ${message(error)}`);
  }
}

async function messagingChecks(app: BuiltApp): Promise<Check[]> {
  const name = 'messaging';

  if (!env.MESSAGING_ENABLED)
    return [degraded(name, 'disabled — OTPs are written to the log, not delivered')];

  const missing = (['MESSAGING_BASE_URL', 'MESSAGING_API_KEY', 'MESSAGING_SESSION_ID'] as const)
    .filter(key => env[key] === '');

  if (missing.length > 0)
    return [fail(name, `enabled but unset: ${missing.join(', ')}`)];

  const channels = app.messaging.knownChannels
    .map(channel => `${channel}${app.messaging.supports(channel) ? '' : '(placeholder)'}`)
    .join(' ');

  try {
    const res = await fetch(`${env.MESSAGING_BASE_URL}/api/sessions/${env.MESSAGING_SESSION_ID}`, {
      headers: { 'x-api-key': env.MESSAGING_API_KEY },
      signal: AbortSignal.timeout(3000),
    });

    if (res.status === 401 || res.status === 403)
      return [degraded(name, `OpenWA rejected API key (HTTP ${res.status})`)];

    if (!res.ok)
      return [degraded(name, `OpenWA session check returned HTTP ${res.status}`)];

    const data = await res.json() as { status?: string; phone?: string };
    if (data.status !== undefined && data.status !== 'ready')
      return [warn(name, `OpenWA session status is '${data.status}' — requires attention · ${channels}`)];

    const phoneStr = data.phone !== undefined && data.phone !== '' ? ` (${data.phone})` : '';
    return [ok(name, `openwa connected${phoneStr} · ${channels}`)];
  }
  catch (error) {
    return [degraded(name, `OpenWA unreachable at ${env.MESSAGING_BASE_URL}: ${message(error)}`)];
  }
}

async function firebaseCheck(app: BuiltApp): Promise<Check> {
  const name = 'firebase';

  if (!app.firebase)
    return degraded(name, 'not configured — Firebase services are unavailable');

  try {
    const credential = app.firebase.app.options.credential as { getAccessToken?: () => Promise<unknown> } | undefined;
    if (credential?.getAccessToken)
      await credential.getAccessToken();

    return ok(name, `Admin SDK verified for ${app.firebase.projectId}`);
  }
  catch (error) {
    return degraded(name, `configured for ${app.firebase.projectId} but credential check failed: ${message(error)}`);
  }
}

async function storageCheck(app: BuiltApp): Promise<Check> {
  const name = 'object storage';

  if (!app.storage.configured)
    return degraded(name, 'not configured — file endpoints return 503');

  try {
    await app.storage.ping();
    return ok(name, `bucket "${app.storage.bucket}" connected, max ${Math.round(env.MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
  }
  catch (error) {
    return degraded(name, `configured for "${app.storage.bucket}" but unreachable: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

export function reportPreflight(app: BuiltApp, result: PreflightResult): void {
  const width = Math.max(...result.checks.map(check => check.name.length));

  for (const check of result.checks) {
    const line = `${ICON[check.status]} ${check.name.padEnd(width)}  ${check.detail}`;
    if (check.status === 'fail')
      app.log.error(line);
    else if (check.status === 'warn')
      app.log.warn(line);
    else
      app.log.info(line);
  }
}
