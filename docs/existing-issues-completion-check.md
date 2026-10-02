# Existing issues completion check — 2026-10-02

Decision: keep UDA-10 and UDA-7 open. Do not begin another issue on the basis of automated checks alone.

## Acceptance criteria

| Work | Verified | Still required |
| --- | --- | --- |
| UDA-10 persisted payment reference | MMKV persistence, same key across retry/reopen, customer/kind isolation, discard/success handling, changed amount retains key, truthful timeout/409 recovery copy, no offline queue claim; full Jest passes | Real Android: airplane mode mid-submit and retry yields one receipt; kill mid-submit then reopen yields one receipt; two customers yield separate receipts |
| UDA-7 equipment ledger | Paid issue/existing/replacement produce deduction + RCP; RCP links to receipt; dues unchanged; free visits omit ledger; no-subscription 400; sequential retry and later-write rollback pass | Native PostgreSQL concurrent retry acceptance; full backend suite green; manual paid equipment payment in development checked in account_transactions |
| ₹99,000 cap | Inclusive boundary and rejection above cap for equipment/dues; combined accessories total checked; malformed/non-finite mobile inputs rejected | Device flow as part of payment QA |
| API validation/type/state review | 165 request schema parts / 18 modules / 2,505 probes; operation-specific generated types; reviewed error/state/props regressions pass | These checks do not certify every business input combination or every screen |

## Fresh evidence

- Node v24.19.0.
- Mobile: 58 suites / 457 Jest tests passed; TypeScript and changed-file ESLint passed; generated API snapshot consistency passed.
- Backend: TypeScript, production compilation + alias rewrite, changed-file ESLint and env contract check passed. The env check found 68 documented keys with no unknown settings.
- Fresh SQL serial acceptance run: 5 files / 141 tests passed / 6 excluded. Exclusions: five concurrent payment cases and one inventory rollback case affected by the PGlite protocol adapter.
- The equipment ledger overflow regression originally used an amount above ₹99,000 and therefore accidentally exercised the cap instead of the intermediate ledger-balance guard. Added an exact error-message assertion to demonstrate that coverage failure; then changed initial dues to 9999999999.99 and payment to 0.01. The corrected test passed, including unchanged ledger, receipt, stock, customer and subscription assertions.
- Full backend run with SQL enabled and fail-fast: failed concurrent equipment replay; actual statuses [404,201], expected [201,201]. It reported 17 passed before the first failure. This is not a passing full-suite gate. A detached checkout of the unchanged HEAD was also tried with the same concurrent test; it stalled and was stopped. That comparison does not establish the cause of the 404 or certify concurrency.

## Environment and remaining verification

The restored PGlite 0.5.8 engine uses PostgreSQL 18.3 SQL with PostGIS and pg_trgm. Its multi-connection socket adapter is not native PostgreSQL. PostgreSQL publishes native Ubuntu packages, but this execution sandbox maps only UID/GID 0, prevents switching to an unprivileged database user, and has no Docker. Native concurrent locking cannot be certified here. No adb or Android device/emulator is available.

Run against a dedicated PostgreSQL 18 test database with PostGIS available:

```sh
DATABASE_URL_TEST=postgres://USER:PASSWORD@HOST:5432/cable_test pnpm test
```

The test setup resets application schemas and requires a database name containing `test`; use a dedicated disposable test database. The command must pass without excluding concurrency or rollback tests. Then perform the three UDA-10 scenarios on a real Android build and verify the receipt count and UDA-7 ledger rows in development.

Work is being saved on separate review branches based on the existing feature branches. Linear criteria were fetched read-only; no Done status was set. Equipment refund implementation is UDA-8 and was not started.
