# Stress & cache harness

Three scripts. One gives 300 customers a login, one calls every GET the API
publishes and holds a load against it with those 300 sessions, and one serves
every run so far on a dashboard.

```bash
pnpm stress:seed          # once — 300 customer logins in SSCN
pnpm stress               # 30s × 40 workers against localhost:$PORT
pnpm stress:ui            # http://127.0.0.1:5177 — every run, plus a Run button
```

Each run also writes a standalone `perf/stress-<timestamp>.html` you can open
or e-mail without the dashboard.

## Why 300 logins and not one

The response cache keys on the caller, not just the URL
(`scopeIdFor` in `plugins/cache.plugin.ts`): re-scoping a staff member has to
make their old rows unreachable. One account would therefore prove that one
cache entry is fast. 300 accounts produce 300 distinct cache entries per URL,
which is what the cache actually holds in production.

Tokens are minted in-process through `app.auth.login`, not over `/auth/login`:
sign-in is rate limited to `SIGN_IN_RATE_LIMIT_MAX` per IP per minute, and 300
logins from one box would take half an hour before the test began. Same
service the route calls, same device and session rows, no HTTP.

## Flags

| flag | default | |
|---|---|---|
| `--url=` | `http://localhost:$PORT` | target API |
| `--users=` | `300` | sessions to mint (must be ≤ what you seeded) |
| `--concurrency=` | `40` | workers holding the load |
| `--duration=` | `30` | seconds of load |
| `--sample=` | `1000` | ms between resource samples |
| `--all-endpoints` | off | put admin-only endpoints in the load too (one token, one rate-limit bucket) |
| `--no-writes` | off | skip the cache-invalidation check, which creates and deletes one package |
| `--admin=` `--admin-password=` | `admin@sscn.com` | who the sweep runs as |
| `--out=` | `perf` | report directory |

`pnpm stress:seed --count=50`, `--tenant=NCB`, `--purge` (removes every
`@loadtest.local` login).

## What the run does

1. **Mint** — one admin session plus N customer sessions.
2. **Discover** — reads `/docs/json` and builds a concrete URL for every GET,
   filling required query params from the schema and resolving `{id}` from the
   list one level up. Adds a `?q=` variant wherever the route takes one, because
   `pg_trgm` search is the expensive read here.
3. **Cold sweep** — drops every `$CACHE_PREFIX*` key, then calls each endpoint
   once. This is the only pass that calls *every* endpoint, so it doubles as a
   smoke test; non-2xx responses land in the report with their error body.
4. **Warm sweep** — the same calls again. Cold ÷ warm is the per-endpoint
   cache speedup.
5. **Invalidation check** — `GET /packages` (HIT) → `POST /packages` →
   `GET /packages` must be a MISS → `DELETE` the probe package.
6. **Load** — `--concurrency` workers round-robin over endpoints × sessions for
   `--duration` seconds. By default only endpoints a *customer* may call, so the
   load spreads over 300 rate-limit buckets instead of the admin's one;
   `--all-endpoints` includes the rest.

Throughout, every second: `/metrics` (API process CPU, RSS, heap, event-loop
lag, handles), host CPU and free memory, `redis INFO` (memory, keys, hit rate)
and `pg_stat_database` (backends, buffer hit ratio).

## Rate limits

A load test that measures the rate limiter measures nothing. `RATE_LIMIT_MAX`
keys on the Authorization header, so 300 sessions get 300 buckets — but the
admin sweep and `--all-endpoints` share one. If more than 1% of requests come
back 429 the report says so at the top. Either raise the limit in `.env`, or
run an isolated instance beside the real one:

```bash
PORT=5099 RATE_LIMIT_MAX=100000000 SIGN_IN_RATE_LIMIT_MAX=100000000 \
  CACHE_PREFIX=stress: pnpm exec tsx --env-file-if-exists=.env src/server.ts &

CACHE_PREFIX=stress: pnpm stress --url=http://localhost:5099
```

The separate `CACHE_PREFIX` matters: step 3 flushes the prefix it is told about,
and you do not want that to be the cache your dev server is using.

## The dashboard

`pnpm stress:ui` serves `perf/` at <http://127.0.0.1:5177>:

- every run in one table — throughput, p50/p95/p99, error and 429 counts, HIT
  vs MISS p95, what the cache is worth, API CPU and RSS peaks;
- how those move across runs, so a regression shows up as a step in a line
  rather than two files you have to open side by side;
- whichever endpoints failed the latest sweep, with their error bodies;
- a form that starts another run and streams its output back live.

It binds to loopback only — it spawns the runner, so it is not something to
put on an interface. The arguments it builds are numbers and one URL pattern,
passed as an array, never through a shell.

## Reading the report

`perf/stress-<timestamp>.html` (and the same data as `.json`). The number that
answers "is the cache worth it" is **cache pays** — MISS p95 ÷ HIT p95 measured
inside one run, so both numbers come from the same machine under the same load.
