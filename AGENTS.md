> Satya Cable & Broadband backend API. Multi-tenant CRUD service for the mobile app.

**This document is the contract.** Every change to this repo — human or agent — follows it.
If a rule here blocks you, change the rule in a PR first; do not work around it.

---

## 1. Scope: what ships now, what is deferred

This is a **modular monolith**. One deployable, one codebase, hard internal
boundaries. It is not microservices, and splitting it is not a goal.

**Phase 1 — what is actually built now.** Tenant-scoped CRUD and the auth that
protects it: `auth`, `tenants`, `users`, `roles`, `permissions`, `devices`,
`customers`, `services`, `packages`, `connections`, plus read aggregation for
dashboards.

Phase 1 talks to Postgres and to exactly two outbound endpoints, both required
by sign-in and both synchronous by nature: **Google** (ID-token verification)
and the **self-hosted messaging server** (OTP delivery). Nothing else.

**Deferred — reserved home, not built yet.** Each of these has a place to land
so nobody improvises one later:

| Capability | Lands in | Phase |
|---|---|---|
| Redis cache | `plugins/redis.ts` | when a measured query is actually hot |
| BullMQ queue + worker | `jobs/`, `src/worker.ts` | with billing |
| Billing, invoices, payments, collections | `modules/billing`, `invoices`, `payments`, `collections` | 2 |
| Tickets | `modules/tickets` | 2 |
| Inventory | `modules/inventory` | 2 |
| File storage (R2/S3) | `plugins/storage.ts` | 3 |
| SMS provider | a second `MessagingProvider` in `modules/notifications` | when a gateway is chosen |
| Email (incl. email OTP) | `modules/notifications` behind a provider interface | when a provider is chosen |
| Push (FCM) | `modules/notifications` | 3 |
| Excel / CSV export | `modules/reports` | 3 |
| SSE realtime | `modules/notifications` | 3 |
| Sentry, Prometheus | `plugins/` | with production traffic |

**Every deferred integration obeys these five rules when it lands.** They are
written now, before anyone is under deadline pressure to skip them:

1. **One file knows the vendor.** R2, FCM, the email provider and Sentry sit
   behind an interface in `shared/` or a plugin. Swapping a provider is one
   file, and a test can substitute a fake without a network.
2. **Never on the request path of a write.** A CRUD write does not wait on S3,
   FCM or an SMTP server. It commits, then enqueues. The unavoidable exceptions
   are both at sign-in: Google ID-token verification, and OTP delivery — an OTP
   the caller is told was sent must actually have been sent, so it cannot be
   enqueued and forgotten.
3. **Fails closed and loudly.** An integration that errors raises and is logged
   with the `requestId`. It never silently degrades a write into a partial
   success — a payment that recorded but never notified must be visible as
   exactly that.
4. **Credentials come from `config/env.ts`**, validated at boot. A missing key
   fails startup, not the first request at 2am.
5. **It has a kill switch.** An env flag disables it without a deploy, because
   the first thing you want when a provider is down is to turn it off.

**Still out of scope entirely:** server-rendered HTML (this service returns
JSON), and any second datastore that duplicates Postgres as a source of truth.
Search is `pg_trgm` in Postgres, not a search cluster.

---

## 2. Technology stack

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Node.js 24 LTS**, ESM | — |
| Language | TypeScript, strict | — |
| Framework | **Fastify 5** | Schema-first, fastest serializer |
| Architecture | **Modular monolith** | §3 |
| Package manager | **pnpm** | Same as the app repo |
| Database | **PostgreSQL 18** | — |
| ORM | **Drizzle ORM** + Drizzle Kit | Migrations are readable SQL, no codegen step |
| Validation | **TypeBox → JSON Schema** | Fastify's *native* validator/serializer compiles it directly; OpenAPI for free |
| Auth | JWT access + rotating refresh token | §4.3, §4.6 |
| Password hashing | **Argon2id** | Use `@node-rs/argon2` — prebuilt Rust binding, **no node-gyp in the image**. Not the `argon2` package. |
| Authorization | RBAC + permissions + scopes | §5 |
| Multi-tenancy | `tenant_id` everywhere; Postgres RLS later as a backstop | §4.5 |
| Logging | **Pino** (built into Fastify) | — |
| Docs | OpenAPI + Swagger UI | Generated from route schemas, never hand-written |
| Money | Postgres `NUMERIC` + **decimal.js** | §8 |
| Search | **Postgres + `pg_trgm`** | No search cluster |
| Testing | **Vitest** + Fastify `inject()` + **Testcontainers** | §10 |
| Migrations | Drizzle Kit | §8 |
| API versioning | `/api/v1` | §6 |
| Deployment | Docker Compose + Nginx | Multi-stage build, non-root user |
| Background work | Separate **worker process, same codebase** | `src/worker.ts`, `jobs/` |

### Fastify plugins — use these, do not reimplement them

| Plugin | Use it for | Never hand-roll |
|---|---|---|
| `@fastify/autoload` | Registering `plugins/` and `modules/**/*.routes.ts` | A manual `registerRoutes()` barrel |
| `@fastify/sensible` | `httpErrors.notFound()`, `badRequest()`, … | Custom `AppError` class hierarchies |
| `@fastify/helmet` | Security headers | — |
| `@fastify/cors` | CORS, explicit origin allowlist | `origin: true` in production |
| `@fastify/rate-limit` | Global + per-route limits | — |
| `@fastify/jwt` | Sign/verify access tokens | `jsonwebtoken` directly |
| `@fastify/swagger` + `-ui` | OpenAPI generated from route schemas | A hand-maintained `openapi.yaml` |
| `@fastify/under-pressure` | `/health` with real load signals | `reply.send({ ok: true })` |
| `fastify-plugin` | Un-encapsulating a plugin so decorators are global | — |
| `close-with-grace` | Graceful shutdown: drain, then close the pool | `process.on('SIGTERM')` by hand |

**Env is validated in `config/env.ts` with TypeBox**, not `@fastify/env`.
Three entry points need configuration — the API, the worker, and the migration
runner — and only one of them is a Fastify instance. One TypeBox schema parsed
at import serves all three; a Fastify plugin would serve one and leave the other
two reading `process.env` raw.

**Rule:** before adding any dependency, check whether Fastify, Drizzle, or
`node:` stdlib already does it. Most of the time one of them does.

---

## 3. Architecture: modular monolith, route → controller → service

Three layers inside each module. Each has exactly one job, and a layer may only
call the layer directly beneath it.

```
  HTTP  ─▶  route  ─▶  controller  ─▶  service  ─▶  Postgres
            │           │              │
            │           │              └─ Business rules, transactions, AND the Drizzle queries.
            │           │                 SQL lives ONLY in services.
            │           └─ Unwraps the request, calls one service, maps the result to a status code.
            └─ Method, path, TypeBox schema, auth/RBAC hooks. No logic.
```

**route** — declaration only: `method`, `url`, `schema`, `preHandler`, `handler`.
The handler references a controller function, never an inline body.

**controller** — the *only* layer that touches `request` and `reply`. Pulls
`params`/`query`/`body`/`user`/`tenantId` off the request, calls one service
method, returns the value. No branching on business state. **No database
access** — a controller importing `db/` breaks the layer boundary, and the
linter rejects it (§10).

