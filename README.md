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
pnpm dev                      # http://localhost:5050 — docs at /docs
```

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | API with hot reload |
| `pnpm worker:dev` | Background worker (no jobs yet) |
| `pnpm check-all` | lint + type-check + test. CI runs exactly this. |
| `pnpm db:generate` | Generate a migration from schema changes |
| `pnpm db:migrate` | Apply pending migrations |
| `pnpm db:studio` | Browse the database |
| `pnpm test` | Vitest. Needs PostgreSQL and Redis. |
| `pnpm build && pnpm start` | Production build and run |

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
| `tenancy` | tenants, tenant_memberships, membership_areas, membership_locations |
| `auth` | users, sessions, devices |
| `iam` | roles, role_permissions |
| `crm` | customers |
| `notify` | notifications |
| `media` | files |
| `analytics` | views only (dashboard aggregates) |

Caching is Redis with a 300s TTL: `GET` reads it, a successful
`POST`/`PUT`/`PATCH`/`DELETE` invalidates that resource. Responses carry
`x-cache: HIT|MISS`. See AGENTS.md §8.5.

Declare new tables through a schema object in `src/db/schema/schemas.ts`
(`crm.table(...)`), never `pgTable(...)`. See AGENTS.md §8.2.

## Layout

```
src/
├── server.ts      worker.ts      app.ts
├── config/        env + app-wide constants
├── plugins/       database, auth, tenant, rbac, security, swagger, errors
├── modules/       one folder per resource: routes → controller → service
├── db/            schema/ migrations/ seed/  (tables live in named PG schemas)
├── shared/        errors, security, pagination, types, utils
└── jobs/          run by worker.ts, never by the API process
```
