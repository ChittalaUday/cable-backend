# Services, service providers, packages, and where they are sold

Status: **agreed 2026-09-13, being built.** Every open question was settled on
the default (§11). Build order: schema + migration + seed, then services and
providers, then packages, then coverage and availability, then the subscription
check.

---

## 1. What is wrong today

```
services ──< packages ──< package_channels >── channels
   │                                              │
   └──────────────< subscriptions                 └── (channels hang off services too)
```

- **`services.provider_name` is a `text` column.** The seed has a service called
  `ACT Cable TV` whose provider is `ACT Digital`. The brand is baked into the
  service name because there is nowhere else to put it, so "Cable TV" and "who
  supplies it" are one row.
- **A second supplier for the same service means a second service.** Adding
  `Hathway` next to `ACT` duplicates the service, its channels, and every
  report that groups by service.
- **Packages hang off the service.** A price, an MSO share and a channel lineup
  are things a *supplier* sets. Attached to the service, two suppliers' packages
  sit in one undifferentiated list.
- **Nothing knows where a service is sold.** Coverage is real — an ISP serves
  three streets, an MSO serves one apartment complex — and today it lives in
  someone's head, so the add-customer wizard offers packages that cannot be
  installed.

## 2. The model

```
service                 What the subscriber buys: Cable TV, Broadband, IPTV, VoIP
   │                    Tenant-scoped catalogue entry. Carries `service_type`.
   ├──< service_provider The supplier actually delivering it: ACT Digital, Hathway,
   │        │            Satya Fiber, BSNL. A service has many.
   │        │
   │        ├──< package        Price, billing cycle, MSO share, tax — set BY the supplier
   │        │       └──< package_channels >── channel
   │        │
   │        ├──< channel        The supplier's lineup (moves off `service`)
   │        │
   │        └──< service_coverage ──> geo.locations
   │
   └──< service_coverage ──> geo.locations      (provider_id NULL = the whole service)

customer ──< subscription ──> package
                  └────────> service_provider   (denormalised from the package, see §6)
```

Read it as one sentence: **a tenant sells services; each service has suppliers;
each supplier has its own packages and its own coverage of the location tree
(§8.6); a subscription is a customer on one supplier's package.**

## 3. Decisions, and what they rule out

**A provider belongs to exactly one service.** `Airtel Broadband` and
`Airtel IPTV` are two `service_providers` rows that happen to share a name.

> Rejected: a `providers` company table plus a `service_offerings` join. It is
> more correct on paper — one Airtel, two offerings — and it costs a table and a
> join on every catalogue read to express something nothing queries yet. If
> "all Airtel subscribers across services" becomes a real report, add
> `provider_group_id` to `service_providers` then; that is an additive column,
> not a reshape.

**A package belongs to a provider, and only to a provider.** No `service_id` on
`packages` — it is reachable through the provider, and a denormalised copy is
a second truth that goes stale the first time someone re-points a package.

> `ponytail:` "packages for service X" is then a two-table join. That is a
> primary-key join on an indexed column, not a problem. If a dashboard wants it
> flat, that is an `analytics` view (§8.3), not a column.

**Channels move from `service` to `service_provider`.** A channel number and a
lineup are an MSO's, not Cable TV's in the abstract. Two MSOs on the same
service have different lineups and the same channel numbers; hanging both off
the service makes `unique(service_id, channel_number)` a false conflict.

**Coverage is one table, and a row means "here and everything below".** A row
on `Mandapeta` covers every block, floor and door under it — resolved with
`geo.location_ancestors` (§8.6), never by expanding the subtree into rows.

**A coverage row can also say "not here".** `is_available = false` is how a
provider that serves a town but not one apartment complex is expressed.
**Nearest ancestor wins**: the deepest matching row for that provider decides.
Without this, the only way to model a hole is to enumerate every street around
it, which nobody will maintain.

**A row names the narrowest thing it is about.** `service_coverage` rows carry
`service_id` always, `service_provider_id` optionally, and `package_id`
optionally below that:

| Row | Means |
|---|---|
| `(service=Broadband, provider=NULL, package=NULL, node=Mandapeta, true)` | The tenant sells broadband in Mandapeta, whoever supplies it |
| `(service=Broadband, provider=ACT, package=NULL, node=Sri Sai Apts, true)` | ACT specifically reaches this building |
| `(service=Broadband, provider=ACT, package=NULL, node=Block C, false)` | …except Block C |
| `(service=Broadband, provider=ACT, package=4K Tier, node=Block C, false)` | ACT reaches Block C, but does not sell the 4K tier there |