**service** — the business layer. Owns the Drizzle queries, transactions,
invariants, authorization decisions, and cross-resource orchestration.
**Framework-free**: never imports `fastify`, never sees a `request`, never
throws an HTTP error — it throws domain errors the error handler maps (§7).
That constraint is what keeps a service testable without booting a server, and
it is why the layer is worth having.

There is deliberately **no repository layer**. Drizzle's query builder is
already the data-access abstraction; wrapping it in another one that forwards
arguments and forwards rows back buys an indirection nobody reads. The rules a
repository would enforce — tenant scoping, SQL in one place — are enforced on
services instead (§4.5, §10).

### Module boundaries — the part that makes it a monolith and not a mud ball

- **A module owns its tables.** `customers.service.ts` is the only code that
  writes `customers`.
- **Cross-module access goes through the other module's service**, imported
  from its `index.ts`. Never reach into another module's internals, and never
  join across a module boundary in raw SQL just because both tables are in the
  same database. That shortcut is exactly how a modular monolith stops being
  modular, and the linter blocks it.
- **A module that needs three other modules' services** is a sign the logic
  belongs in a new module, not that the rule should bend.

### Layout

```
src/
├── server.ts                     # Process entry: build, listen, close-with-grace. Nothing else.
├── app.ts                        # buildApp() → FastifyInstance. Used by server.ts AND by tests.
├── worker.ts                     # Worker process entry (deferred, §1). Same codebase, no HTTP.
│
├── config/
│   ├── env.ts                    # @fastify/env JSON Schema + typed `env` export
│   └── constants.ts              # App-wide constants (limits, TTLs, defaults)
│
├── plugins/                      # Autoloaded, fastify-plugin wrapped, order-independent
│   ├── database.ts               # Decorates `app.db` (Drizzle) + pool lifecycle
│   ├── auth.ts                   # @fastify/jwt + `app.authenticate` + session checks
│   ├── tenant.ts                 # `app.resolveTenant` — validates active tenant vs membership
│   ├── rbac.ts                   # `app.requirePermission(key, scope?)` hook factory
│   ├── security.ts               # helmet, cors, rate-limit
│   ├── swagger.ts                # OpenAPI + /docs
│   ├── error-handler.ts          # setErrorHandler / setNotFoundHandler
│   ├── redis.ts                  # deferred (§1)
│   └── storage.ts                # deferred (§1)
│
├── modules/                      # Autoloaded: modules/**/*.routes.ts
│   ├── auth/  tenants/  users/  roles/  permissions/  devices/       ← phase 1
│   ├── customers/  services/  packages/  connections/                ← phase 1
│   ├── audit/                                                        ← phase 1
│   ├── inventory/  billing/  invoices/  payments/  collections/      ← phase 2
│   ├── tickets/                                                      ← phase 2
│   └── notifications/  reports/                                      ← phase 3
│
├── db/
│   ├── schema/                   # Drizzle tables, one file per table
│   │   └── schemas.ts            # The PostgreSQL namespaces (§8.2)
│   ├── migrations/               # Generated SQL — committed, never edited after merge
│   └── seed/                     # Idempotent seeders + the Firestore import (§9)
│
├── shared/                       # Cross-module ONLY
│   ├── errors/                   # DomainError, the error-code catalogue (§7.1)
│   ├── security/                 # argon2id hashing, token helpers, permission keys, scopes
│   ├── pagination/               # Shared pagination schema + helpers
│   ├── types/                    # Cross-module types
│   └── utils/                    # dates, strings, tenant-code.ts (§8.1)
│
└── jobs/                         # Scheduled/queued work. Run by worker.ts, NOT by the API process.
    ├── billing.job.ts
    ├── notification.job.ts
    └── report.job.ts
```

**Inside a module:**

```
modules/customers/
├── customers.routes.ts        # Route declarations only
├── customers.controller.ts    # request/reply ⇄ service
├── customers.service.ts       # Business rules + Drizzle queries
├── customers.schema.ts        # TypeBox — the WIRE contract
├── customers.types.ts         # Types with no schema (optional)
├── customers.test.ts          # Colocated
└── index.ts                   # The module's public surface: its service, nothing else
```

**"Schema" means two different things — keep them straight:**

| Path | Is | Describes |
|---|---|---|
| `db/schema/customers.ts` | Drizzle table | How the row is **stored** |
| `modules/customers/customers.schema.ts` | TypeBox | What goes **over the wire** |

They are deliberately not the same object. The wire schema is what stops
`password_hash` being serialized even when a service hands it over (§7). A
codebase where the API shape is the table shape leaks a column every time
someone adds one.

**Two module names that read ambiguously**, so they are pinned here:

- `modules/services/` — cable **service offerings** (the product a subscriber
  buys). Unrelated to `*.service.ts` files, which are the application layer.
- `modules/collections/` — **payment collection** runs by field staff. Not a
  database collection.

### Jobs

Jobs run in the **worker process** (`src/worker.ts`), never in the API process.
An API process that also runs jobs will stall requests behind a billing run.

Three constraints, because a job in a multi-tenant service is where data
corruption gets scheduled:

1. **Idempotent.** It will run twice — a retry, a redeploy, a duplicate
   message. Re-running must not double-write.
2. **Tenant-scoped explicitly.** A job looping tenants iterates them by id and
   logs each. There is no unscoped "across all tenants" query.
3. **It calls a service.** A job never queries the database directly, so the
   same business rules and authorization apply to a scheduled write as to an
   HTTP one.

A job that cannot meet all three is an operational script, not a job.

### Where code goes

- Used by **one module** → that module's folder.
- Used **across modules** → `shared/`. A `shared/utils/` that accumulates
  single-use helpers is how a codebase stops being navigable.
- **Types come from schemas.** Request/response types are inferred with
  `Static<>` (§7). A `*.types.ts` is only for types that have no schema —
  internal service shapes, discriminated unions. Never hand-write a type that
  mirrors a schema; they drift, and the drift is silent.

---

## 4. Multi-tenancy and identity

This is the core of the domain. Read this section twice.

### 4.1 The model

```
users                    Global identity. ONE row per human, across all tenants.
  ├─ email               UNIQUE, nullable
  ├─ phone               UNIQUE, nullable          (CHECK: email IS NOT NULL OR phone IS NOT NULL)
  ├─ password_hash       nullable (null ⇒ Google-only account)
  ├─ google_sub          UNIQUE, nullable
  └─ is_super_admin      boolean — PLATFORM level, not tenant-scoped

tenants                  A cable operator.

tenant_memberships       The join. A user's role is a property of the MEMBERSHIP.
  ├─ user_id → users
  ├─ tenant_id → tenants
  ├─ role_id → roles      ('admin' | 'staff' | 'customer')
  ├─ status              'active' | 'suspended' | 'invited'
  └─ UNIQUE (user_id, tenant_id)

customers                Tenant-scoped BUSINESS record.
  ├─ tenant_id → tenants
  └─ user_id → users     NULLABLE — a bulk-imported subscriber has no login account
```

**The single most important consequence:** one person signing in with
`uday@example.com` may be an `admin` of tenant A and a `customer` of tenant B.
There is **one** `users` row and **two** `tenant_memberships` rows. Role is
never a column on `users`.

### 4.2 The four roles

| Role | Scope | Who |
|---|---|---|
| `super_admin` | **Platform** — `users.is_super_admin`, no tenant | Us. Crosses tenant boundaries. |
| `admin` | Tenant membership | The tenant owner/operator. Full control of their tenant. |
| `staff` | Tenant membership | Tenant's field/office staff. Scope-limited (§5). |
| `customer` | Tenant membership | The subscriber. Reads their own records only. |

