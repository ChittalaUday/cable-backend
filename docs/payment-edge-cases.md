# Payment edge cases — open tasks

Every combination the three money endpoints accept, whether each lands in
`crm.account_transactions`, and what is still wrong. Found by reading
`payment.service.ts` and running the payment API tests on 2026-10-01; nothing
here is fixed yet unless its box is ticked.

The endpoints: `POST /payments/subscription`, `POST /payments/equipment`,
`POST /payments/:id/reverse`. Inventory issue and plan switch never move money.

Repos: **BE** = `cable-backend`, **APP** = `cable_mobile_app_react_native`.

## 1. What is recorded correctly today

### Subscription payments

| # | Combination | Ledger rows | Balance |
|---|---|---|---|
| S1 | Pays the full due | `RCP` deposit | down by amount |
| S2 | Pays part of the due | `RCP` deposit | down by amount |
| S3 | Pays more than the due | `RCP` deposit | goes negative (see G6) |
| S4 | Dues + accessories | `ACC` charge + `RCP` deposit | down by dues only |
| S5 | Accessories only | `ACC` + `RCP` | unchanged (see G5) |
| S6 | Nothing paid, reason given | none — correct | unchanged |
| S7 | Nothing paid, no reason | rejected | — |
| S8 | Money but no method | rejected | — |
| S9 | Customer has no subscription | rejected (see G7) | — |
| S10 | Several subscriptions, none named | rejected | — |
| S11 | Same reference replayed | original returned | — |

Methods are cash or UPI only; both behave the same.

### Refunds

| # | Combination | Ledger rows |
|---|---|---|
| R1 | Subscription payment, dues only | `REV` reversal, balance back up |
| R2 | Dues + accessories | `REV` + `ADJ` for the accessories |
| R3 | Accessories only | `REV` + `ADJ` |
| R6 | A refund, or an already-refunded payment | rejected |

### Duplicate protection on the server

All covered by `src/modules/payments/payments.api.test.ts` (11 tests, passing).

| # | Case | Result |
|---|---|---|
| D1 | Same request retried | one receipt, replayed |
| D2 | Same request twice at the same moment | one payment |
| D3 | Same reference, changed payload | rejected (409) |
| D4 | Same request, fields reordered | treated as the same |
| D5 | Reference used by another collector | rejected (409) |
| D6 | Refund retried or concurrent | refunded once |
| D7 | Same serial under different references | issued once |

This only works while the app sends the **same** reference again — see D8–D10.

## 2. Tasks

Ordered by how much money or trust each one can cost.

### Ledger gaps

- [ ] **G1 · BE — Paid equipment payments write no transaction.**
  New unit (E1), existing unit (E3) and replacement (E5) all save the
  collection with `transaction_id: null` (`payment.service.ts`,
  `recordEquipmentCollectionRow`). Post an `RCP` deposit when the amount is
  above zero, as `postLedger` does for subscriptions.
- [ ] **G2 · BE — Decide what an equipment payment posts against when the
  customer has no subscription (E7).** The ledger needs a `service_id` and a
  `service_account_number`. **Needs a product decision before G1 can cover it.**
- [ ] **G3 · BE — Refunding an equipment payment (R4) writes no transaction and
  leaves the unit with the customer.** `unpostTakings` returns early when the
  original has no subscription.
- [ ] **G4 · BE — A "nothing paid" visit can be refunded (R5).** Creates an
  empty refund row. Reject it.

### Duplicate payments (no reliable live updates)

- [ ] **D8 · APP — A timeout followed by reopening the customer makes a second
  payment.** `collect-payment.tsx` creates the reference in a `useRef`, so a
  new screen means a new reference. The error dialog also says "Nothing was
  taken off the account", which is false on a timeout.
  - Keep the in-flight reference per customer in MMKV until success or an
    explicit cancel.
  - On a network error, say it may have been recorded and point at Receipts.
- [ ] **D9 · APP — App killed, crashed or restarted mid-save loses the
  reference.** Fixed by the same MMKV change as D8.
- [ ] **D10 · APP — Re-entering the recharge flow always mints a new
  reference.** `use-recharge-store.ts` `begin()`; the store is memory only.
- [ ] **D11 · BE + APP — Two people collecting from the same customer both
  succeed, and nobody is warned.** Allowed on purpose for genuine split
  payments (test "keeps both payments when two collectors post at the same
  moment"), but there is no guard against a real double collection.
  - BE: same customer paid again within a few minutes → require a confirm flag.
  - APP: refetch customer data on app resume and screen focus; React Query's
    `focusManager` is not wired to `AppState`.
  - The silent `sync: payments` push is best-effort only: iOS throttles it and
    a killed app never sees it.
- [ ] **APP — Remove the "queued offline receipt" claim** in
  `use-payments.ts`; no offline queue exists.

### Data integrity

- [ ] **G8 · BE — Accessory price is whatever the collector types** (0 is
  accepted); the catalogue price is not enforced, and selling an accessory
  does not reduce stock.
- [ ] **G9 · BE — `collectedAt` accepts any date, past or future**, and the
  ledger uses it. Bound it (e.g. not in the future, not before the last
  settled day).
- [ ] **G10 · BE — A refund's `balanceAfter` is computed from the original
  receipt**, so it is wrong once other payments happened in between.
- [ ] **G11 · BE — A replacement chosen by unit id is not checked against the
  old unit's catalogue item** (a set-top box can be "replaced" by a router).
- [ ] **G12 · BE — Equipment already replaced or returned can be replaced
  again**; the assignment's status is not checked.
- [ ] **G13 · BE — Equipment payments attach to the customer's first reachable
  subscription**; the request cannot name one.

### Behaviour and wording

- [ ] **G5 · BE — An accessories-only sale is labelled "partial"** whenever the
  customer has dues.
- [ ] **G6 · BE — Paying more than the due is not marked as credit**; it reads
  as an ordinary "full" payment.
- [ ] **G7 · BE — A customer with no subscription cannot pay for anything**,
  accessories included.
- [ ] **G14 · BE — Staff get "not found" recording equipment for a customer
  with no subscription; admins can.** Make the two agree.
- [ ] **G15 · BE — Only full refunds, and only with `payments.update` at ALL**,
  so a collector cannot correct their own mistake.
- [ ] **G16 · BE — Nothing ever adds the monthly charge.** Balances only go
  down, so duplicates and overpayments drift negative with nothing to pull
  them back. Decide whether overpaying needs an explicit "advance" choice.
- [ ] **R7 · BE — A payment cannot be refunded once its subscription is
  deleted.**
- [ ] **BE — Equipment receipts show "due" equal to the amount paid and
  "balance after" as 0** (cosmetic).

## 3. Related, found the same day

- [ ] **BE — Three NCB stock movements pointed at SSCN equipment** in the local
  database. Only possible if something writes a movement against another
  tenant's unit; check whether that is app code or a test leak.
