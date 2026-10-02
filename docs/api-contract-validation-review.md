# API contract, validation and mobile state review

## Implemented

- Mobile API request, response and query types now derive from the actual Fastify OpenAPI schemas. The checked-in snapshot covers 81 paths; 81 typed HTTP calls use their own operation/status response. UI view models and local form state remain separate from wire data.
- Removed 98 duplicated API type aliases and obsolete pagination utilities. Fixed inventory POST responses incorrectly typed as enriched GET rows, staff leadership sent through an unsupported payload, missing/null fields and enum mismatches.
- Replaced four backend untyped inventory timestamps with ISO date-time schemas. Auth public types derive from response schemas. No explicit production `any` remains in the reviewed mobile API code. `unknown` remains intentionally for untrusted errors and backend opaque JSON metadata; it requires narrowing before use.
- Body validation rejects wrong JSON types and undeclared fields. URL query/path coercion remains deliberate. PATCH does not inject omitted defaults. Intersections permit only fields declared by their combined schemas.
- Bounded inventory money/quantities, pagination and dates/cursors. Payment totals above ₹99,000 reject before writes; mobile rejects non-finite values, exponent/hex notation and more than two decimals.
- Fixed approval response serialization after a successful review and nested proposed catalog changes that could bypass field restrictions. TypeBox partial schemas explicitly disallow additional properties because this library version does not inherit that option.
- Hardened mobile error text so objects cannot become React children. Preserve unresolved payment references/GPS metadata across retry, distinguish ambiguous server failures, guard picker changes while saving, reset stale inventory selections and reopen recharge routes correctly.

## State and props

Reviewed payment/recharge, inventory, customer details and team flows. React Query owns server data; Zustand owns cross-screen recharge drafts and pending payment identity; component state owns local inputs. Reviewed prop chains are shallow. TeamMemberSheet receives a direct teamId from its parent to call the correct team operation. No deep prop drilling was found in these reviewed flows; this is not a certification of every component in the application.

## Verification

- Both repositories: TypeScript passes.
- Mobile full Jest: 58 suites / 457 tests passed.
- Targeted backend: 5 files / 141 tests passed / 6 excluded (five concurrency cases and one rollback protocol-sensitive case).
- All registered request schema parts: 165 across 18 modules, 713 field occurrences, 2,505 invalid-value/default probes. Tests cover primitive types, bounds, formats, enums, array limits and unknown keys. These compiler probes do not replace authenticated business-flow tests.
- Approval regressions first failed with HTTP 500 and an accepted extra field, then both passed after fixes. Full inventory run had 23 passing cases, one failure before the partial-schema fix and one PGlite protocol error; the final targeted run is clean for included cases.
- Generated schema consistency checked with api:check. Refresh with api:sync against the matching backend checkout and configured database; api:generate rebuilds types from the pinned snapshot.

## Limits

Native PostgreSQL and a mobile device/emulator are unavailable. PGlite uses PostgreSQL 18.3 SQL but its socket multiplexer cannot establish native concurrency acceptance. Fault-injection runs have emitted protocol errors. The earlier full backend run failed in auth/cache/integrity/concurrency and stalled; it remains unresolved, not a passing gate. See uda-7-verification.md for recorded failures. Mobile tests exercise components and state with mocked native/network dependencies; actual device flows remain unverified. Publication on a review branch does not imply deployment or completion of the outstanding verification gates.