**The backend defines these, not the app.** The mobile client mirrors whatever
role IDs, permission keys and error codes this repo declares. Nothing here is
constrained by what the app happens to do today.

### 4.3 Authentication

Own JWT. Firebase Auth is removed from the system entirely.

**Sign-in identifier is email OR phone.** One endpoint resolves either:
`POST /api/v1/auth/login { identifier, password }` — `identifier` is matched
against `users.email` then `users.phone`.

**Google sign-in happens in the backend.** The mobile app runs native Google
Sign-In, gets an `idToken`, and posts it to
`POST /api/v1/auth/google { idToken }`. The backend verifies that token against
Google's public keys (`google-auth-library`), then links or creates the `users`
row by `google_sub`, falling back to verified `email`. The mobile app never
talks to Firebase again. **This is the only approved outbound call in the
service** (§1).

**Tokens**
- **Access token** — 15 min, JWT. Claims: `sub` (user id), `sid` (session id),
  `did` (device id), `sa` (is_super_admin), `memberships` (array of
  `{tenantId, roleId}`).
- **Refresh token** — 30 days, opaque random 256-bit value, **hashed at rest**.
  Belongs to a session, rotated on every use. Stored in encrypted storage on
  the device.

Never put a password hash, a permission map, or PII in a JWT.

Every token belongs to a **session**, and a session belongs to a device. That
is what makes revocation and per-request attribution possible — see §4.6.

### 4.3.1 Phone sign-in and OTP

**Email signs in with a password. Phone signs in with an OTP.** A phone number
is not a secret and a second password on the same account is a second thing to
leak, so there is no phone + password path.

```
POST /api/v1/auth/otp/request  { phone, channel? }   → 202, always
POST /api/v1/auth/otp/verify   { phone, code, ... }  → tokens
```

**Delivery is a service, not a vendor.** `modules/notifications` exposes a
channel (`whatsapp` | `sms`); callers never name a provider. Today WhatsApp is
served by a self-hosted **OpenWA** instance
(`POST /api/sessions/{id}/messages/send-text`, `X-API-Key`, `chatId` =
`<digits>@c.us`). An SMS gateway becomes a second `MessagingProvider` and an env
change — no caller is touched.

`MESSAGING_ENABLED=false`, and every test run, fall back to the log provider:
the OTP is written to the log and nothing is delivered. That is the §1 kill
switch, and it is why the suite never touches the network.

**Email OTP is deliberately off.** A request for one returns
`400 OTP_EMAIL_NOT_SUPPORTED`. It is not unimplemented-by-accident — it stays
off until an email provider is chosen, and the explicit code is how a client
tells that apart from a bug.

**Rules the OTP flow must follow:**

- **`request` always answers `202`**, whether or not the phone is known.
  Different responses for known and unknown numbers turn the endpoint into a
  free user-enumeration oracle.
- **Only the hash is stored**, never the code — an OTP row is a credential.
- **One active OTP per phone.** Requesting again invalidates the previous code,
  so a stolen older message is useless.
- **Rate limited on two axes**: a resend cooldown
  (`OTP_RESEND_COOLDOWN_SECONDS`) and an attempt cap (`OTP_MAX_ATTEMPTS`). A
  6-digit code is 10⁶ guesses, which is minutes of brute force without a cap.
- **Consumed exactly once**, inside the transaction that creates the session.
- **Delivery failure is a `502 OTP_DELIVERY_FAILED`**, never a silent `202`. A
  disconnected WhatsApp session is the likeliest production failure here, and
  it needs a QR scan rather than a retry — so it must be visible.

### 4.4 Choosing the active tenant

A multi-tenant user must tell the backend which tenant a request is for.

**Decision: the client sends an `X-Tenant-Id` header.** The `tenant` plugin
validates it against the `memberships` claim on every request and rejects
anything not matching an `active` membership. The access token is *not*
re-issued when the user switches tenants — tenant switching is a client-side
header change, and the client re-issues nothing.

Rejected alternative: baking one `tenantId` into the token. It forces a token
round-trip on every tenant switch and makes a stolen token tenant-specific in a
way that buys no real security.

### 4.5 Tenant isolation — the rule that must never be broken

**Every query against a tenant-scoped table filters by `tenant_id`.
No exceptions.**

- The filter is applied in the **service**, from a `tenantId` the controller
  passed in explicitly. It is never read from a global, an AsyncLocalStorage, or
  `process` state.
- A service function that touches a tenant-scoped table **must** take `tenantId`
  as a required parameter. Not optional. Not defaulted. With no repository layer
  to funnel through, this parameter is the isolation guarantee — treat it that way.
- `super_admin` cross-tenant reads go through explicitly named service functions
  (`listAllTenants`, `findCustomerAcrossTenants`) that are obviously unscoped at
  the call site. There is no `if (isSuperAdmin) skip the filter` branch buried
  inside a normal service function.
- Postgres Row-Level Security is enabled on tenant-scoped tables as a
  **backstop**, not as the primary mechanism. Application code must be correct
  on its own.

Filtering happens in SQL, in this service. A client is never trusted to scope
data it was handed, and never receives rows it must filter itself.

### 4.6 Sessions, devices and revocation

An access token is not an identity on its own. It is a claim about *one session,
on one device*. Everything in this section follows from that.

#### The model

```
devices                     One physical install of the app.
  ├─ id                     uuid, server-issued
  ├─ client_device_id       Stable id the app generates once and keeps. UNIQUE.
  ├─ platform               'ios' | 'android'
  ├─ os_version, model, app_version
  ├─ blocked_at             non-null ⇒ every session on it is refused
  └─ first_seen_at, last_seen_at

sessions                    One signed-in ACCOUNT on one device.
  ├─ id                     uuid — this is the `sid` claim
  ├─ user_id → users
  ├─ device_id → devices
  ├─ refresh_token_hash     sha-256 of the current refresh token. UNIQUE.
  ├─ prev_token_hash        the token this one replaced — reuse detection (below)
  ├─ issued_at, expires_at, last_used_at
  ├─ revoked_at             non-null ⇒ dead
  └─ revoked_reason         'logout' | 'logout_all' | 'reuse_detected'
                            | 'admin_revoked' | 'password_changed' | 'device_blocked'
```

A device has many sessions. A user has many sessions. **`(user_id, device_id)`
is not unique** — that is deliberate, and it is what §4.6's multi-account
support rests on.

#### Multiple accounts on one device

The app may hold several signed-in accounts at once — an operator who is
`admin` of their own tenant and `customer` of another, or a shared office
handset. Each account is its **own session with its own refresh token**. There
is no shared token and no "switch user" that reuses credentials.

The rules:

- Signing out of one account revokes **only that session**. The other accounts
  on the device stay signed in.
- "Sign out everywhere" revokes every session for that `user_id`, across all
  devices — but never touches another user's session on the same device.
- Blocking a device revokes every session on it, across all users.
- Cap sessions per device (default 5). On the sixth, the least-recently-used
  session is revoked with reason `logout`. A device accumulating sessions
  without limit is a credential store nobody is watching.

**Account ≠ tenant.** Switching *tenants* is an `X-Tenant-Id` header change
within one session (§4.4). Switching *accounts* means sending a different
session's access token. Do not conflate them: one is a scope change, the other
is a change of who is acting.

#### Every request is attributed

