# Cable Backend

Multi-tenant operations API for Satya Cable & Broadband.

**[AGENTS.md](./AGENTS.md) is the contract.** Architecture, auth model, error
codes, database rules and the definition of done all live there. Read it before
changing anything; this file only covers getting the thing running.

## Stack

Node 24 · Fastify 5 · PostgreSQL 18 · Drizzle ORM · TypeBox · Vitest

## Setup

```bash
pnpm install
cp .env.example .env          # then set JWT_SECRET: openssl rand -base64 48
pnpm db:up                    # PostgreSQL 18 in Docker
pnpm db:migrate
pnpm db:seed                  # roles, tenants, admin logins, the location hierarchy
pnpm dev                      # http://localhost:5050 — docs at /docs
```

## Seeding

**`pnpm db:seed` first, always.** It creates the location categories, the two
schemas and the `Mandapeta → TIDCO Apartments` root; the importers below hang
their data off those nodes and refuse to run without them.

```bash
pnpm db:seed              # roles, tenants, admins, locations   (run this first)
pnpm db:seed:mso          # the operator's real book: customers, subscriptions, equipment, ledger
pnpm db:seed:packages     # channel line-up from the ACT channel export
```

The importers read the operator's exports from `data/`. Those files are
gitignored (`*.xls`, `*.csv`), so a fresh clone has the directory and not the
data — `db:seed:mso` stops with the path it wanted rather than inventing rows.

All three are idempotent. `db:seed:mso` matches customers on their account
number and rebuilds equipment from scratch each run (it is derived entirely
from the report), so a second run changes nothing.

**Imported customers have no login.** `crm.customers.user_id` stays null —
these are subscriber records, not accounts. Logins are issued through the real
signup flow, so an imported row never becomes a credential nobody handed out.

What one run produces, at the time of writing: 764 customers and subscriptions,
2292 equipment assets, 5097 ledger transactions, and 1115 location nodes built
from the addresses in the report rather than generated.

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API with hot reload |
| `pnpm worker:dev` | Background worker (no jobs yet) |
| `pnpm check-all` | lint + type-check + test. CI runs exactly this. |
| `pnpm verify` | Startup config checks without listening. Gate deploys on this. |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Browse the database |
| `pnpm db:seed` | Roles, tenants, admin logins, location hierarchy |
| `pnpm db:seed:mso` | Import the operator's customer book (needs `db:seed` first) |
| `pnpm test` | Vitest. Needs PostgreSQL and Redis. |
| `pnpm build && pnpm start` | Production build and run |

## Local monitoring

With the API running on port 5050, start Prometheus, Loki, Alloy, and Grafana:

```bash
docker compose -f docker-compose.monitoring.yml up -d
```

Prometheus is at `http://localhost:9090` and Grafana at
`http://localhost:3099` (`admin` / `admin`). The provisioned **Fastify
Backends Overview** dashboard includes request metrics, latency percentiles,
slow endpoints, and Pino logs. Add metrics endpoints to
`monitoring/prometheus/targets.yml`; use `api:5050` for a Compose service or
`host.docker.internal:5050` for a host process. To add another backend's log
files, mount its log directory under `/var/log/backends/<service>` in the Alloy
service; the directory name becomes the Grafana `service` label.

Tests use the local PostgreSQL via `.env.test`, falling back to Testcontainers
when that file is absent. Cache tests need Redis on `REDIS_URL`.

## Postman

`postman/` holds the collection and two environments. Import all three.

Tokens are handled automatically: any response containing `accessToken` is
captured, and before each authenticated request the token is refreshed if it is
missing or within 60s of expiry. A rejected refresh clears the environment,
because replaying a rotated refresh token revokes the session.

Start with **Auth > OTP > Request code**, put the code in `otpCode`, then
**Verify code**.

## Startup checks

The server verifies its configuration before it listens, and exits non-zero if
anything required is missing:

```
✓ environment       APP_ENV=local NODE_ENV=development
✓ jwt secret        64 characters
✓ database          connected, ssl=disable
✓ database schemas  7 present
✓ migrations        5/5 applied
✓ cache             redis reachable, ttl=300s prefix="cable:"
✓ messaging         openwa · whatsapp sms(placeholder) email(placeholder) push(placeholder)
! object storage    not configured — file endpoints return 503
```

`!` is a warning locally and a failure in production. `pnpm verify` runs the
same checks without starting the server.

## Environments

`NODE_ENV` is Node's flag; **`APP_ENV` is the tier** and decides policy.

| | `local` | `staging` | `production` |
|---|---|---|---|
| DB TLS | disable | disable | **require / verify-full** |
| 5xx body | message + stack | message + stack | code + requestId only |
| CORS | any | any | explicit allowlist |
| `/docs` | yes | yes | no |

Production refuses to boot without TLS, a CORS allowlist and a 48-char
`JWT_SECRET`. See AGENTS.md §2.1.

## Database schemas

