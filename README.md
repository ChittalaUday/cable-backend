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
pnpm dev                      # http://localhost:5000 — docs at /docs
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

## Layout

```
src/
├── server.ts      worker.ts      app.ts
├── config/        env + app-wide constants
├── plugins/       database, auth, tenant, rbac, security, swagger, errors
├── modules/       one folder per resource: routes → controller → service
├── db/            schema/ migrations/ seed/
├── shared/        errors, security, pagination, types, utils
└── jobs/          run by worker.ts, never by the API process
```