The `authenticate` hook binds identity onto the request logger, so **every log
line** for the request carries who did it:

```ts
request.log = request.log.child({
  userId: token.sub,
  sessionId: token.sid,
  deviceId: token.did,
  tenantId,
});
```

This is the whole answer to "which account is this request actually from" —
`sid` names the session, and a session names exactly one user and one device.
Never infer the acting account from `X-Tenant-Id`, from a body field, or from
anything else the client can set freely. It comes from the signed token.

Mutating requests additionally write `actor_session_id` onto the audit trail, so
a record's history survives the session being revoked.

#### Revocation and blocking

Access tokens are 15-minute JWTs, so "revoked" has to mean something enforced on
every request, not just at refresh time.

**`sid` is checked against an in-memory revocation set on every authenticated
request.** The set holds sessions revoked within the last access-token TTL —
after 15 minutes the token has expired anyway and the entry is dropped, so the
set stays small regardless of how long the service runs.

It is populated at boot from `sessions WHERE revoked_at > now() - interval '15 min'`,
and kept current across instances with Postgres `LISTEN/NOTIFY` on revoke. No
Redis, no external store (§1) — Postgres already does pub/sub.

```
ponytail: with one instance the LISTEN/NOTIFY half is unnecessary — an in-process
Set is enough. Keep NOTIFY; it costs a few lines and is what makes horizontal
scaling a config change rather than a security bug.
```

Rejected alternative: querying `sessions` on every request. One indexed lookup
is cheap in isolation, but it puts the database on the critical path of every
authenticated request including reads that would otherwise not touch it, and it
fails closed in exactly the moment the database is struggling.

**Three levels of kill switch**, each with its own error code:

| Level | Set | Effect | Response |
|---|---|---|---|
| Session | `sessions.revoked_at` | That one account on that one device | `401 AUTH_SESSION_REVOKED` |
| Device | `devices.blocked_at` | Every account on that device | `403 AUTH_DEVICE_BLOCKED` |
| User | `users.disabled_at` | Every session everywhere | `403 AUTH_ACCOUNT_DISABLED` |

Revoking is **always a state change on a row**, never a deletion. A deleted
session cannot be investigated, and "why was I signed out" is a question you
will be asked.

**These cascade automatically:** changing a password, changing the primary
email or phone, or an admin disabling an account revokes every session for that
user. This is not optional cleanup — it is the point of having sessions.

#### Refresh rotation and reuse detection

`POST /api/v1/auth/refresh` takes the refresh token and, in one transaction:

1. Looks up the session by `sha256(token)`.
2. If it matches `prev_token_hash` instead of `refresh_token_hash`, the token
   has been **replayed** — either the app retried, or the token was stolen. The
   session is revoked with `reuse_detected`, and the response is
   `401 AUTH_REFRESH_REUSED`. Both the thief and the legitimate holder are
   signed out. That is the correct outcome: you cannot tell them apart, and
   leaving the session alive favours the attacker.
3. Otherwise it rotates: new token, old hash moved to `prev_token_hash`,
   `last_used_at` updated, new access token issued.

The client must serialize refreshes. Two concurrent refreshes on one session
means the second replays a rotated token and signs the user out — mobile queues
requests behind a single in-flight refresh.

#### Device information

The app sends these on every request. The `device` plugin reads them:

```
X-Device-Id        required on /auth/* — stable, app-generated, opaque
X-Platform         ios | android
X-App-Version      semver
X-OS-Version       free text
X-Device-Model     free text
```

Validated by a shared TypeBox header schema, same as any other input. A device
header is client-supplied data: it identifies an install for support and
revocation, it is **not** an authentication factor and never grants anything.

**Do not write to the database on every request.** `devices.last_seen_at` and
`sessions.last_used_at` are updated on **login and refresh only** — that is at
most once per 15 minutes per session, and it is enough for "when was this
device last active". A per-request `UPDATE` turns every read endpoint into a
write, contends on the same row across concurrent requests, and is the single
easiest way to make a fast CRUD service slow.

Device metadata changes (an OS or app upgrade) are recorded at login/refresh
too. If a device's history matters later, append to a `device_events` table —
do not overwrite the row and lose it.

---

## 5. Authorization (RBAC)

**Permission key**: `resource.action` (e.g. `customers.update`). The canonical
list lives in `src/shared/security/permissions.ts` **in this repo** — the backend owns
it. Clients mirror that file; they never define a key the backend does not
enforce, and a key that exists only on a client is not a permission, it is a
suggestion.

**Scope hierarchy** — a grant carries a scope, and higher includes lower:

```
OWN(1) < ASSIGNED(2) < TEAM(3) < AREA(4) < LOCATION(5) < ALL(6)
```

**Two-stage check, on every protected route:**

1. **Route guard** (`preHandler`) — does the user hold this permission key at
   all, in this tenant? Cheap, no DB read. Fails with `403`.
   ```ts
   preHandler: app.requirePermission('customers.update');
   ```
2. **Resource check** (in the **service**) — does the granted scope reach *this
   specific record*? Compares the grant against the row's
   `createdBy` / `assignedTo` / `teamId` / `areaId` / `locationId`.

**Stage 1 without stage 2 is a security bug.** A `staff` user with
`customers.update` at scope `AREA` passes the route guard for *every* customer.
Only the service-layer check stops them editing a customer in another area.

**Permission resolution is cached, not recomputed per request.** Roles compile
to a permission map per `(user, tenant)`, cached in memory keyed by a `version`
column on the membership. Bumping `version` invalidates it. The compiled map is
server state — it is never shipped to a client to be enforced there.

`super_admin` short-circuits stage 1 only. It still passes through tenant
resolution, so cross-tenant access is deliberate and visible.

---

## 6. API conventions

**Base path `/api/v1`.** Set once via the autoload prefix. Never hardcode
`/api/v1` inside a route file.

**Resources are plural nouns; verbs live in the HTTP method.**

```
GET    /api/v1/customers          list
POST   /api/v1/customers          create        → 201 + Location header
GET    /api/v1/customers/:id      read
PATCH  /api/v1/customers/:id      partial update (PATCH, not PUT)
DELETE /api/v1/customers/:id      delete        → 204
```

A genuine non-CRUD action becomes a sub-resource, not a verb in the path:
`POST /api/v1/tickets/:id/assignments`, not `POST /api/v1/tickets/:id/assign`.

**Success responses have no envelope.** Return the resource. Status codes carry
the meaning — that is what they are for, and an envelope defeats Fastify's
fast serializer.

**List responses** are the one exception, because pagination metadata has
nowhere else to go:

```jsonc
{ "items": [...], "total": 412, "page": 1, "limit": 50 }
```

Offset pagination, `?page=&limit=`, `limit` defaults to 50 and is **capped at
100 in the schema** — the cap is enforced by TypeBox `maximum`, not by code.

**Errors** carry a machine-readable `code` alongside the HTTP status:

```jsonc
{
  "statusCode": 403,
  "error": "Forbidden",
  "code": "PERM_SCOPE_DENIED",   // ← what the client branches on
  "message": "Customer is outside your assigned area",
  "requestId": "req-3"
}
```

The HTTP status says *what class of thing* went wrong; `code` says *which one*.
A `403` alone cannot tell the mobile app whether to show "ask your admin for
access", "switch tenant", or "your account was suspended". See §7.1 for the
contract and the full catalogue.

Do not invent a second error format.

