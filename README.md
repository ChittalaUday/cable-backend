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
| `pnpm test` | Vitest. Database tests need Docker (Testcontainers). |

Unit tests run without Docker. Database-backed tests need it, or
`DATABASE_URL_TEST` pointing at an existing PostgreSQL 18.

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