**A list of places means only those places; within a level the nearest ancestor
wins; across levels a parent bounds its children.** All three levels must say
yes, and a level that has named anywhere says no everywhere else. Failing all
three it is available. Each level is edited as its own list, so replacing a
provider's coverage leaves the package rows beneath it alone, and a write that
points a child outside its parent is a 400 rather than a row that can never
resolve (§6).

A service with no coverage rows at all is **available everywhere in the
tenant** — otherwise every existing tenant would go dark the moment this ships,
and a single-town operator would have to configure coverage to sell anything.

## 4. Schema

New, in the existing `crm` schema:

```
crm.service_providers
---------------------
id                uuid pk
tenant_id         uuid → tenancy.tenants          cascade
service_id        uuid → crm.services             cascade

name              text                            'ACT Digital'
slug              text                            unique (tenant_id, service_id, slug)
code              text null                       MSO/ISP operator id, printed on bills

description       text null
contact           jsonb null                      { phone, email, portalUrl, accountManager }
metadata          jsonb null                      operator ids, headend, NOC references

status            text  active | inactive
is_default        boolean                         the one a wizard preselects

created_at / updated_at / deleted_at
```

```
crm.service_coverage
--------------------
id                  uuid pk
tenant_id           uuid → tenancy.tenants        cascade
service_id          uuid → crm.services           cascade
service_provider_id uuid → crm.service_providers  cascade, NULL = the whole service
location_id         uuid → geo.locations          cascade

is_available        boolean  default true         false = a hole in the coverage
note                text null                     "fibre not pulled past Block C yet"

created_by / created_at / updated_at

unique (tenant_id, service_id, service_provider_id, location_id) NULLS NOT DISTINCT
index  (tenant_id, location_id)
index  (tenant_id, service_provider_id)
```

Changed:

| Table | Change |
|---|---|
| `crm.services` | drop `provider_name` (becomes a `service_providers` row) |
| `crm.packages` | `service_id` → `service_provider_id`; slug unique per `(tenant_id, service_provider_id)` |
| `crm.channels` | `service_id` → `service_provider_id`; the two uniques follow it |
| `crm.subscriptions` | `service_id` → `service_provider_id` |

`package_channels` is untouched: a package and its channels now belong to the
same provider by construction, and the service enforces that on insert.

## 5. Answering "what can this customer buy?"

The question the add-customer wizard asks, for a customer at node `A101`:

```sql
-- Every provider whose coverage reaches this node, nearest rule winning.
WITH chain AS (SELECT id, depth FROM geo.location_ancestors($node)),
resolved AS (
  SELECT DISTINCT ON (c.service_id, c.service_provider_id)
         c.service_id, c.service_provider_id, c.is_available
  FROM crm.service_coverage c
  JOIN chain ON chain.id = c.location_id
  WHERE c.tenant_id = $tenant
  ORDER BY c.service_id, c.service_provider_id, chain.depth  -- 0 = the node itself
)
SELECT p.*
FROM crm.service_providers p
LEFT JOIN resolved r_provider
       ON r_provider.service_provider_id = p.id
LEFT JOIN resolved r_service
       ON r_service.service_provider_id IS NULL AND r_service.service_id = p.service_id
WHERE p.tenant_id = $tenant
  AND p.status = 'active'
  AND coalesce(r_service.is_available, true)                            -- §3: unconfigured = everywhere
  AND coalesce(r_provider.is_available, true)                          -- and a parent bounds its children
```

`geo.location_ancestors` returns at most the depth of the tree (five or six
rows), so this stays an index lookup no matter how many doors a tenant has.

**`crm.coverage_allows(tenant, service, provider, package, location)`** is this
rule as one function, and it is the only place it is written down. Four callers
share it: the subscription check, the write-time guard of §6, the location
picker's `GET /locations?coverageServiceId=…`, and this query — which inlines it
only to avoid one recursive CTE per package row.

Resolution, stated once so nobody re-derives it from the SQL:

1. **A list of places means only those places.** Once a level names somewhere it
   sells, it sells nowhere else. "ACT serves Mandapeta" is also "ACT does not
   serve Ravulapalem", without a row per town that ACT has never heard of.