**Idempotency:** `PATCH` and `DELETE` are idempotent. `DELETE` on a missing row
returns `204`, not `404`.

---

## 7. Schemas, validation, and errors

**Every route declares a full `schema`: `params`, `querystring`, `body`,
`response`.** A route without a response schema is incomplete — Fastify's
serializer is what guarantees a field you forgot to strip (like
`password_hash`) never leaves the process.

```ts
// customers.schema.ts
export const CustomerParams = Type.Object({ id: Type.String({ format: 'uuid' }) });
export const CustomerResponse = Type.Object({
  id: Type.String({ format: 'uuid' }),
  name: Type.String(),
  phone: Type.String(),
  // password_hash is absent → it cannot be serialized, regardless of what the service returns
});
export type Customer = Static<typeof CustomerResponse>;
```

- Types are **inferred from schemas** with `Static<>`. Never declare a type and
  a schema separately — they drift, and the drift is silent.
- Shared fragments (`Pagination`, `TenantHeader`, `ErrorResponse`) are registered
  with `app.addSchema()` and `$ref`'d, so they appear once in the OpenAPI output.
- Validation errors are produced by Fastify. Do not re-validate in the service.

**Error mapping.** Services throw domain errors from `shared/errors/`. A single
`setErrorHandler` maps them to a status code *and* an error code. Consequences:

- A `try/catch` that logs and re-throws is noise. Delete it.
- A `catch` that swallows an error and returns a fallback value is **banned**.
  `catch { return [] }` turns a broken query into an empty dashboard that looks
  like a real answer. An error is a `5xx` — it is not silently absorbed.
- `5xx` responses never include a stack trace or a DB message in production. The
  client gets `SERVER_ERROR` and a `requestId`; the detail goes to the log.
- When Sentry lands (§1), `5xx` is reported with the `requestId`, `userId`,
  `sessionId` and `tenantId` — and **never** a token, password hash, or request
  body. Scrub at the integration, not at each call site; a scrubber you have to
  remember to call is one you will forget.

### 7.1 Error codes

Every error response carries a stable `code`. This is what clients branch on.

**Use Fastify's native `code` field.** `FastifyError` already has a `code`
property, and `@fastify/sensible` errors accept one. Do not invent a parallel
field — set `code` and let the standard error path carry it.

```ts
// shared/errors/domain-error.ts
export class DomainError extends Error {
  constructor(readonly code: ErrorCode, readonly statusCode: number, message: string) {
    super(message);
  }
}
export const notFound = () => new DomainError('RESOURCE_NOT_FOUND', 404, 'Not found');
```

**The contract**

- `code` is `SCREAMING_SNAKE_CASE`, namespaced by domain prefix.
- **A shipped code never changes meaning and is never deleted.** Mobile
  versions in the wild branch on it. Add a new code instead; retire the old one
  only once no supported app build reads it.
- `code` is part of the `ErrorResponse` TypeBox schema, so it is serialized and
  it appears in the OpenAPI output. An error without a `code` is a bug.
- The catalogue lives in `src/shared/errors/codes.ts` and is **mirrored byte-for-byte
  into each client**, same as permission keys (§5). The backend is the source of
  truth; a client never invents a code.
- `message` is human-readable, may be reworded or translated at any time, and is
  for logs and developers. **Clients must never branch on `message`.**
- `details` is present only on `VALIDATION_FAILED`: an array of
  `{ field, issue }`, so mobile can attach errors to the right form input.

**Catalogue**

| Code | HTTP | When | What mobile should do |
|---|---|---|---|
| `AUTH_HEADER_MISSING` | 401 | No `Authorization` header | Route to sign-in |
| `AUTH_TOKEN_INVALID` | 401 | Malformed or tampered token | Sign out |
| `AUTH_TOKEN_EXPIRED` | 401 | Access token past expiry | **Refresh silently and retry once** — the one 401 that is not a sign-out |
| `AUTH_REFRESH_INVALID` | 401 | Refresh token unknown or expired | Sign out |
| `AUTH_REFRESH_REUSED` | 401 | A rotated refresh token was replayed; family revoked (§4.3) | Sign out **everywhere**, warn the user |
| `AUTH_CREDENTIALS_INVALID` | 401 | Wrong identifier or password | Inline form error. Never say which one was wrong. |
| `AUTH_PASSWORD_NOT_SET` | 401 | Password login on a Google-only account | Show "Continue with Google" |
| `AUTH_GOOGLE_TOKEN_INVALID` | 401 | Google ID token failed verification | Retry Google sign-in |
| `AUTH_ACCOUNT_DISABLED` | 403 | `users` row is disabled platform-wide | Sign out, show support contact |
| `AUTH_SESSION_REVOKED` | 401 | Session was revoked (logout elsewhere, reuse detected, admin action) | Sign out this account only; other accounts on the device stay |
| `AUTH_DEVICE_BLOCKED` | 403 | `devices.blocked_at` is set | Sign out **all** accounts on the device, show support contact |
| `TENANT_HEADER_MISSING` | 400 | Tenant-scoped route, no `X-Tenant-Id` | Client bug — send the header |
| `TENANT_NOT_A_MEMBER` | 403 | `X-Tenant-Id` has no membership for this user | Force the tenant picker |
| `TENANT_MEMBERSHIP_SUSPENDED` | 403 | Membership `status` is `suspended` | Show "access to this operator was suspended" |
| `TENANT_INACTIVE` | 403 | The tenant itself is deactivated | Same, with the tenant name |
| `PERM_DENIED` | 403 | Permission key not held (§5 stage 1) | Hide the action, show "ask your admin" |
| `PERM_SCOPE_DENIED` | 403 | Key held but scope does not reach this record (§5 stage 2) | Show "outside your assigned area/team" |
| `VALIDATION_FAILED` | 400 | Schema validation failed | Map `details[]` onto form fields |
| `RESOURCE_NOT_FOUND` | 404 | Row missing **or** owned by another tenant | Generic not-found |
| `RESOURCE_DUPLICATE_EMAIL` | 409 | Email already registered | Field error on email |
| `RESOURCE_DUPLICATE_PHONE` | 409 | Phone already registered | Field error on phone |
| `RESOURCE_CONFLICT` | 409 | Any other unique-constraint violation | Generic conflict |
| `TENANT_CODE_UNAVAILABLE` | 409 | Tenant prefix could not be derived or all variants are taken (§8.1) | Prompt the operator for an explicit code |
| `RESOURCE_IN_USE` | 409 | Delete blocked by a foreign key (e.g. package still on live accounts) | Explain what must be detached first |
| `RATE_LIMIT_EXCEEDED` | 429 | `@fastify/rate-limit` tripped | Back off using the `Retry-After` header |
| `SERVER_ERROR` | 500 | Unhandled | Generic retry, log `requestId` |
| `SERVER_UNAVAILABLE` | 503 | `@fastify/under-pressure` shed the request | Back off and retry |

**The one rule that overrides convenience:** a record belonging to another
tenant returns `404 RESOURCE_NOT_FOUND` — identical to a record that does not
exist. Never a distinct `TENANT_FORBIDDEN` code here. A distinct code would
confirm the row exists and leak across the tenant boundary, undoing the `404`
the status line was chosen for (§6, §10).

---

## 8. Database conventions

- **Naming:** `snake_case` tables and columns, plural table names. Drizzle maps
  them to `camelCase` in TypeScript.
