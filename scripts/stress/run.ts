/**
 * Calls every GET the API publishes, twice cold and twice warm, then holds a
 * load against it with 300 distinct sessions, and writes what the API, the
 * cache, Postgres, Redis and the machine did while that happened.
 *
 *   pnpm stress:seed          # once — gives 300 customers a login
 *   pnpm stress               # 30s, 40 workers, against localhost:5050
 *   pnpm stress --duration=60 --concurrency=100 --all-endpoints
 *
 * A load test that measures the rate limiter measures nothing, so start the
 * API with the limits out of the way:
 *   RATE_LIMIT_MAX=1000000 SIGN_IN_RATE_LIMIT_MAX=1000000 pnpm dev
 */
import type { BuiltApp } from '@/app';
import { Buffer } from 'node:buffer';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';
import Redis from 'ioredis';
import pg from 'pg';
import { buildApp } from '@/app';
import { env } from '@/config/env';
import { systemAuditContext } from '@/modules/audit/audit.types';
import { renderReport } from './report';
import { arg, flag, STRESS_EMAIL_DOMAIN, STRESS_PASSWORD, stressEmail } from './shared';

const BASE_URL = arg('url', `http://localhost:${env.PORT}`).replace(/\/+$/, '');
const USERS = Number(arg('users', '300'));
const CONCURRENCY = Number(arg('concurrency', '40'));
const DURATION_MS = Number(arg('duration', '30')) * 1000;
const SAMPLE_MS = Number(arg('sample', '1000'));
const ADMIN_ID = arg('admin', 'admin@sscn.com');
const ADMIN_PASSWORD = arg('admin-password', 'Admin@123456');
const ALL_ENDPOINTS = flag('all-endpoints');
const NO_WRITES = flag('no-writes');
const OUT_DIR = path.resolve(process.cwd(), arg('out', 'perf'));

const started = new Date();
const t0 = performance.now();
const since = () => performance.now() - t0;

// ─── types ────────────────────────────────────────────────────────────────────

interface Token { label: string; role: 'admin' | 'customer'; token: string; userId: string; tenantId: string | null }
interface Endpoint { key: string; urls: string[]; customerOk: boolean; cacheable: boolean }
interface Hit { key: string; t: number; ms: number; status: number; bytes: number; cache: string; role: string }

// ─── http ─────────────────────────────────────────────────────────────────────

