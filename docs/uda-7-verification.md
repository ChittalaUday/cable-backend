# UDA-7 verification

## Changes

Equipment payments now post a deduction and RCP deposit in the existing database transaction and link the collection to the deposit. The customer's and subscription's dues stay unchanged. Free visits post no ledger rows. Paid visits without a subscription return 400 VALIDATION_FAILED. The response exposes transactionId; the mobile type derives its required nullable transactionId from the backend schema.

Replay reads inside a transaction now use that transaction's connection. A charge balance beyond NUMERIC(12,2)'s range is rejected before stock movement.

## Confirmed checks

- Backend TypeScript, targeted ESLint and git diff --check passed.
- Mobile Jest: 58 suites, 457 tests passed. Mobile TypeScript now passes after schema-derived contracts and dependency/type cleanup.
- Latest targeted backend run on temporary PGlite PostgreSQL 18.3: 141 passed across payments, customers, inventory and request validation; five concurrency cases and one protocol-sensitive fault-injection case excluded.
- Tests cover paid and free issue/existing/replacement modes, deduction/deposit amounts and balances, RCP linkage, serial remarks, sequential replay, no-subscription rejection for staff/admin, transaction rollback, and amount overflow.
- Before the ledger implementation, the targeted tests demonstrated 11 failures and 1 pass. The amount-overflow test separately demonstrated HTTP 500 before the validation fix, then passed.

## Outstanding verification

Native PostgreSQL 18 and Docker are unavailable. PGlite's socket multiplexer differs from native PostgreSQL connection handling. Concurrent runs returned a Collection not found 404 on some responses, including existing subscription/equipment/reversal tests. These failures have not been reproduced on native PostgreSQL, so concurrent acceptance is NOT certified.

The five concurrent tests excluded from the final serial run are:

- takes the money once when the same reference arrives twice at the same moment
- issues equipment once when the same equipment request arrives concurrently
- keeps both payments when two collectors post at the same moment
- replays two concurrent reversal requests instead of unwinding twice
- concurrent retries post one ledger pair and issue stock once

The full backend suite was attempted on PGlite. It reported the failures below and then stalled; it was stopped. Their causes were not fully diagnosed, and the full suite is NOT green. Some PGlite runs also reported an unexpected commandComplete protocol error after database exceptions.

Android QA could not run because no Android device/emulator or adb is available.

Equipment refund behavior remains the separate UDA-8 task. Linear completion status remains unchanged; committing this work does not close the outstanding verification gates.

## Failures observed during the full backend attempt

- `src/modules/payments/payments.api.test.ts` — issues equipment once when the same equipment request arrives concurrently
- `src/modules/payments/payments.api.test.ts` — replays two concurrent reversal requests instead of unwinding twice
- `src/modules/payments/payments.api.test.ts` — concurrent retries post one ledger pair and issue stock once
- `src/modules/auth/tests/auth.flow.test.ts` — refuses a blocked device before issuing anything
- `src/modules/auth/tests/auth.flow.test.ts` — requires the device headers
- `src/modules/auth/tests/auth.flow.test.ts` — carries every active membership and no suspended one
- `src/modules/auth/tests/auth.flow.test.ts` — keeps the two roles of one user apart
- `src/modules/auth/tests/auth.flow.test.ts` — returns a different refresh token each time
- `src/modules/auth/tests/auth.flow.test.ts` — revokes the session when a rotated token is replayed after the retry window
- `src/modules/auth/tests/auth.flow.test.ts` — kills the access token immediately, not at expiry
- `src/modules/auth/tests/auth.flow.test.ts` — leaves another account on the same device signed in
- `src/modules/auth/tests/auth.flow.test.ts` — signs out every device with logout-all
- `src/modules/auth/tests/auth.flow.test.ts` — revokes rather than deletes, so the reason survives
- `src/plugins/tests/cache-invalidation.api.test.ts` — re-filters the customer list the moment an admin moves the engineer to another area
- `src/plugins/tests/cache-invalidation.api.test.ts` — keeps the new page cached until something else moves
- `src/plugins/tests/cache-invalidation.api.test.ts` — shows equipment issued by someone else on the next customer read
- `src/plugins/tests/cache-invalidation.api.test.ts` — re-renders the breadcrumb on a customer row when the area is renamed
- `src/plugins/tests/cache-invalidation.api.test.ts` — re-renders coverageAreas on the package list when the area is renamed
- `src/plugins/tests/cache-invalidation.api.test.ts` — re-counts packages on the services list when a package is added
- `src/plugins/tests/cache-invalidation.api.test.ts` — re-renders the collector name on a receipt when that staff member is renamed
- `src/modules/auth/tests/auth.ratelimit.test.ts` — tells the caller how long the next resend costs, and lengthens it each time
- `src/modules/auth/tests/auth.ratelimit.test.ts` — caps the ladder at five rungs, within the resend_attempts check constraint
- `src/db/schema/tests/integrity.test.ts` — accepts a team of the membership's own tenant, and no team at all
- `src/db/schema/tests/integrity.test.ts` — keeps a team that still has members
- `src/db/schema/tests/integrity.test.ts` — attributes collections only to a member of the same tenant
- `src/db/schema/tests/integrity.test.ts` — allows only one active OTP per identifier and purpose
- `src/db/schema/tests/integrity.test.ts` — lets two providers of one service use the same channel number
- `src/db/schema/tests/integrity.test.ts` — refuses two packages with one slug under the same provider
- `src/db/schema/tests/integrity.test.ts` — deduplicates active physical files by checksum
- `src/modules/auth/tests/auth.hardening.test.ts` — takes comparable time for an unknown account and a wrong password
- `src/modules/auth/tests/auth.hardening.test.ts` — does not look an email up as a phone number
- `src/modules/auth/tests/auth.hardening.test.ts` — still signs in by phone when the identifier really is a phone
- `src/modules/auth/tests/auth.hardening.test.ts` — serves a retry of the consumed token instead of signing the user out
- `src/modules/auth/tests/auth.hardening.test.ts` — does not let repeated retries slide the window forward
- `src/modules/auth/tests/auth.hardening.test.ts` — still treats a replay after the window as theft and kills the session
- `src/modules/auth/tests/auth.hardening.test.ts` — leaves exactly one usable refresh token, and the session intact