- **Primary keys:** `uuid` with `gen_random_uuid()`.
- **Timestamps:** `created_at` / `updated_at`, `timestamptz`, defaulted in the DB.
- **Money:** `numeric(12,2)` in Postgres, **decimal.js** in TypeScript. **Never
  `float`/`double`, and never a JavaScript `number` for an amount** — `0.1 + 0.2`
  is not `0.3`, and a rupee lost per invoice is a reconciliation bug nobody finds
  for a year. The Drizzle column maps to `string`; parse into `Decimal` at the
  edge of the service, serialize back to a string on the way out.
- **Soft delete** only where record history is legally or operationally required
  (customers, payments) — `deleted_at timestamptz`. Everything else deletes for
  real. Soft-deleting by default leaves you filtering `deleted_at IS NULL` in
  every query forever, and forgetting it once is a data leak.
- **Indexes:** every foreign key gets one, and every tenant-scoped table gets a
  composite index leading with `tenant_id` (`(tenant_id, created_at desc)`),
  because *every* query filters on it.

**Migrations**
- Generated with `drizzle-kit generate`, reviewed as SQL, committed.
- **A migration is immutable once it has run anywhere but a local scratch
  database.** Fix it forward with a new one. Before that — a greenfield branch
  whose migration has only ever touched a developer's own database — regenerating
  is better than shipping an `ALTER` that every future setup replays for no
  reason. The moment it reaches a shared environment, that door closes.
- Every migration must be safe to run against a live table: no blocking
  `ALTER`s, add columns nullable first, backfill, then constrain.
- `drizzle-kit push` is for local scratch work only. **Never against staging or
  production.**

### 8.1 Identifiers: internal ID vs public code

Every tenant-scoped business record carries **two** identifiers. They are not
interchangeable and they are not both for the same audience.

| | `id` | `customer_code` |
|---|---|---|
| Type | `uuid` | `text` |
| Audience | Machines | Humans |
| Used for | Primary key, foreign keys, API paths, joins | Displayed in the UI, searched, read aloud on a phone call, printed on a receipt |
| Shape | `9f2c...` — opaque | `SCB-000123` — pronounceable |
| Mutable | Never | Never (see immutability, below) |
| Leaks | Nothing | The tenant prefix, and roughly how many customers that tenant has |

**API paths use `id`.** `GET /api/v1/customers/9f2c…`, and `customerCode` is a
field in the response. Codes are looked up with
`GET /api/v1/customers?code=SCB-000123`. This keeps URLs decoupled from the
tenant prefix — if a tenant ever needs its prefix changed, only display strings
are affected, not every stored reference.

**`customer_code` is never a foreign key.** Anything referencing a customer
references the `uuid`.

#### Deriving the tenant prefix

`tenants.code` is a short prefix derived from the tenant's name. It is
generated once, at tenant creation, by a pure function in
`shared/utils/tenant-code.ts` — no database access, so it is trivially unit-testable
against the table of cases below.

```ts
export function deriveTenantCode(name: string): string;
```

Rules, applied in order:

1. Uppercase; transliterate accents; strip everything outside `A-Z0-9` and spaces.
2. Drop noise words: `AND`, `THE`, `OF`, and legal suffixes `PVT`, `PVT.`,
   `LTD`, `LLP`, `INC`, `CO`, `CORP`.
3. **Two or more significant words** → initials of the first four.
4. **One significant word** → its first three letters.
5. Drop leading digits; the first character must be `A-Z`.
6. The result must match `^[A-Z][A-Z0-9]{1,4}$` — 2 to 5 characters.

| Tenant name | Code |
|---|---|
| `Satya Cable & Broadband` | `SCB` |
| `Satyanet` | `SAT` |
| `The Star Vision Network Pvt Ltd` | `SVN` |
| `A1 Cable` | `AC` |
| `4K Vision` | `KV` |
| `श्री Cable` | `C` → fails rule 6 → **rejected** |

**Collisions and failures are surfaced, never papered over.** If the derived
code is taken, try `SCB2`, `SCB3` … up to `SCB9`. If those are taken, or
derivation fails rule 6, the API returns `409 TENANT_CODE_UNAVAILABLE` and the
operator supplies a code explicitly. A function that silently invents
`TENANT7X` for an unparseable name produces an identifier no human will ever
recognise — which defeats the entire purpose of having a public code.

**`tenants.code` is immutable once set.** Customer codes already issued embed
it, and those codes are on receipts and in customers' phones. Renaming a tenant
does **not** change its code. There is no update path for this column, and the
lint-visible reason is written next to it in the schema.

#### Generating the customer code

Format: `{TENANT_CODE}-{seq}`, `seq` zero-padded to 6 digits — `SCB-000123`.
Past 999999 it simply grows to 7 digits; it is never truncated or wrapped.

**No database trigger.** Generation happens in the service, in one statement,
inside the same transaction as the insert:

```ts
// customers.service.ts — inside tx
const [t] = await tx.update(tenants)
  .set({ customerSeq: sql`${tenants.customerSeq} + 1` })
  .where(eq(tenants.id, tenantId))
  .returning({ code: tenants.code, seq: tenants.customerSeq });

const customerCode = `${t.code}-${String(t.seq).padStart(6, '0')}`;
```

`UPDATE … RETURNING` is atomic: it takes a row lock on that tenant, so
concurrent inserts serialize per tenant and the sequence is gapless. There is
no `SELECT max(seq) + 1` anywhere — that is a race, and under concurrency it
hands two customers the same code.

**Why not a trigger** (beyond it being more machinery than the problem needs):

- It is invisible at the call site. You read `createCustomer`, and nothing
  explains where the code came from.
- It cannot be unit-tested or stepped through without a database round trip.
- It fires on *every* insert path — including the Firestore migration (§9),
  which must preserve existing codes rather than mint new ones. You would then
  need a flag to disable the trigger, which is a second mechanism to maintain.
- Its logic lives in migration SQL, so changing it means another migration, and
  there is no single file in the codebase that states the current rule.

**Why not a Postgres `SEQUENCE`:** a sequence per tenant is runtime DDL; a
shared sequence leaks platform-wide volume across tenants (customer `SCB-005000`
in a brand-new tenant tells you how big the whole platform is); and sequences
are non-transactional, so a rolled-back insert burns a number and leaves a gap
in an identifier customers read aloud.

`customer_code` carries a **global** `UNIQUE` constraint — tenant codes are
unique, so codes cannot collide across tenants, and a global constraint is the
simpler backstop. On a unique violation the service retries the counter bump up
to 3 times, then fails with `RESOURCE_CONFLICT`. The constraint exists to catch
a logic bug, not as the normal path.

> `ponytail:` the counter is a `customer_seq` column on `tenants`, so creating a
> customer briefly locks that tenant row. Fine at cable-operator write rates. If
> ticket and receipt numbers need the same treatment, move it to a
> `tenant_counters(tenant_id, kind, next_value)` table rather than adding a
> third counter column here.

#### Imported customers

Existing records carry codes in an older, non-sequential shape (an MSO id with a
prefix). This is a **data** question, not a legacy-logic one, and it has one
real consequence: those codes are printed on receipts and known to customers and
staff, so regenerating them silently changes an identifier people already use.

Default, unless you say otherwise (§9):

- The migration imports the existing code **verbatim** into `customer_code`. It
  does not regenerate one.
- It then sets `tenants.customer_seq` above the highest numeric suffix it can
  parse for that tenant, so newly created customers cannot collide with an
  imported code.