async function call(url: string, token: Token, init: RequestInit = {}): Promise<Hit & { body: string }> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token.token}`,
    accept: 'application/json',
    ...(token.tenantId === null ? {} : { 'x-tenant-id': token.tenantId }),
    ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(init.headers as Record<string, string> | undefined),
  };

  const at = since();
  const startedAt = performance.now();
  let status = 0;
  let body = '';
  let cache = '-';

  try {
    const response = await fetch(url, { ...init, headers });
    status = response.status;
    cache = response.headers.get('x-cache') ?? '-';
    body = await response.text();
  }
  catch (error) {
    body = error instanceof Error ? error.message : String(error);
    status = 0;
  }

  return {
    key: url,
    t: at,
    ms: performance.now() - startedAt,
    status,
    bytes: Buffer.byteLength(body),
    cache,
    role: token.role,
    body,
  };
}

async function pooled<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++)
      out[i] = await fn(items[i]!, i);
  }));

  return out;
}

// ─── tokens ───────────────────────────────────────────────────────────────────

/**
 * Minted in-process rather than over `/auth/login`: sign-in is rate limited by
 * IP at 10/minute, and 300 logins from one box would take half an hour before
 * the test began. Same service the route calls, same session rows, no HTTP.
 */
async function mintTokens(app: BuiltApp): Promise<{ admin: Token; customers: Token[] }> {
  const audit = systemAuditContext('stress-test');

  const login = async (identifier: string, password: string, index: number, role: 'admin' | 'customer'): Promise<Token> => {
    const result = await app.auth.login({
      identifier,
      password,
      device: {
        clientDeviceId: `stress-${role}-${String(index).padStart(4, '0')}`,
        platform: 'android',
        appVersion: 'stress',
        osVersion: null,
        model: 'load-generator',
      },
    }, audit);

    // The load generator drives password sign-in only. With EMAIL_OTP_ENABLED
    // set there would be no token to drive anything with, so say so plainly
    // rather than reading undefined off the answer.
    if ('status' in result)
      throw new Error('Stress runs need EMAIL_OTP_ENABLED off: login asked for an emailed code.');

    return {
      label: identifier,
      role,
      token: result.accessToken,
      userId: result.user.id,
      tenantId: result.memberships.length === 1 ? result.memberships[0]!.tenantId : null,
    };
  };

  const admin = await login(ADMIN_ID, ADMIN_PASSWORD, 0, 'admin');

  const emails = Array.from({ length: USERS }, (_, i) => stressEmail(i));
  const customers = await pooled(emails, 8, async (email, i) => login(email, STRESS_PASSWORD, i + 1, 'customer'));

  return { admin, customers };
}

// ─── discovery ────────────────────────────────────────────────────────────────

interface OpenApiParam { name: string; in: string; required?: boolean; schema?: Record<string, unknown> }

function requiredQuery(params: OpenApiParam[]): URLSearchParams {
  const qs = new URLSearchParams();

  for (const param of params) {
    if (param.in !== 'query' || param.required !== true)
      continue;

    const schema = param.schema ?? {};
    const value = schema.default
      ?? (schema.type === 'integer' || schema.type === 'number'
        ? (param.name === 'limit' ? Math.min(20, (schema.maximum as number | undefined) ?? 20) : (schema.minimum ?? 1))
        : (schema.enum as unknown[] | undefined)?.[0] ?? 'a');

    qs.set(param.name, String(value));
  }

  return qs;
}

/** Every list answers a different shape; the ids are always in the one array. */
function idsIn(raw: string, limit: number): string[] {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  }
  catch {
    return [];
  }

  const rows = Array.isArray(body)
    ? body
    : Object.values(body as Record<string, unknown>).find(v => Array.isArray(v) && typeof v[0] === 'object');

  if (!Array.isArray(rows))
    return [];

  return rows
    .map(row => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string')
    .slice(0, limit);
}

async function discover(admin: Token, customer: Token): Promise<Endpoint[]> {
  const spec = await fetch(`${BASE_URL}/docs/json`).then(async r => r.json()) as {
    paths: Record<string, Record<string, { parameters?: OpenApiParam[] }>>;
  };

  const gets = Object.entries(spec.paths)
    .filter(([path]) => path.startsWith('/api/v1/') && !path.includes('/auth/otp'))
    .flatMap(([path, methods]) => (methods.get === undefined ? [] : [{ path, params: methods.get.parameters ?? [] }]));

  // A `{id}` comes from the list one level up — /customers/{id} from /customers.
  const idsFor = new Map<string, string[]>();
  for (const { path, params } of gets) {
    if (path.includes('{id}'))
      continue;

    const response = await call(`${BASE_URL}${path}?${requiredQuery(params).toString()}`, admin);
    if (response.status === 200)
      idsFor.set(path, idsIn(response.body, 25));
  }

  const endpoints: Endpoint[] = [];

  for (const { path, params } of gets) {
    const query = requiredQuery(params);
    const suffix = query.size === 0 ? '' : `?${query.toString()}`;
    let urls: string[];

    if (path.includes('{id}')) {
      const donor = `${BASE_URL}${path.slice(0, path.indexOf('/{id}'))}`.replace(BASE_URL, '');
      const ids = idsFor.get(donor) ?? [];
      if (ids.length === 0)
        continue;

      urls = ids.map(id => `${BASE_URL}${path.replace('{id}', id)}${suffix}`);
    }
    else {
      urls = [`${BASE_URL}${path}${suffix}`];

      // Fuzzy search is the expensive read in this API; measure it separately.
      const searchable = params.find(p => p.in === 'query' && (p.name === 'q' || p.name === 'search'));
      if (searchable !== undefined) {
        const withSearch = new URLSearchParams(query);
        withSearch.set(searchable.name, 'sa');
        endpoints.push({ key: `${path}?${searchable.name}=`, urls: [`${BASE_URL}${path}?${withSearch.toString()}`], customerOk: false, cacheable: false });
      }
    }

    endpoints.push({ key: path, urls, customerOk: false, cacheable: false });
  }

  // Which of these a customer may call decides who generates the load: there
  // are 300 customer tokens and exactly one admin token behind one rate limit.
  for (const endpoint of endpoints) {
    const probe = await call(endpoint.urls[0]!, customer);
    endpoint.customerOk = probe.status >= 200 && probe.status < 300;

    const warm = await call(endpoint.urls[0]!, admin);
    endpoint.cacheable = warm.cache !== '-';
  }

  return endpoints;
}

// ─── phases ───────────────────────────────────────────────────────────────────

async function sweep(endpoints: Endpoint[], token: Token): Promise<Array<Hit & { body: string }>> {
  const hits: Array<Hit & { body: string }> = [];

  for (const endpoint of endpoints) {
    const hit = await call(endpoint.urls[0]!, token);
    hits.push({ ...hit, key: endpoint.key });
  }

  return hits;
}

async function invalidationCheck(admin: Token, redis: Redis | null): Promise<Record<string, unknown>> {
  const listUrl = `${BASE_URL}/api/v1/packages`;
  const steps: Array<{ step: string; status: number; cache: string; ms: number }> = [];
  const record = (step: string, hit: Hit) => steps.push({ step, status: hit.status, cache: hit.cache, ms: Math.round(hit.ms * 100) / 100 });

  const providers = await call(`${BASE_URL}/api/v1/service-providers`, admin);
  const providerId = idsIn(providers.body, 1)[0];
  if (providerId === undefined)
    return { ran: false, reason: 'No service provider to attach a package to.', steps };

  record('GET /packages (prime)', await call(listUrl, admin));
  record('GET /packages (expect HIT)', await call(listUrl, admin));

  const suffix = Date.now().toString(36);
  const created = await call(`${BASE_URL}/api/v1/packages`, admin, {
    method: 'POST',
    body: JSON.stringify({ serviceProviderId: providerId, name: `Stress Probe ${suffix}`, slug: `stress-probe-${suffix}`, price: '1.00' }),
  });
  record('POST /packages (invalidates)', created);

  const afterWrite = await call(listUrl, admin);
  record('GET /packages (expect MISS)', afterWrite);

  const createdId = idsIn(`[${created.body}]`, 1)[0] ?? (JSON.parse(created.body || '{}') as { id?: string }).id;
  if (createdId !== undefined)
    record('DELETE /packages/:id (cleanup)', await call(`${BASE_URL}/api/v1/packages/${createdId}`, admin, { method: 'DELETE' }));

  const keys = redis === null ? null : (await redis.keys(`${env.CACHE_PREFIX}*`)).length;

  return {
    ran: true,
    passed: steps[1]?.cache === 'HIT' && steps[3]?.cache === 'MISS',
    cacheKeysAfter: keys,
    steps,
  };
}

async function stress(endpoints: Endpoint[], admin: Token, customers: Token[]): Promise<Hit[]> {
  const pool = endpoints.flatMap((endpoint) => {
    if (!endpoint.customerOk && !ALL_ENDPOINTS)
      return [];

    const tokens = endpoint.customerOk ? customers : [admin];
    return [{ endpoint, tokens }];
  });

  if (pool.length === 0)
    throw new Error('Nothing to stress — no endpoint answered 2xx for a customer. Try --all-endpoints.');

  const hits: Hit[] = [];
  const deadline = performance.now() + DURATION_MS;
  let cursor = 0;

  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (performance.now() < deadline) {
      const n = cursor++;
      const { endpoint, tokens } = pool[n % pool.length]!;
      const url = endpoint.urls[n % endpoint.urls.length]!;
      const token = tokens[n % tokens.length]!;

      const hit = await call(url, token);
      hits.push({ ...hit, key: endpoint.key, body: undefined } as Hit);
    }
  }));

  return hits;
}

// ─── sampling ─────────────────────────────────────────────────────────────────

function promValue(text: string, name: string): number | null {
  const match = new RegExp(`^${name}(?:\\{[^}]*\\})? ([0-9.e+-]+)$`, 'm').exec(text);
  return match === null ? null : Number(match[1]);
}

function hostCpuTimes() {
  return os.cpus().reduce((acc, cpu) => {
    const total = Object.values(cpu.times).reduce((a, b) => a + b, 0);
    return { idle: acc.idle + cpu.times.idle, total: acc.total + total };
  }, { idle: 0, total: 0 });
}

const nullableMb = (v: number | null) => (v === null ? null : v / 1024 / 1024);
const mapNull = (v: number | null, fn: (n: number) => number) => (v === null ? null : fn(v));

interface ResourceSample {
  t: number;
  apiCpuPct: number | null;
  apiRssMb: number | null;
  apiHeapMb: number | null;
  eventLoopLagMs: number | null;
  apiHandles: number | null;
  hostCpuPct: number;
  hostFreeMb: number;
  hostLoad1: number;
  redisMemMb: number | null;
  redisKeys: number | null;
  redisHitRatePct: number | null;
  pgBackends: number | null;
  pgCacheHitPct: number | null;
}

function startSampler(admin: Token, pool: pg.Pool, redis: Redis | null) {
  const samples: ResourceSample[] = [];
  let lastCpu: { seconds: number; at: number } | null = null;
  let lastHost = hostCpuTimes();

  const tick = async () => {
    const at = performance.now();

    const [metrics, redisInfo, pgRow] = await Promise.all([
      fetch(`${BASE_URL}/metrics`, { headers: { authorization: `Bearer ${admin.token}` } })
        .then(async r => (r.ok ? r.text() : ''))
        .catch(() => ''),
      redis === null ? Promise.resolve('') : redis.info().catch(() => ''),
      pool.query(`select numbackends, blks_hit, blks_read from pg_stat_database where datname = current_database()`)
        .then(r => r.rows[0] as { numbackends: number; blks_hit: string; blks_read: string } | undefined)
        .catch(() => undefined),
    ]);

    const cpuSeconds = promValue(metrics, 'process_cpu_seconds_total');
    let apiCpuPct: number | null = null;
    if (cpuSeconds !== null) {
      if (lastCpu !== null && at > lastCpu.at)
        apiCpuPct = ((cpuSeconds - lastCpu.seconds) / ((at - lastCpu.at) / 1000)) * 100;

      lastCpu = { seconds: cpuSeconds, at };
    }

    const host = hostCpuTimes();
    const hostIdle = host.idle - lastHost.idle;
    const hostTotal = host.total - lastHost.total;
    lastHost = host;

    const infoNumber = (key: string) => {
      const match = new RegExp(`^${key}:(.+)$`, 'm').exec(redisInfo);
      return match === null ? null : Number(match[1]!.trim());
    };

    const keyspace = /^db\d+:keys=(\d+)/m.exec(redisInfo);
    const redisHits = infoNumber('keyspace_hits');
    const redisMisses = infoNumber('keyspace_misses');
    const blksHit = pgRow === undefined ? null : Number(pgRow.blks_hit);
    const blksRead = pgRow === undefined ? null : Number(pgRow.blks_read);

    samples.push({
      t: since(),
      apiCpuPct,
      apiRssMb: nullableMb(promValue(metrics, 'process_resident_memory_bytes')),
      apiHeapMb: nullableMb(promValue(metrics, 'nodejs_heap_size_used_bytes')),
      eventLoopLagMs: mapNull(promValue(metrics, 'nodejs_eventloop_lag_mean_seconds'), v => v * 1000),
      apiHandles: promValue(metrics, 'nodejs_active_handles_total'),
      hostCpuPct: hostTotal === 0 ? 0 : (1 - hostIdle / hostTotal) * 100,
      hostFreeMb: os.freemem() / 1024 / 1024,
      hostLoad1: os.loadavg()[0] ?? 0,
      redisMemMb: nullableMb(infoNumber('used_memory')),
      redisKeys: keyspace === null ? 0 : Number(keyspace[1]),
      redisHitRatePct: redisHits === null || redisMisses === null || redisHits + redisMisses === 0
        ? null
        : (redisHits / (redisHits + redisMisses)) * 100,
      pgBackends: pgRow?.numbackends ?? null,
      pgCacheHitPct: blksHit === null || blksRead === null || blksHit + blksRead === 0
        ? null
        : (blksHit / (blksHit + blksRead)) * 100,
    });
  };

  const timer = setInterval(() => {
    void tick().catch(() => {});
  }, SAMPLE_MS);

  return {
    samples,
    stop: async () => {
      clearInterval(timer);
      await tick().catch(() => {});
    },
  };
}

// ─── stats ────────────────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0)
    return 0;

  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

function latency(hits: Hit[]) {
  const sorted = hits.map(h => h.ms).sort((a, b) => a - b);
  return {
    count: hits.length,
    min: sorted[0] ?? 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.at(-1) ?? 0,
    mean: sorted.length === 0 ? 0 : sorted.reduce((a, b) => a + b, 0) / sorted.length,
  };
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket === undefined)
      out.set(k, [item]);
    else
      bucket.push(item);
  }
  return out;
}

const ok = (h: Hit) => h.status >= 200 && h.status < 400;

function failureOf(body: string): string {
  try {
    const parsed = JSON.parse(body) as { code?: string; message?: string; details?: unknown };
    const detail = parsed.details === undefined ? '' : ` ${JSON.stringify(parsed.details)}`;
    return `${parsed.code ?? ''} ${parsed.message ?? ''}${detail}`.trim().slice(0, 300);
  }
  catch {
    return body.slice(0, 300);
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

const app = await buildApp();
console.log(`🔑 Minting ${USERS + 1} sessions…`);
const { admin, customers } = await mintTokens(app);
await app.close();

console.log(`🔎 Discovering endpoints from ${BASE_URL}/docs/json …`);
const endpoints = await discover(admin, customers[0]!);
console.log(`   ${endpoints.length} GET endpoints, ${endpoints.filter(e => e.customerOk).length} callable by a customer, ${endpoints.filter(e => e.cacheable).length} cached`);

const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 2 });
const redis = env.CACHE_ENABLED ? new Redis(env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 }) : null;
await redis?.connect().catch(() => console.warn('⚠️  Redis unreachable — cache figures will be blank.'));

const sampler = startSampler(admin, pool, redis);

const flushed = redis === null
  ? 0
  : await redis.keys(`${env.CACHE_PREFIX}*`).then(async (keys) => {
      if (keys.length > 0)
        await redis.del(keys);
      return keys.length;
    });
console.log(`🧊 Cold pass (dropped ${flushed} cache key(s))…`);
const cold = await sweep(endpoints, admin);

console.log('🔥 Warm pass…');
const warm = await sweep(endpoints, admin);

const invalidation = NO_WRITES
  ? { ran: false, reason: '--no-writes' }
  : await invalidationCheck(admin, redis).catch(error => ({ ran: false, reason: String(error) }));

console.log(`🚀 Load: ${CONCURRENCY} workers × ${DURATION_MS / 1000}s across ${customers.length} sessions…`);
const stressStart = since();
const hits = await stress(endpoints, admin, customers);
const stressEnd = since();

await sampler.stop();

// ─── assemble ─────────────────────────────────────────────────────────────────

const [pgVersion, dataset] = await Promise.all([
  pool.query('select version() as v, current_setting(\'server_version\') as short').then(r => r.rows[0] as { v: string; short: string }),
  pool.query(`select
      (select count(*) from crm.customers where deleted_at is null) customers,
      (select count(*) from crm.subscriptions where deleted_at is null) subscriptions,
      (select count(*) from crm.packages where deleted_at is null) packages,
      (select count(*) from geo.locations) locations,
      (select count(*) from auth.users) users,
      (select count(*) from auth.users where email like $1) load_test_users,
      pg_size_pretty(pg_database_size(current_database())) db_size`, [`%@${STRESS_EMAIL_DOMAIN}`])
    .then(r => r.rows[0] as Record<string, string>),
]);

const redisInfo = redis === null ? '' : await redis.info().catch(() => '');
const redisVersion = /^redis_version:(.+)$/m.exec(redisInfo)?.[1]?.trim() ?? null;
const metricsText = await fetch(`${BASE_URL}/metrics`, { headers: { authorization: `Bearer ${admin.token}` } })
  .then(async r => (r.ok ? r.text() : ''))
  .catch(() => '');

const rateLimitProbe = await fetch(`${BASE_URL}/api/v1/health`).then(r => r.headers.get('ratelimit-limit')).catch(() => null);

const durationSec = (stressEnd - stressStart) / 1000;
const byCacheHits = groupBy(hits.filter(ok), h => h.cache);
const coldByKey = new Map(cold.map(h => [h.key, h]));

const report = {
  meta: {
    startedAt: started.toISOString(),
    finishedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    sessions: customers.length,
    concurrency: CONCURRENCY,
    durationSeconds: Math.round(durationSec * 10) / 10,
    endpointsCalled: endpoints.length,
    stressScope: ALL_ENDPOINTS ? 'every endpoint' : 'customer-callable endpoints',
    cacheEnabled: env.CACHE_ENABLED,
    cacheTtlSeconds: env.CACHE_TTL_SECONDS,
    cachePrefix: env.CACHE_PREFIX,
    rateLimitPerMinute: rateLimitProbe === null ? null : Number(rateLimitProbe),
    cacheKeysFlushedBeforeCold: flushed,
  },
  system: {
    host: {
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
      cpu: os.cpus()[0]?.model ?? 'unknown',
      cores: os.cpus().length,
      totalMemoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
      loadGeneratorNode: process.version,
      note: 'The load generator shares this machine with the API — host CPU covers both.',
    },
    api: {
      url: BASE_URL,
      nodeVersion: /nodejs_version_info\{[^}]*version="([^"]+)"/.exec(metricsText)?.[1] ?? null,
      rssMbAtEnd: nullableMb(promValue(metricsText, 'process_resident_memory_bytes')),
      heapMbAtEnd: nullableMb(promValue(metricsText, 'nodejs_heap_size_used_bytes')),
      cpuSecondsTotal: promValue(metricsText, 'process_cpu_seconds_total'),
      dbPoolMax: env.DATABASE_POOL_MAX,
    },
    postgres: { version: pgVersion?.short ?? null, banner: pgVersion?.v ?? null },
    redis: { enabled: env.CACHE_ENABLED, version: redisVersion, url: env.REDIS_URL.replace(/\/\/.*@/, '//***@') },
    dataset,
  },
  cachePasses: endpoints.map((endpoint) => {
    const coldHit = coldByKey.get(endpoint.key);
    const warmHit = warm.find(h => h.key === endpoint.key);
    return {
      key: endpoint.key,
      cacheable: endpoint.cacheable,
      customerOk: endpoint.customerOk,
      coldMs: coldHit?.ms ?? null,
      warmMs: warmHit?.ms ?? null,
      coldCache: coldHit?.cache ?? '-',
      warmCache: warmHit?.cache ?? '-',
      status: coldHit?.status ?? 0,
      bytes: coldHit?.bytes ?? 0,
      // A 500 on a sweep is the whole point of sweeping; carry the reason.
      error: coldHit !== undefined && coldHit.status >= 400 ? failureOf(coldHit.body) : null,
      speedup: coldHit !== undefined && warmHit !== undefined && warmHit.ms > 0 ? coldHit.ms / warmHit.ms : null,
    };
  }),
  invalidation,
  stress: {
    totalRequests: hits.length,
    durationSeconds: Math.round(durationSec * 10) / 10,
    rps: hits.length / durationSec,
    bytes: hits.reduce((a, h) => a + h.bytes, 0),
    errorRate: hits.length === 0 ? 0 : (hits.filter(h => !ok(h)).length / hits.length) * 100,
    rateLimited: hits.filter(h => h.status === 429).length,
    latency: latency(hits.filter(ok)),
    byCache: Object.fromEntries([...byCacheHits].map(([k, v]) => [k, latency(v)])),
    byStatus: Object.fromEntries([...groupBy(hits, h => String(h.status))].map(([k, v]) => [k, v.length])),
    byEndpoint: [...groupBy(hits, h => h.key)].map(([key, group]) => ({
      key,
      errors: group.filter(h => !ok(h)).length,
      hitRatePct: (group.filter(h => h.cache === 'HIT').length / group.length) * 100,
      avgBytes: group.reduce((a, h) => a + h.bytes, 0) / group.length,
      ...latency(group.filter(ok)),
      count: group.length,
    })).sort((a, b) => b.p95 - a.p95),
    errors: [...groupBy(hits.filter(h => !ok(h)), h => `${h.status} ${h.key}`)]
      .map(([label, group]) => ({ label, count: group.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20),
  },
  timeline: (() => {
    const bucketMs = SAMPLE_MS;
    const throughput = new Map<number, number[]>();
    for (const hit of hits) {
      const bucket = Math.floor(hit.t / bucketMs);
      (throughput.get(bucket) ?? throughput.set(bucket, []).get(bucket)!).push(hit.ms);
    }

    return sampler.samples.map((sample) => {
      const bucket = Math.floor(sample.t / bucketMs);
      const window = (throughput.get(bucket) ?? []).sort((a, b) => a - b);
      return {
        ...sample,
        rps: window.length / (bucketMs / 1000),
        p95: percentile(window, 95),
      };
    });
  })(),
};

await fs.mkdir(OUT_DIR, { recursive: true });
const stamp = started.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const jsonPath = path.join(OUT_DIR, `stress-${stamp}.json`);
const htmlPath = path.join(OUT_DIR, `stress-${stamp}.html`);

await fs.writeFile(jsonPath, JSON.stringify(report, null, 2));
await fs.writeFile(htmlPath, renderReport(report));

await redis?.quit().catch(() => redis.disconnect());
await pool.end();

const { stress: s } = report;
console.log('');
console.log(`   requests   ${s.totalRequests} in ${s.durationSeconds}s → ${s.rps.toFixed(1)} req/s`);
console.log(`   latency    p50 ${s.latency.p50.toFixed(1)}ms · p95 ${s.latency.p95.toFixed(1)}ms · p99 ${s.latency.p99.toFixed(1)}ms`);
console.log(`   errors     ${s.errorRate.toFixed(2)}%${s.rateLimited > 0 ? ` (${s.rateLimited} rate-limited)` : ''}`);
if (s.byCache.HIT !== undefined && s.byCache.MISS !== undefined)
  console.log(`   cache      HIT p95 ${s.byCache.HIT.p95.toFixed(1)}ms vs MISS p95 ${s.byCache.MISS.p95.toFixed(1)}ms`);
console.log('');
console.log(`📄 ${htmlPath}`);
console.log(`📦 ${jsonPath}`);

if (s.rateLimited > hits.length * 0.01) {
  console.log('');
  console.log('⚠️  The rate limiter shaped this run. Restart the API without it and re-run:');
  console.log('    RATE_LIMIT_MAX=1000000 SIGN_IN_RATE_LIMIT_MAX=1000000 pnpm dev');
}

export type StressReport = typeof report;