Tables are namespaced by domain — nothing is in `public`:

| Schema | Tables |
|---|---|
| `tenancy` | tenants, teams, tenant_memberships, membership_locations |
| `auth` | users, sessions, devices, otp_codes |
| `iam` | roles, role_permissions |
| `crm` | customers, subscriptions, services, service_providers, service_coverage, packages, channels, package_channels, equipment, customer_equipment, account_transactions |
| `geo` | location_categories, location_schemas, location_schema_levels, locations, location_aliases |
| `notify` | notifications |
| `media` | files |
| `analytics` | views only (dashboard aggregates) |
| `audit` | append-only business audit events |

### Business audit log

Audit semantic business mutations (`customer.updated`, `package.price_changed`), not reads, HTTP traffic, or arbitrary SQL. Pino remains the application/request log. Audit rows are append-only; retention is a separate maintenance concern.

Always write the business mutation and audit row through the same Drizzle transaction. Snapshots, changes, and metadata are recursively sanitized, but callers must still avoid putting unnecessary personal data in them.

```ts
await db.transaction(async (tx) => {
  const [customer] = await tx.update(customers).set(patch).where(/* tenant-scoped predicate */).returning();
  await audit.updated(tx, request.auditContext, {
    entityType: 'customer',
    entityId: customer.id,
    before: existingCustomer,
    after: customer,
  });
});
```

`tenantId` is nullable only for genuine platform events. Tenant-scoped work must copy the validated tenant directly into the row; the audit context plugin only captures the header and does not replace tenant validation. If volume eventually warrants it, range-partition `audit.audit_logs` by `created_at` (normally monthly). Database triggers remain an optional last-resort safety layer for a small number of exceptionally sensitive tables, not the source of business events.

Caching is Redis with a 300s TTL: `GET` reads it, a successful
`POST`/`PUT`/`PATCH`/`DELETE` invalidates that resource. Responses carry
`x-cache: HIT|MISS`. See AGENTS.md §8.5.

Declare new tables through a schema object in `src/db/schema/schemas.ts`
(`crm.table(...)`), never `pgTable(...)`. See AGENTS.md §8.2.

## Locations

Addresses are a **tenant-configured tree**, not fixed `area`/`building`/`floor`
columns. One tenant runs `Area → Building → Block → Floor → Door`, the next runs
`Village → Street → House`, and the same endpoints and the same UI serve both.

Set one up in three calls (all need `Authorization` and `X-Tenant-Id`):

```bash
POST /api/v1/location-categories   {"name":"Building","slug":"building"}      # once per kind of place
POST /api/v1/location-schemas      {"name":"Apartment","slug":"apartment",
                                    "levels":[{"categoryId":"…"}, …]}         # root-first order
POST /api/v1/location-schemas/:id/generate
     {"parentId":"…","levels":[{"names":["A","B"],"nameFormat":"Block {label}","codeFormat":"{label}"},
                               {"count":4,"nameFormat":"Floor {i}","codeFormat":"{parentCode}{i}"},
                               {"count":4,"nameFormat":"{parentCode}{i2}","codeFormat":"{name}"}]}
```

That last call creates blocks, floors and doors as real rows — `A101`, `A102`,
… — so they can be filtered, assigned to customers and permission-scoped. A
customer's address points at one terminal node; everything above it is derived.

`X-Tenant-Id` is only needed when you belong to more than one operator —
otherwise the tenant comes from the token. Every route is authenticated by
default; sign-in, `/health` and `/docs` are the exceptions.

Staff see only the subtrees granted to their membership
(`tenancy.membership_locations`), and a node added by someone without
`locations.configure` lands as `pending` for review. Full rules in AGENTS.md
§8.6; the endpoint table is §6.1.

## Design docs

`docs/` holds proposals agreed before they are built, and the long-form
reference for a subsystem whose rule is too big for AGENTS.md. AGENTS.md stays
the contract for what exists; a doc here is either what is being decided, or the
detail behind a rule AGENTS.md states in a paragraph. Each says which.

- [`services-providers-packages.md`](docs/services-providers-packages.md) —
  services → providers → packages, and which locations each is sold in.
  **Proposal, not built.**
- [`audit-trail.md`](docs/audit-trail.md) — what `audit.audit_logs` records, how
  to audit a new endpoint, and the test that fails if you forget.
  **Built**; the rule is AGENTS.md §6.0.

## Layout

```
src/
├── server.ts      worker.ts      app.ts
├── config/        env + app-wide constants
├── plugins/       database, auth, tenant, rbac, security, swagger, errors
├── modules/       one folder per resource: routes → controller → service
│                 `x.routes.ts` is the entry: it builds the service and
│                 registers `routes/` when a module has several route files.
│                 No index.ts barrels — imports name the file they need.
├── db/            schema/ migrations/ seed/  (tables live in named PG schemas)
├── shared/        errors, security, pagination, types, utils
└── jobs/          run by worker.ts, never by the API process
```