2. **Within a level**, the nearest ancestor row wins. That is what makes a hole
   expressible: `is_available = false` on Block C under a `true` row on
   Mandapeta.
3. **Across levels**, a parent bounds its children — the service's answer, the
   provider's and the package's are ANDed. A service switched off in Block C
   takes every provider and package under it with it, and no provider row can
   hand it back.
4. A level with **no rows**, or with only `false` rows, is not an allowlist: the
   first says nothing, the second is "everywhere except". So a tenant that has
   configured no coverage sells everywhere, and a provider can pull out of one
   block without listing every block it keeps.

Rule 1 is what makes **the same package sellable twice under one provider**:
`Gold Tier` at ₹499 covering the old town and `Gold Tier` at ₹649 covering the
new blocks are two `packages` rows with two coverage lists, and each is offered
only in its own area. Nothing enforces distinct package names — the slug is
derived and disambiguated (`gold-tier`, `gold-tier-2`), and `packages.coverageAreas`
carries the breadcrumbs so a list of two identical names still reads apart.

> Changed 2026-09-14, in two ways. Coverage lists used to be positive-only base
> rows for carve-outs — naming Mandapeta did not exclude anywhere — so a
> per-area package was inexpressible. And the narrowest level used to win, so a
> provider row could sell where its service did not: coverage that read as
> served, resolved as served, and that nobody had set at the level meant to
> govern it. The cost of the second change is that "the service is off here,
> except ACT" is now inexpressible; widen the service and carve the others out.

## 6. Rules the service layer enforces

- **A package's provider is immutable.** Re-pointing a package at another
  supplier silently rewrites what every existing subscriber is on. Deactivate
  and create a new one.
- **A subscription's package must be available at the customer's location.**
  Checked at create, against the customer's terminal node (§8.6). Refused with
  `409 RESOURCE_CONFLICT` naming the provider, not a generic validation error —
  "ACT does not serve Block C" is the thing the operator needs to read.
- **`subscriptions.service_provider_id` is written from the package** at create
  time and never from the client. It is denormalised deliberately: it is the
  supplier as of that day, and it must survive the package being deactivated.
- **A channel added to a package must belong to the same provider.**
- **Deleting a provider with packages, or a package with subscriptions, is
  `409 RESOURCE_IN_USE`** — the same rule the location tree follows.
- Coverage rows point at a location in the same tenant; the service checks it
  rather than trusting the body.

## 7. API

| Method | Path | Permission |
|---|---|---|
| `GET` `POST` `PATCH` `DELETE` | `/services[/:id]` | `services.view` / `services.create` / `.update` / `.delete` |
| `GET` `POST` `PATCH` `DELETE` | `/service-providers[/:id]` `?serviceId=` | same `services.*` keys |
| `GET` `POST` `PATCH` `DELETE` | `/packages[/:id]` `?serviceProviderId=` `?serviceId=` | `packages.*` |
| `GET` `PUT` | `/service-providers/:id/coverage` | `services.view` / `services.update` |
| `GET` `PUT` | `/services/:id/coverage` | `services.view` / `services.update` |
| `GET` `PUT` | `/packages/:id/coverage` | `packages.view` / `packages.update` |
| `GET` | `/locations/:id/available-services` | `services.view` |

`PUT /service-providers/:id/coverage` replaces the whole set for that provider
in one call — coverage is edited as a list in the UI, and a diff of
`POST`/`DELETE` calls is three round trips and a half-applied state.

`GET /locations/:id/available-services` is §5's query: services → providers →
packages, already filtered. One call for the wizard instead of three plus
client-side filtering that will not match the server's rules.

**Reading the catalogue is area-scoped.** `services.view` and `packages.view`
held below `ALL` return only what coverage sells in the holder's granted
subtrees, plus everything nobody bounded — the seed grants both at `LOCATION`
for `staff`, so a collector's picker offers the packages that can actually be
sold at the door they are standing at. An admin at `ALL` still sees the whole
catalogue, which is what configuring it needs. See `coverage.scope.ts` and
`modules/iam/staff-scope.api.test.ts`.

**No new permission keys.** Providers and coverage are catalogue configuration,
which `services.*` already names. `packages.*` stays as it is.

## 8. Migrating what exists

The seed's three services become three services, three providers, and their
packages re-pointed:

| Today | Becomes |
|---|---|
| service `ACT Cable TV` (`provider_name: ACT Digital`) | service `Cable TV` + provider `ACT Digital` |
| service `Satya Fiber Broadband` | service `Broadband` + provider `Satya Fiber` |
| service `Satya Smart IPTV` | service `IPTV` + provider `Satya IPTV` |

Migration steps, each safe against a live table (§8):

1. Create `service_providers` and `service_coverage`.
2. One provider per existing service: `name = coalesce(provider_name, name)`,
   `slug` derived, `is_default = true`.
3. Add `service_provider_id` to `packages`, `channels` and `subscriptions`,
   nullable; backfill from each row's `service_id` through the map above.
4. Set the columns `NOT NULL`, add the FKs and the new uniques.
5. Drop `packages.service_id`, `channels.service_id`,
   `subscriptions.service_id`, `services.provider_name`.

Service *names* (`ACT Cable TV` → `Cable TV`) are a data decision, not a
migration one — see question 4.

`src/db/seed/seed-mso-data.ts` is rewritten in the same change, and the mobile
app's package/service calls change shape with the API (separate repo, separate
PR).

## 9. Deliberately not in v1

**Landed since.** Package-level coverage was on this list; it shipped in
migration `0024` as the `package_id` column described in §3, because an operator
does sell only some tiers in some buildings.

| Left out | Lands as | When |
|---|---|---|
| Per-location pricing | `package_price_overrides(package_id, location_id, price)` | when a tenant actually charges differently by area |
| Provider groups ("all Airtel") | `provider_group_id` on `service_providers` | when a cross-service report needs it |
| Coverage by pincode/polygon | PostGIS on `geo.locations` | if coverage stops matching the operator's own tree |
| `account_transactions.service_id` → provider | the same column swap as `packages` | with billing (§1), when the MSO settlement ledger is actually written to |
| One-provider-per-service-per-customer | a partial unique index on `subscriptions` | see question 3 |

## 10. Implementation slices

| # | Slice | State |
|---|---|---|
| 1 | Schema, migrations `0021`–`0023`, backfill, seed rewrite | **done** |
| 2 | `modules/services` — services + providers CRUD | **done** |
| 3 | `modules/packages` — packages CRUD, channel lineups | **done** |
| 4 | Coverage + `GET /locations/:id/available-services` | **done** |
| 5 | Subscription creation enforcing availability | **blocked** — see below |

**Slice 5 is waiting on a module that does not exist.** There is no
`modules/subscriptions` (nor `modules/customers`), so there is no create path to
enforce anything in. The enforcement itself is built and tested:

```ts
await coverage.isPackageAvailableAt(access, { packageId, locationId });
```

`POST /subscriptions` calls that against the customer's terminal node and
refuses with `409` naming the provider. Until that module is written, nothing
can sell a package into an area its supplier does not reach — because nothing
can sell anything.

### Migrations

| File | Does |
|---|---|
| `0021_windy_cannonball.sql` | Creates `service_providers` and `service_coverage`; adds `service_provider_id` **nullable** to packages, channels, subscriptions |
| `0022_service_provider_backfill.sql` | One provider per existing service (`provider_name` → the provider's name), then points every package, channel and subscription at it. Soft-deleted services get a provider too, or their rows would fail the next step |
| `0023_sad_wild_child.sql` | `NOT NULL`, the new uniques, and drops `service_id` from the three tables plus `services.provider_name` |

Add nullable, backfill, constrain — the §8 rule, one migration each, so any of
them can run against a live table.

## 11. Decisions taken

Settled 2026-09-13; all five on the proposed default.

| # | Question | Decision |
|---|---|---|
| 1 | A provider shared across services? | **No.** One `service_providers` row per service; `Airtel` under two services is two rows. No company table. |
| 2 | Who owns the channel lineup? | **The provider.** `channels` moves off `service`, and `unique(service_provider_id, channel_number)` lets two MSOs both use 101. |
| 3 | Two providers, same service, same address? | **Allowed.** No unique index on `subscriptions`; a second broadband line is a real thing. |
| 4 | Rename the seeded services? | **Yes.** `ACT Cable TV` → `Cable TV`, and the brand becomes the provider row. |
| 5 | Coverage needs approval? | **No.** It is admin configuration behind `services.update`, not field data. |

A provider serves **many** locations: one provider row, one `service_coverage`
row per location, packages defined once (§4). The one-location-per-provider
shape was rejected — it duplicates a supplier and its whole package list per
area, and per-area pricing is `package_price_overrides` when it is needed (§9).