- A record arriving with no code gets one from the normal generation path.

The alternative — reissue every customer a clean `SCB-000001` code and publish a
mapping — is cleaner going forward and is a reasonable call. It is a business
decision about whether customers' existing numbers matter, so it is yours.

### 8.2 PostgreSQL schemas

**Every table lives in a named schema. Nothing lives in `public`.**

| Schema | Holds | Owned by |
|---|---|---|
| `tenancy` | `tenants`, `tenant_memberships`, `membership_areas`, `membership_locations` | `tenants` |
| `auth` | `users`, `sessions`, `devices`, `otp_codes` | `auth`, `users`, `devices` |
| `iam` | `roles`, `role_permissions` | `roles`, `permissions` |
| `crm` | `customers` | `customers` |
| `drizzle` | migration bookkeeping | Drizzle Kit |

Later domains get their own: `billing` (invoices, payments, collections),
`ops` (tickets, inventory), `audit`.

**Why.** The module boundaries in §3 are enforced in the import graph by the
linter — but the linter cannot see SQL. A schema makes the same boundary
visible where the query actually runs: `crm.customers JOIN auth.users` is
legibly crossing a boundary in the statement, in an `EXPLAIN`, and in a
slow-query log. Table names also stop competing for one namespace, so
`billing.payments` and `ops.payments` can coexist if they ever need to.

A schema is a **grouping by domain, not one per module** — `auth`, `users` and
`devices` are three modules over one identity domain, and splitting their tables
across three schemas would make every session lookup a cross-schema join for no
gain. One schema per domain; a module's tables live in exactly one of them.

**Rules:**

- New tables are declared through a schema object from `db/schema/schemas.ts`
  (`crm.table(...)`), never `pgTable(...)`. A `pgTable` call lands the table in
  `public`, which is how the convention quietly erodes.
- **Do not set a `search_path` and rely on it.** Drizzle fully qualifies every
  identifier, and unqualified SQL that resolves by search order is a
  wrong-table bug waiting for a session that connects differently.
- Adding a schema means adding it to `schemaFilter` in `drizzle.config.ts`, or
  Drizzle Kit will not see its tables — and will not notice they are missing.
- Cross-schema foreign keys are fine and expected (`crm.customers.tenant_id →
  tenancy.tenants.id`). The boundary rule is about *queries a module writes*,
  not about referential integrity.
- Schemas are not a security boundary here. Tenant isolation is `tenant_id` in
  every query (§4.5); do not let a namespace create the impression otherwise.
---

## 9. Firestore → Postgres data migration

**This is a data migration, not a logic port.** The schema, the rules and the
identifiers in this repo are designed fresh. Nothing about how the old client
stored or reshaped data constrains them. The job is: read the rows that exist,
map them onto the new schema, and refuse anything that does not fit.

A one-off, resumable, **idempotent** script in `src/db/seed/`. Re-running it
must not duplicate rows.

Order matters (foreign keys): `tenants` → `users` → `tenant_memberships` →
`roles`/`permissions` → `customers` → `customer_accounts` → `packages` →
`payments` → `tickets`.

**The legacy data is messy in three known ways.** Handle them at the boundary —
map once on the way in, then never think about them again. None of this
becomes a shape the backend supports:

1. **Rows with no tenant.** Bulk-imported records are unscoped. The script
   assigns them to an explicitly named tenant passed as an argument, and
   **fails loudly** on any row it cannot attribute. It does not guess, and
   there is no default.
2. **The same entity in multiple shapes.** Packages appear both as
   `packageName`/`price`/`isActive` and as `name`/`monthlyPrice`/`active`;
   connection data is spread across `customer_accounts`, `services`, and an
   array embedded in the customer document. The script collapses all of it into
   the one canonical shape defined by the Drizzle schema. Where two sources
   disagree, it records a conflict in the report rather than picking a winner
   silently.
3. **Free-text enums.** Status and service-type strings are inconsistent
   (`cable`, `cable_tv`, `broadband`, `internet`, …). Map them to the schema's
   enum with an explicit, reviewable table in the script. **Anything unmapped
   fails the row** — it does not fall through to a default like `cable_tv`,
   because a wrong default is indistinguishable from correct data afterwards.

**Auth.** Firebase users migrate by `email`/`phone` into `users` with a **null
`password_hash`**. Those accounts sign in with Google or set a password via
reset. Firebase password hashes are not portable — there is no way around this.

**Reporting.** Every run writes a reconciliation report: source count, inserted,
skipped, failed, and conflicts — per collection. A run that does not reconcile
is a failed run. Import into a scratch database and read the report before
pointing it anywhere real.

---

## 10. Code quality

### Lint — strict, and the same base config as the mobile repo

`@antfu/eslint-config` with `typescript: true`, stylistic (2 spaces, single
quotes, semicolons), plus the rules below. These are **errors**, not warnings.
A warning nobody fixes is a rule that does not exist.

| Rule | Setting | Why |
|---|---|---|
| `unicorn/filename-case` | `kebabCase` | Matches the mobile repo |
| `max-params` | `3` | Past three, pass an object |
| `max-lines-per-function` | `110` | Matches the mobile repo |
| `complexity` | `12` | Branchy code is where authorization bugs hide |
| `ts/no-explicit-any` | error | `any` in a service erases the tenant type |
| `ts/no-floating-promises` | error | An unawaited DB write is silent data loss |
| `ts/no-misused-promises` | error | Catches `async` handlers passed where sync is expected |
| `ts/consistent-type-imports` | error | — |
| `no-console` | **error** | Use `request.log` / `app.log`. A `console.log` bypasses Pino, loses the request id, and leaks in production. This is the one rule that differs from mobile — mobile has it off, the backend must not. |
| `node/no-process-env` | error | Env is read **only** in `config/env.ts` |

**Layer enforcement** via `import/no-restricted-paths` — the architecture in §3
is checked by the linter, not by reviewer memory:

- `modules/**/*.service.ts` may not import `fastify`.
- `modules/**/*.controller.ts` and `modules/**/*.routes.ts` may not import `db/`.
  With no repository layer, this rule is the only thing keeping queries out of
  controllers — it is load-bearing.
- `jobs/**` may not import `db/`; jobs go through services (§3).
- `modules/a/**` may not import `modules/b/**` except through `modules/b/index.ts`.
- `modules/a/**` may not import `modules/b/**` — cross-module access goes
  through the other module's *service*, exported from its `index.ts`.

TypeScript: `strict`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
`noImplicitOverride`, `verbatimModuleSyntax`.

### Git hooks (Husky) — mirrors the mobile repo

- **pre-commit** — branch protection (no direct commits to `main`), then
  `pnpm type-check` + `lint-staged`.
- **commit-msg** — `commitlint`, conventional commits.
- **pre-push** — `pnpm test`.
- **post-merge** — `pnpm install` if the lockfile changed; warn if
  `db/migrations/` changed.

`pnpm check-all` = `lint` + `type-check` + `test`. CI runs exactly this.

### Tests

Colocated `*.test.ts`, using **Vitest**, Fastify `app.inject()`, and
**Testcontainers** for a real PostgreSQL 18 per run.

Testcontainers means tests run against the same Postgres version as production —
`numeric` behaves like `numeric`, constraints actually fire, and a broken
migration is caught by the suite instead of by a deploy. It needs Docker in CI;
that is the price and it is worth paying. There is no SQLite or in-memory
substitute: a test against a different database tests a different database.

