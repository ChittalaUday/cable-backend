# The audit trail

Every change this API makes is recorded in `audit.audit_logs`. This document is
the contract: what a row means, how to add one when you add an endpoint, and
what the build does to stop you forgetting.

The rule in one line: **if a request changes something, it leaves a row.**

## 1. What a row holds

| Column | What goes in it |
|---|---|
| `tenant_id` | The **resolved** tenant (see §4), `null` for pre-sign-in and system events |
| `actor_id` | The user who caused it. `null` when nobody was identified |
| `actor_session_id` | The session, so history survives a revoked session |
| `actor_type` | `user`, `anonymous` (a failed sign-in), or `system` (a job) |
| `action` | `<entity>.<verb>` — `package.updated`, `auth.login.failed` |
| `entity_type` / `entity_id` | What changed. `entity_id` is text, not a UUID column — a failed sign-in files against the identifier that was tried |
| `old_values` / `new_values` | The record before and after, redacted (§5) |
| `changes` | The diff, computed by `auditDiff` when both sides are present |
| `request_id`, `correlation_id`, `ip_address`, `user_agent` | Where it came from |
| `metadata` | Anything action-specific: a reason code, a device id, counts |

`changes` is what people actually read:

```json
{ "price": { "old": "349.00", "new": "399.00" } }
```

## 2. What is recorded today

**Business changes** — one row per mutation, in the service that performs it:

`location_category`, `location_schema`, `location`, `service`,
`service_provider`, `service_coverage`, `package`, `package_channels`,
each with `.created` / `.updated` / `.deleted` as applicable.

Two shapes are deliberate rather than mechanical:

- `location.generated` — a bulk generate writes **one summary row**, not one per
  node. A 2000-node generate would otherwise bury every other change in the
  tenant's trail.
- `service_coverage.updated` and `package_channels.updated` — coverage and
  lineups are replaced as a whole list, so the row holds the whole before and
  after list rather than a per-entry diff.

**Auth events** — recorded on both outcomes, because a refused sign-in is the
event a security review actually looks for:

| Action | Filed against |
|---|---|
| `auth.login.succeeded` | user id |
| `auth.login.failed` | user id, or the raw identifier when no such account exists |
| `auth.otp.requested`, `auth.otp.refused` | phone |
| `auth.otp.verified`, `auth.otp.failed` | user id / phone |
| `auth.token.refreshed` | session id |
| `auth.token.reuse_detected` | session id, plus the device |
| `auth.token.refresh_failed` | session id, with the reason code |
| `auth.logout`, `auth.logout_all` | session id / user id |

`auth.token.reuse_detected` is the one to wake someone for: a rotated refresh
token was replayed, and the session was revoked (§4.6 of AGENTS.md). The row
names the session, because the caller cannot work that out after the fact —
`SessionsService.rotate` takes an `onReuse` callback for exactly this.

**System events** — `storage.cleaned`, written by the nightly job with
`actorType: 'system'`, and only when it actually removed something.

## 3. Adding an audited endpoint

1. Write the service method as normal.
2. Capture the record **before** you change it. Most methods already load it to
   check it exists — assign that instead of discarding it.
3. Call `audit.created` / `audit.updated` / `audit.deleted` with the request's
   audit context.
4. Add the route to `AUDITED_ROUTES` in
   [`src/modules/audit/audited-routes.ts`](../src/modules/audit/audited-routes.ts).
5. Assert the row in a test, the way `audit.trail.test.ts` does.

The context arrives on `access`, so no signature changes are needed:

```ts
class ThingsService {
  async update(access: RequestAccess, id: string, patch: UpdateThingBody) {
    const before = await this.get(access, id);

    await this.db.update(things).set(patch).where(eq(things.id, id));

    const after = await this.get(access, id);
    await audit.updated(this.db, access.audit, {
      entityType: 'thing',
      entityId: id,
      before,
      after,
    });

    return after;
  }
}
```

**Where the audit write goes:**

- If the mutation already runs in a transaction, put the audit insert **inside
  it** and pass `tx` instead of `this.db`. A rolled-back change must not leave a
  log behind.
- Otherwise `await` it immediately after the write.
- Never `.catch(() => {})` it. A silent audit failure is the exact bug this
  system was built to end — the table sat empty for months because the service
  had no callers and nothing said so.

For a job or migration, use `systemAuditContext('job:<name>')` instead of
`access.audit`.

## 4. Tenant and actor

`tenantId` comes from **`request.tenantId`** — the tenant `plugins/tenant.ts`
resolved — not from the `X-Tenant-Id` header. A caller who belongs to exactly
one tenant never sends that header, so reading it directly filed every change
those users made under a null tenant, outside all three tenant-scoped indexes on
the table. `plugins/audit-context.ts` prefers the resolved value and falls back
to the header.

`actorId` on a sign-in route is stamped **after** the fact. The audit context is
built by a `preHandler` hook, before sign-in has identified anybody, so
`AuthService.record` overrides it with whoever the call just authenticated. That
is why a successful login row reads `actor_type: anonymous` with a non-null
`actor_id`.

Never put per-request data on the `AccessContext` object itself. It is cached
per user and tenant for a minute, so a request id or IP stored there would be
replayed onto everyone else's rows. `plugins/rbac.ts` spreads a fresh copy per
request:

```ts
request.access = { ...context, audit: request.auditContext };
```

## 5. Secrets never reach a row

`sanitizeAuditValue` redacts any key whose name looks like a secret —
`password`, `token`, `secret`, `otp`, `codeHash`, `apiKey`, `authorization`,
`cookie`, and friends, matched with punctuation and case stripped. Do not put a
secret in a key that does not look like one, and do not concatenate one into a
message.

## 6. How this stays true

`audit.coverage.test.ts` walks the app's **real route table** and fails if a
`POST`/`PUT`/`PATCH`/`DELETE` is not declared in `AUDITED_ROUTES`, or if a
declared route no longer exists:

```
These routes change something and say nothing about auditing.
Add each to AUDITED_ROUTES with the action it writes, or to
UNAUDITED_ROUTES with the reason it writes nothing.
  → POST /api/v1/packages
```

`UNAUDITED_ROUTES` is the escape hatch and is currently empty. A route that
genuinely records nothing goes there **with the reason**, so the decision is
visible instead of absent.

The map declares intent; it cannot see whether the service behind the route
really calls `audit.*`. That is what the assertions in `audit.trail.test.ts` are
for. A new entry without a test is half the job.

## 7. Reading the trail

There is no HTTP surface for audit logs yet — `AuditService.list` exists and is
tested, but nothing exposes it. Query the table directly:

```sql
SELECT action, entity_id, actor_id, changes, created_at
FROM audit.audit_logs
WHERE tenant_id = $1 AND entity_type = 'package'
ORDER BY created_at DESC, id DESC
LIMIT 50;
```

The three indexes are all tenant-first
(`tenant + created`, `tenant + entity + created`, `tenant + actor + created`),
so lead with `tenant_id` unless you are deliberately scanning system or
pre-sign-in events, which carry `null`.