Each test runs inside a transaction that rolls back, so tests are
order-independent and safe to parallelise.

**Definition of done: one endpoint at a time.** An endpoint is not finished when
it returns 200. It is finished when its unit tests and its end-to-end tests pass.
Do not start the next endpoint until the current one is green.

The loop for every single endpoint:

1. Write the TypeBox schema and the route.
2. Write the service.
3. **Unit-test the service** against the container database, no HTTP. Cover the
   business rules and every branch. (Services hold the queries, so there is
   nothing to stub — the query *is* the behaviour under test, and a stubbed
   Drizzle would only test the stub.)
4. **End-to-end test the route** with `app.inject()`. Real JWT, real RBAC hooks,
   real `X-Tenant-Id`, real database — **never mock auth middleware**. A test
   with mocked auth proves nothing about the endpoint that ships.
5. Run `pnpm check-all`. Green, then move on.

**Edge cases every endpoint must cover.** This is the checklist, not a suggestion:

| Case | Expected |
|---|---|
| No `Authorization` header | `401` |
| Expired / malformed / tampered token | `401` |
| Token for a revoked session | `401 AUTH_SESSION_REVOKED` |
| Token for a blocked device | `403 AUTH_DEVICE_BLOCKED` |
| Refresh token replayed after rotation | `401 AUTH_REFRESH_REUSED`, and the session is revoked |
| Two accounts on one device: signing out A | B's session still works |
| "Sign out everywhere" for user A | A's other device dies, B on the same device survives |
| Password change | every session for that user is revoked |
| Valid token, permission key not held | `403` |
| Permission held but scope does not reach the record (§5 stage 2) | `403` |
| `X-Tenant-Id` for a tenant the user has no membership in | `403` |
| `X-Tenant-Id` missing on a tenant-scoped route | `400` |
| **Record belongs to tenant B, requested by tenant A** | `404 RESOURCE_NOT_FOUND` — byte-identical to a genuinely missing row. A `403`, or a distinct code, confirms the row exists. |
| Membership exists but `status` is `suspended` | `403` |
| `super_admin` cross-tenant access | allowed, and asserted explicitly |
| Non-existent `:id` | `404` |
| Malformed `:id` (not a uuid) | `400`, from the schema |
| Missing required body field / wrong type / unknown extra field | `400` |
| `limit` above the cap, `page` ≤ 0, negative numbers | `400` from the schema |
| Duplicate on a unique column (email, phone, customer code) | `409` |
| `PATCH` with an empty body | `400` |
| `DELETE` on an already-deleted row | `204` (idempotent, §6) |
| Response body contains no `password_hash`, `google_sub`, or other non-schema field | asserted |
| Money value round-trips exactly (`numeric`, not float) | asserted on any endpoint carrying an amount |

**Every error assertion checks `code`, not just `statusCode`.** A test that only
asserts `403` passes whether the cause was a missing permission, a suspended
membership, or the wrong tenant — so it does not prove the endpoint behaves
correctly, and it would not catch mobile being routed to the wrong screen.
Assert the exact code from the §7.1 catalogue.

**Tenant isolation is tested per endpoint, not once globally.** Every
tenant-scoped endpoint gets its own cross-tenant test. A shared helper
(`expectTenantIsolation(app, method, url)`) makes that one line, so there is no
excuse to skip it.

A PR that adds an endpoint without its unit tests and its e2e edge-case tests
does not merge.

---

## 11. Essential rules

- ✅ **DO** route → controller → service. One job per layer. No repository layer.
- ✅ **DO** take `tenantId` as a required parameter on every service function touching a tenant-scoped table.
- ✅ **DO** declare a `response` schema on every route — it is the last line of defence against leaking a field.
- ✅ **DO** infer types from TypeBox schemas with `Static<>`.
- ✅ **DO** check permission scope against the actual record in the service, not just the key in the route guard.
- ✅ **DO** use `@fastify/sensible` errors and the one central error handler.
- ✅ **DO** give every error a `code` from `shared/errors/codes.ts`, and mirror that file into clients.
- ✅ **DO** revoke every session for a user on password, email or phone change.
- ✅ **DO** read env only through `config/env.ts`.
- ✅ **DO** treat this repo as the source of truth for permission keys, role IDs and error codes. Clients mirror it.
- ✅ **DO** import across modules as `@/modules/<name>` (its `index.ts`); inside a module use relative siblings (`./customers.service`). Never `../../`.
- ✅ **DO** cross module boundaries only through the other module's `index.ts` service export.
- ✅ **DO** use `decimal.js` for every monetary calculation.
- ✅ **DO** put deferred integrations behind an interface with a kill switch (§1).
- ❌ **DO NOT** write SQL or Drizzle queries outside a `*.service.ts`.
- ❌ **DO NOT** import `fastify` into a service, or touch `request`/`reply` outside a controller.
- ❌ **DO NOT** hand-write a type that mirrors a TypeBox schema. Infer it with `Static<>`.
- ❌ **DO NOT** add a cron job that is non-idempotent, unscoped across tenants, or queries the DB directly (§3).
- ❌ **DO NOT** swallow an error and return a fallback value — that is how a broken query becomes an empty dashboard.
- ❌ **DO NOT** put a role column on `users`. Role belongs to the membership.
- ❌ **DO NOT** trust `X-Tenant-Id` without validating it against the token's memberships.
- ❌ **DO NOT** infer the acting account from anything but the signed token's `sub`/`sid`.
- ❌ **DO NOT** write `last_seen_at`/`last_used_at` on every request. Login and refresh only.
- ❌ **DO NOT** delete a session row to revoke it. Set `revoked_at` and a reason.
- ❌ **DO NOT** treat a device header as an authentication factor.
- ❌ **DO NOT** let `auth/otp/request` reveal whether a phone is registered.
- ❌ **DO NOT** store an OTP in plaintext, or report `202` when delivery failed.
- ❌ **DO NOT** name a messaging vendor outside its provider file. Callers pick a channel.
- ❌ **DO NOT** branch on `message` or reuse an error `code` for a new meaning — shipped app builds depend on both.
- ❌ **DO NOT** return a tenant-specific error code for a cross-tenant record. It is `404 RESOURCE_NOT_FOUND`, same as missing.
- ❌ **DO NOT** build a deferred capability early, or add an integration that skips the five rules in §1.
- ❌ **DO NOT** use a database trigger to generate an identifier. It is service logic (§8.1).
- ❌ **DO NOT** use `customer_code` as a foreign key, or change `tenants.code` after creation.
- ❌ **DO NOT** compute a sequence with `SELECT max(...) + 1`. Use `UPDATE … RETURNING`.
- ❌ **DO NOT** edit a merged migration. Fix forward.
- ❌ **DO NOT** declare a table with `pgTable(...)`. Use its schema object (§8.2).
- ❌ **DO NOT** rely on `search_path`; every identifier is schema-qualified.
- ❌ **DO NOT** run `drizzle-kit push` against a shared database.
- ❌ **DO NOT** use `console.log`. Use the request logger.
- ❌ **DO NOT** join across a module boundary in raw SQL because both tables share a database.
- ❌ **DO NOT** use a JavaScript `number` for money, anywhere.
- ❌ **DO NOT** run jobs in the API process. They belong to `worker.ts`.
- ❌ **DO NOT** call a deferred integration (storage, push, email) on the request path of a write. Commit, then enqueue.
