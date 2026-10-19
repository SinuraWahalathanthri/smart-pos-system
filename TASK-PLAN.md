# TASK-PLAN.md - Completing the Spice Shop POS

> **Status: PROPOSAL - awaiting approval. No implementation work has begun under this plan.**

Scope: take the project from "till works, in a demo sense" to a system that can run a real
VAT-registered spice shop with 1-3 staff on opening day, and not embarrass itself in month three.

---

## 0. Honest baseline (verified, not assumed)

| Area | Reality today | Evidence |
|---|---|---|
| Routes | 3 only: `/`, `/login`, `/pos`. **No back office whatsoever.** | `app/**/page.tsx` |
| Till checkout | Works: grid, pack sizes, scan, bill, payments, hold/recall, calculator | `components/pos/` |
| Sale persistence | `recordSale()` writes the sale **and decrements `products.stock` in place** | `lib/data/db.ts:87-113` |
| LDD kit | 12 modules, 2,753 lines, 52 tests, **not wired into the app** | `lib/ldd/` |
| Offline sync | Queue + `complete_sale()` RPC + catalogue pull | `lib/sync/engine.ts` |
| Database | Supabase/Postgres, 17 tables, 22 RLS policies, RPC write gateway | `supabase/migrations/` |
| Overrides | Badge+PIN, lockout, audit log (server side) | `0003_functions.sql` |
| Inventory UI | **None.** Ledger exists in SQL only | - |
| Shifts / cash | **None.** No drawer reconciliation possible | - |
| Refunds | **None.** `pay_method` allows credit but the RPC refuses it | - |
| Receipts | **None** (no print, no PDF) | - |
| Back office | **None** (dashboard, products, staff, reports, PO) | - |
| Production | **None** | - |
| Tests | 121 passing (69 app + 52 LDD) | `npm test` |
| CI / PWA / e2e | **None of the three** | `Test-Path` checks |
| Type/lint/build | tsc 0, eslint 0, build OK | verified |

**Blunt summary:** the checkout screen is genuinely good. Everything behind it that lets a shop
actually operate - catalogue management, stock, shifts, refunds, receipts, reports - does not exist.
Roughly 20% of a usable product is built, and it is the most visible 20%.

---

## 0a. Verification report (v2)

The plan was reviewed against the code and every technical claim was executed, not assumed.
**Six defects were found, including two security holes in the LDD kit that the v1 plan overstated
as guarantees.** Full detail below; the register and phases are amended accordingly.

### Corrected claims from v1

| v1 claim | Verdict | Correction |
|---|---|---|
| "Hash chain intact" is a trust guarantee | **Overstated** | It is tamper-*evidence* only. See BUG-1 and BUG-2. |
| `stock.balance` invariant is a placeholder | **Confirmed** | Returns `[]` unconditionally (`invariants.ts`). |
| `recordSale()` mutates stock directly | **Confirmed** | `db.ts:95-105`. |
| LDD kit is not wired into the app | **Confirmed** | Zero imports from `lib/ldd` in `app/`, `components/`, or `lib/`. |
| 121 tests passing | **Confirmed** | 69 app + 52 LDD. |
| Plan assumed backfill of demo sales | **Incomplete** | Needs ordering discipline; see GAP-5. |

### Bugs found in the LDD kit

**BUG-1 - Critical - A fully re-chained rewrite is undetectable.**
`verify()` re-derives each hash from the stored payload and compares. An attacker with write access
recomputes every hash after altering an event, and verification passes. **Executed and confirmed:
`ok: true, problems: 0` on a tampered ledger.**

```
forged event 2 payload -> recompute hash(2) -> recompute hash(3) with prevHash=hash(2)
verify() -> ok
```

Consequence: the chain proves *internal consistency*, not *authenticity*. For a system holding cash
and credit records this must not be described as protection against a determined insider.

**BUG-2 - High - Truncation at the head is undetectable.**
Deleting the most recent events leaves a shorter but perfectly valid chain. **Executed and confirmed:
`ok: true, checked: 2` after the newest event was deleted.** A cashier could delete their last sales.
An in-app `verify()` cannot distinguish "3 events exist" from "3 events were written, 1 removed".

**BUG-3 - High - S2/S3 are silently skipped for unregistered commands.**
`engine.execute()` does `const spec = specFor(cmd.type); if (spec) { ... }`. Any registered event
type without a spec runs with **no preconditions and no postconditions**, falling back to the global
suite only. The discipline degrades silently and invisibly as the vocabulary grows (K1 adds 11 types;
none have specs today).

**BUG-4 - Medium - `tenderedCents` is never a precondition.**
Cash covering the bill is only a global invariant, which is evaluated *after* the event is appended.
In an append-only ledger that cannot be rolled back, so an under-tendered sale enters the ledger and
is merely reported afterwards. The plan's wording "preconditions abort the command" is true only for
the four fields that were actually written as preconditions.

**BUG-5 - Medium - Bottle accounting keys off the product *name* substring.**
`pos-reducer.ts`: `base.products[l.productId]?.name.includes("Milk")`. A product called "Coconut Milk"
accrues returnable bottles it never had; renaming a product silently stops the accrual. The domain
already has the correct attribute - `is_returnable_bottle` in `pos_db.html` - and the kit does not use it.

**BUG-6 - Low - Supervisor lockout is client-local and bypassable.**
`lib/data/auth.ts` keeps the 3-strike counter in `localStorage`. Clearing storage, using a second
browser, or a private window resets it. The server-side `verify_supervisor()` holds the authoritative
counter, so this is defence-in-depth only - but it must not be presented to the shop as a real control.

### Gaps found in the plan itself

**GAP-1 - Critical - Multi-writer streams are unaddressed.**
`append()` derives `seq` from `head(stream)`. The kit assumes a single writer per stream. Two tills
offline on the same `store:<uuid>` stream will each produce seq 1..N independently; on sync those
events collide on the same seq with different content. `ConflictError` detects the clash but offers
no resolution. **A shop with a second till - explicitly in scope - breaks the model.** This needs a
decision (one stream per device, or per device-epoch) and it belongs in Phase 1, not later.

**GAP-2 - The plan never says how the projection relates to Supabase.**
Phase 1.4 says "read stock from the projection", but the app also caches `products` in Dexie and pulls
the catalogue from Supabase. Three sources of truth would replace one. Needs an explicit rule.

**GAP-3 - `pos_db.html` (50 tables) vs Postgres (17 tables) has no reconciliation.**
The plan says "port the modelling improvements" without listing which tables land in which phase,
or which of the 50 are out of scope for v1.

**GAP-4 - Hardcoded settings are not scheduled anywhere.**
`lib/config.ts` holds `SHOP_NAME`, `CASHIER_DISCOUNT_LIMIT_PCT = 5`, `PACK_LOW_STOCK = 3`,
`ALLOW_SELL_OUT_OF_STOCK`. `pos_db.html` models these as `store_settings`. No task covers it, yet
Phase 3.6 (staff) and 3.3 (products) both depend on the discount limit being configurable.

**GAP-5 - Backfill ordering is not specified.** The reducer *throws* on duplicate receipt numbers
and on a product registered twice. Importing existing Dexie sales without replaying catalogue first
will abort.

**GAP-6 - Missing operational scope:** product image upload (Storage), backup *restore drill*
(not just backup), error monitoring, and an explicit data-retention/archive rule for the ledger.

---

## 0b. GATE-5 (new, blocking): `pos_db.html` and `0001_core.sql` are two different schemas

Discovered while executing the build, not by reading. This is the most important finding of the
session and it blocks migration work.

**What was attempted.** Parse `pos_db.html` (the stated source of truth) into a model, generate
Postgres DDL from it, and validate that DDL on a real engine.

**What happened.**

1. The generator works. `tools/design-doc.ts` parses **50 tables / 11 categories / 484 columns /
   20 enums**; `tools/ddl.ts` resolves **123 FKs with 0 ambiguous, 0 unresolved**; `npm run db:plan`
   emits 44 KB of DDL.
2. That DDL **executes cleanly on Postgres** (PGlite, 9/9 assertions): all 50 tables, all 484
   columns, enum enforcement, FK enforcement, 1:1 settings rows, unsigned CHECKs all verified.
   Two real generator bugs were found and fixed this way: the authored table order had forward
   references (needed topological sorting), and unsigned CHECKs were skipped on PK columns.
3. **Then it was applied alongside `0001`–`0004` and failed**, because `0001_core.sql` already
   creates 17 of the same tables with a **different shape**.

**The actual conflict.**

| | `0001_core.sql` (live, applied, app targets it) | `pos_db.html` → `0005` (design doc) |
|---|---|---|
| Tables | 17 | 50 |
| Shared table names | 14 | 14 |
| Columns only in 0001 | **41** | — |
| Columns only in design doc | — | **69** |
| Primary keys | surrogate `id uuid` | natural `store_id`, `sale_id`, `product_batch_id`… |
| Money | `_cents` integers | mixed `_cents` + `numeric` |
| Discounts | `max_cashier_discount_pct` | `max_cashier_discount_bp` (basis points) |
| Enums | `text` + CHECK | 20 native enum types |
| RLS policies | 22, written against 0001's columns | none |
| SQL functions | 9, written against 0001's columns | none |

**Why this cannot be papered over.** All three middle layers are bound to `0001`:

- `lib/sync/mappers.ts` → `toSalePayload` feeds `complete_sale(jsonb)`.
- `0003_functions.sql` → `complete_sale`, `adjust_stock`, `archive_product`, `consume_approval`
  read and write `sales.id`, `products.stock_on_hand`, `stock_movements.type`.
- `0004_till_auth.sql` → `verify_staff_pin`, `check_badge`, `verify_supervisor` read
  `profiles.id`. The design doc has no `profiles`; it has `staff` + `staff_credentials`.
- `0002_rls.sql` → 22 policies naming columns that do not exist in the design doc.

So switching the live schema to the design doc means rewriting 41→69 column mappings, 9 functions,
22 policies, and 4 RPC call sites (`verify_staff_pin`, `check_badge`, `verify_supervisor`,
`get_till_context`, `complete_sale`) — plus 149 tests including 34 that execute the real migrations.
That is a multi-day rewrite of the middle of a working application, and it buys 36 new tables for
suppliers, purchasing, production, shifts, and stock takes.

**What I did NOT do.** I did not overwrite `0001`–`0004`, and I did not leave `0005` where it would
break `database.test.ts`. The generated schema now lives at `supabase/design/0005_core_schema.sql`
and is validated by `tests/schema.test.ts`. The suite is green: **149 passed (149), 8 files**.
`npm run db:plan` regenerates the design schema on demand.

**The decision needed from the owner.**

| Option | Work | Result |
|---|---|---|
| **A. Extend `0001` incrementally** (recommended) | Add the 36 missing tables in new migrations `0005`+, in `0001`'s conventions (`id uuid`, `_cents`). Leave the 14 working tables alone. | Working app stays working; all 50 tables exist; no rewrite of functions/RLS/tests. Design doc's natural keys and `_bp` units are **not** adopted. |
| **B. Adopt `pos_db.html` fully** | Rewrite `0001`–`0004`, all 9 functions, 22 policies, `mappers.ts`, 5 RPC call sites, 149 tests. Ship a destructive migration. | Exactly the design doc, including 20 enums and natural keys. Multi-day, high regression risk, no user-visible gain for the shop today. |
| **C. Hybrid** | Extend `0001` with the 36 tables, but adopt design-doc conventions for **new** tables only. | Two conventions coexist (some `id`, some `store_id`). Works, but the codebase gets harder to reason about. |

My recommendation is **A**. The design doc is a modelling exercise; `0001` is what the app, the RLS,
and the tested functions already agree on. The 36 new tables are genuinely additive — suppliers,
purchase orders, production runs, stock takes, shifts, cash movements — and none of them need the
existing 14 tables reshaped. Portability to MariaDB is preserved either way, because the generator
already emits both dialects from one model.

**RESOLVED: Option A, chosen by the owner.** Implemented and verified.
Delivered in `supabase/migrations/0005_operations.sql` + `0006_operations_rls.sql`: **25 new tables**
(devices, suppliers, purchase orders, goods receipts, customers, credit entries, shifts, cash
movements, refunds, production runs, stock takes, batch allocations, weight labels, price history,
daily rollup, monthly summaries, roles/permissions). The 14 tables owned by `0001` are **untouched**;
the suite went from 149 to **169 passing**, including the 34 that execute the real migration chain.
Deviations from `pos_db.html`, each a deliberate decision recorded in the 0005 header:
| Design doc | Live schema | Why |
|---|---|---|
| `staff`, `staff_credentials`, `store_memberships` | `profiles` | 0001 already holds staff, PIN/badge hashes, lockout and role |
| `audit_log` (singular) | `audit_logs` | already exists |
| `store_settings` | `stores` columns + `settings` k/v | splitting the same values across two places invites drift |
| `stock_move_types`, `bottle_event_types`, `payment_methods`, `notification_types`, `tax_classes` | existing enums / `tax_rate_pct` | lookup tables would duplicate the enums and force a rewrite of every 0003 function |
| `receipt_sequences` | `receipt_no_seq` | receipts are numbered globally |
| natural keys (`sale_id`, `product_id`ΓÇª) | surrogate `id` | 0001's convention; the app and its FKs already use it |
Two modelling bugs in the design doc that were avoided rather than copied:
- `daily_sales_rollup` had a composite PK including `pack_size_id`; a unit product with no pack size
  makes that column NULL and the whole row uninsertable. It now has a surrogate key, and a test
  inserts three rows for one product on one day to prove it.
- `refund_lines.condition` is a reserved word in several engines; the column is `item_condition`.
Original recommendation for the record:

---

## GATE-1. The blocking decision: Postgres or MariaDB?

`pos_db.html` specifies a 50-table **MariaDB** schema. The running application is
**Supabase/Postgres**. These are not compatible, and DDL cannot be written until this is settled,
because the two paths differ in ways that change the code above them:

| | Keep Supabase/Postgres (recommended) | Migrate to MariaDB |
|---|---|---|
| RLS tenant isolation | Already built, 22 policies, working | **Must be rebuilt outside the database** |
| `complete_sale()` gateway | Working, tested | Rewrite as stored procedure + service tier |
| Offline sync engine | Working, tested | Rewrite the transport |
| `jsonb` audit payloads | Native | `JSON` only, no GIN |
| `timestamptz` | Native | `DATETIME(3)`; `TIMESTAMP` dies 2038 |
| Hosting cost | Supabase Pro ~US$25/mo | Own VPS + backups + patching |
| Work already sunk | Preserved | Discarded and redone |
| BCNF improvements from `pos_db.html` | **Still applicable as a Postgres migration** | Applicable |

**Recommendation: keep Postgres, and port the *modelling* improvements from `pos_db.html` into
Postgres migrations.** The valuable content of that document is the BCNF analysis and the 50-table
decomposition (shifts, purchasing, production, approvals, batches), not the MariaDB dialect.
This preserves working RLS and the sync path, and still fixes the schema problems.

- [ ] **GATE-1a** Owner confirms: Postgres (recommended) or MariaDB.
- [ ] **GATE-1b** If MariaDB: new decision on the tenant-isolation model (three options in `pos_db.html` S1).

> Everything below assumes **Postgres**. If GATE-1a chooses MariaDB, Phases 1-2 change and the
> rest survives unchanged, because the LDD layer is storage-agnostic by design.

---

## GATE-2. Two product questions that change the schema

- [ ] **GATE-2a** Late bottle returns: is `fee_refunded` a real event, and within what window?
      (Still open in `PLAN.md`. Changes `bottle_event_types` and the invariant suite.)
- [ ] **GATE-2b** Can a credit sale be written while offline? If yes, a credit limit can be briefly
      exceeded and the invariant must be a *warning*, not an *error*. If no, the till must refuse it.

Neither blocks Phase 1.

---

## GATE-4. How many tills, now and later?

Discovered during verification (GAP-1/KF7). The ledger's `append()` assumes **one writer per stream**.
Two devices writing the same `store:<uuid>` stream offline will both produce seq 1..N and collide on
sync, with no resolution path.

- [ ] **GATE-4a** Will the shop run more than one till within 12 months?
- [ ] **GATE-4b** If yes: streams become `device:<uuid>` (independent chains, merged in the
      projection), or a per-device ordinal composed into a store-wide order. This changes every
      `stream` string in the codebase, so it must be decided **before** Phase 1 ships.

If the answer is "one till, forever", the current model is fine and KF7 reduces to a documented
limit plus a guard that refuses a second device id on the same store stream.

---

## 1. Definition of done

The project is complete when all of the following are true. These are the acceptance tests for the
whole engagement, not aspirations.

**Money and trust**
1. No code path can change stock except by appending a ledger event. Enforced by test.
2. `npm run ldd` audits a real ledger: hash chain intact, **anchor matches**, all invariants hold,
   replay digest stable. (v1 said only "chain intact" - that alone is insufficient; see BUG-1.)
3. Every privileged action (void, refund, discount over limit, price override, stock adjust,
   product archive) requires supervisor badge+PIN and produces an audit row with both actors.
4. A sale's total, tax and change are derived, never stored twice. Recomputing them from lines
   matches the posted figure for every sale in the database.

**Operations**
5. A cashier can open a shift with a float, sell, and close with a counted drawer; the variance is
   recorded and reportable.
6. A refund can be issued against any past sale, for part of a line, with the goods optionally
   returned to sellable stock or written off as damaged.
7. A receipt can be produced on screen, printed at 80mm, and downloaded as PDF.
8. The owner can add, edit, price, and archive products without touching SQL.
9. Stock can be received, adjusted and counted from the UI; every change is a ledger movement with
   a reason and an actor.

**Continuity**
10. The till sells with the network unplugged, and syncs without duplicate or lost bills.
11. A bill written offline at 18:40 keeps its business timestamp after sync.
12. CI runs typecheck, lint, unit tests, LDD audit and the full build on every push; all green.

**Legal**
13. A month-end report produces gross/net sales, output VAT, input VAT, VAT payable, COGS and
    gross profit, and is exportable.

---

## 2. Phase plan

Each phase is independently shippable and leaves the project runnable. Task IDs are stable for
reference; estimates are for planning conversation, not commitments.

### Phase 1 - Make the ledger the only truth (foundation)

**Why first:** until `recordSale()` stops mutating `products.stock`, every later feature inherits a
lie. This is the one phase that cannot be deferred.

| ID | Task | Est |
|---|---|---|
| 1.1 | Extend LDD event vocabulary to cover the full till (see S4 register) | M |
| 1.2 | Add projection **snapshots** so replay stays fast as the ledger grows | S |
| 1.3 | Replace `recordSale()` with `engine.sell(...)`; delete direct stock mutation | M |
| 1.4 | Read stock from the projection, not `products.stock`, throughout `PosScreen` | M |
| 1.5 | Migrate existing Dexie sales into the ledger (one-time backfill, idempotent) | M |
| 1.6 | Approval tokens as first-class events, single-use and expiring | M |
| 1.7 | Wire `npm run ldd` audit into CI | S |
| 1.8 | **Fix KF1-KF8** (verification defects). KF1 and KF7 are critical and gate the phase. | M |
| 1.9 | Decide and implement the **stream model** (KF7): `device:` vs `store:` streams | M |
| 1.10 | Ship `store_settings` so `lib/config.ts` constants become rows (GAP-4) | S |
| 1.11 | Backfill ordering: catalogue -> prices -> receipts -> sales -> voids (GAP-5) | M |

**Acceptance:** `grep` finds no assignment to `products.stock` or `packSizes[].stock` outside the
LDD reducer. A sale written before migration still reads back identically after it. **A tampered
ledger fails `verify()` against an anchor** (KF1 test), and **an event type with no spec refuses to
append** (KF3 test).

**Corrected acceptance for v1:** the original wording claimed "hash chain intact" proves integrity.
That was too strong. The phase is not done until an anchor makes BUG-1 and BUG-2 detectable.

**Risk:** the backfill of existing demo sales could double-count. Mitigation: derive each historical
sale's `commandId` from its existing `sale_id`, so replay is idempotent by construction.

---

### Phase 2 - Shift, cash and receipts

**Why second:** the moment there are two staff or two days of trading, unaccounted cash is the
biggest financial exposure. Receipts are the legal artefact.

| ID | Task | Est |
|---|---|---|
| 2.1 | Shift open/close: float, counted cash, generated variance | M |
| 2.2 | Cash movements: float in, cash in/out, bank drop, petty cash | S |
| 2.3 | Z-report and X-report per shift | M |
| 2.4 | Receipt rendering: on-screen, 80mm print CSS, PDF | M |
| 2.5 | Gapless per-device receipt numbering (sequence allocated in the sale transaction) | M |
| 2.6 | Refund flow: partial line, restock or write-off, supervisor approval | M |

**Acceptance:** open a shift, sell, void, refund, close; the reported variance equals counted minus
expected to the cent. Receipt numbers have no gaps within a device.

**Note on 2.5:** an offline till that consumes a number it later cannot use forces a choice between
gaps and burned numbers. Recommend **per-device series with an explicit `voided_receipt_no` marker**
so the gap is explained on the report rather than silently missing. Needs sign-off (GATE-3).

---

### Phase 3 - Back office (the missing 80%)

| ID | Task | Est |
|---|---|---|
| 3.1 | Admin shell: layout, nav, owner-only guard | M |
| 3.2 | Dashboard: today, 30-day trend, top movers, low stock, voids today | M |
| 3.3 | Product CRUD: create, edit, price, pack sizes, barcodes, images, archive | L |
| 3.4 | Category management | S |
| 3.5 | Stock screens: receive, adjust, stock take with variance posting | L |
| 3.6 | Staff management: create, assign role, set PIN, reset, deactivate | M |
| 3.7 | Suppliers and purchase orders | L |
| 3.8 | Sales browser: find any bill, view, reprint, void, refund | M |
| 3.9 | Audit log viewer with filters | S |
| 3.10 | **Schema reconciliation** (GAP-3): map the 50 tables in `pos_db.html` to Postgres phases; list what is v1, what is deferred, what is rejected | M |
| 3.11 | Store settings screen: shop name, VAT rate, discount limit, low-stock threshold (GAP-4) | S |

**Acceptance:** the owner can run a full trading day - add a product, receive stock, correct a count,
hire a cashier, look up a bill, reprint it - without SQL and without a developer.

---

### Phase 4 - Production (the spice side)

| ID | Task | Est |
|---|---|---|
| 4.1 | Production run: raw issue, drying/grinding stages, packing output | L |
| 4.2 | Yield and loss calculation; cost per pack roll-up | M |
| 4.3 | Batch creation and FEFO consumption at the till | M |
| 4.4 | Expiry alerts from real batch data | S |

**Acceptance:** a chilli run converts 20 kg raw into N packs, records yield %, and the resulting
cost per pack propagates to margin reports. Batches expire and warn.

---

### Phase 5 - Customers, credit, purchasing, analytics

| ID | Task | Est |
|---|---|---|
| 5.1 | Customer records and attach-to-sale | S |
| 5.2 | Credit ledger: invoice, settle, ageing (pending GATE-2b) | M |
| 5.3 | Goods receiving against a PO, input VAT captured | L |
| 5.4 | Alerts: in-app bell, notification rows, dedupe | M |
| 5.5 | Analytics: velocity, ABC, dead stock, days of cover | M |
| 5.6 | Forecast and reorder suggestion (28-day WMA + safety stock) | M |
| 5.7 | Monthly summary and tax report | M |

---

### Phase 6 - Hardening and delivery

| ID | Task | Est |
|---|---|---|
| 6.1 | PWA: manifest, service worker, offline shell, install prompt | M |
| 6.2 | Playwright e2e: sell, void, refund, offline-then-sync, shift close | L |
| 6.3 | CI: typecheck, lint, unit, LDD audit, build, e2e | M |
| 6.4 | Backup and restore runbook, tested once | S |
| 6.5 | Deployment, environment config, error monitoring | M |
| 6.6 | Operator handbook: open, sell, void, close, recover | M |

---

## 3. Suggested sequencing

```
GATE-1 ──▶ Phase 1 ──▶ Phase 2 ──▶ Phase 3 ──▶ Phase 6 (PWA + CI)
                │                      │
                └────▶ Phase 4 ────────┴──▶ Phase 5
```

Phase 1 blocks everything. Phase 2 and 3 are the two "a shop can open" gates. Phase 4 and 5 are
value, not viability - they can ship after the shop is live. Phase 6 items 6.1 and 6.3 should be
pulled forward if the shop opens before Phase 5 completes.

**Recommended first release:** Phases 1, 2, 3, then 6.1+6.3. That is a shop that can trade, count
its cash, print receipts, manage its catalogue, and recover from a power cut. Phases 4 and 5 follow.

---

## 4. LDD kit change register

The kit is sound but scoped to a single bill. Completing the project needs the following additions.
This register is the "update the kit where you need to" list.

| # | Module | Change | Reason |
|---|---|---|---|
| K1 | `pos-events.ts` | Add `shift.opened`, `shift.closed`, `cash.moved`, `approval.granted`, `approval.consumed`, `customer.registered`, `credit.settled`, `stock.wasted`, `production.started`, `production.closed`, `price.overridden` | These are business facts with no event type today |
| K2 | `pos-reducer.ts` | Handlers for K1; shift state; customer balances | Totality rule: an unhandled type must throw |
| K3 | `pos-reducer.ts` | `stock` becomes batch-aware (consume FEFO) | Phase 4 needs per-batch remaining |
| K4 | `invariants.ts` | `shift.cash-reconciles`, `approval.single-use`, `approval.unexpired`, `credit.within-limit` (warning if GATE-2b is "yes"), `receipt.gapless` | New invariants for new facts |
| K5 | `statements.ts` | Specs for every K1 command (S2/S3) | Discipline must extend, not lapse |
| K6 | **new** `snapshots.ts` | Periodic projection snapshots + `replay(toSeq)` | Linear replay becomes slow past ~100k events |
| K7 | **new** `approvals.ts` | Mint/consume single-use expiring tokens bound to device+permission | Implements the `approvals` table semantics in the client |
| K8 | `engine.ts` | Require a consumed approval token for privileged commands | Makes K7 enforceable rather than advisory |
| K9 | `engine.ts` | `executeMany` in one store transaction | Shift close must be atomic |
| K10 | **new** `versioning.ts` | Upcasting for event schema changes (`version` field exists, unused) | The ledger outlives the code; a v1 event must stay readable after v2 ships |
| K11 | `explain.ts` | Explain by receipt number, by shift, by customer | Operators ask "why is this bill wrong", not "why is this key wrong" |
| K12 | `dexie-store.ts` | Add `stream` + `type` compound index for audit queries | Phase 3.9 and 5.5 read by type and date range |
| K13 | `tests/ldd` | Property test: random command sequences never break an invariant OR always throw | Catches the sequences humans do not think of |
| K14 | `invariants.ts` | `stock.totals-match-operations` actually implemented (currently returns `[]`) | It is currently a placeholder, and a placeholder invariant is worse than none because it looks enforced |

**K14 deserves emphasis.** `stock.balance` in the current suite is declared an error-severity
invariant but returns an empty array unconditionally. That is a green light that means nothing.
Either implement it against an independently computed total, or delete it. Recommend implement.

### Kit defects to fix (from the verification report)

These are bug fixes, not features. They ship inside Phase 1 because they invalidate the guarantees
the rest of the plan leans on.

| # | Module | Fix | Priority |
|---|---|---|---|
| **KF1** | `ledger.ts`, `verify()` | Add an **external anchor**: persist `{stream, seq, headHash}` at a known-good point (print it on the Z-report, log it to the audit table, email it weekly). `verify(stream, {expectSeq, expectHeadHash})` compares against it. Detects BUG-1 and BUG-2. | **Critical** |
| **KF2** | `verify()` | Add `expectLength`; report `truncated` explicitly when `checked < expectSeq`. | High |
| **KF3** | `engine.ts` | Make specs **mandatory**: `specFor` returning `undefined` becomes a hard error at registration time, not a silent skip. A new event type cannot be appended until its S2/S3 exist. | High |
| **KF4** | `statements.ts` | Promote `tenderedCents >= total` into `completeSaleSpec.preconditions`, where it can abort. | Medium |
| **KF5** | `pos-events.ts`, `pos-reducer.ts` | Replace the `name.includes("Milk")` heuristic with a real `isReturnableBottle` field on `product.registered`; keep a one-release back-compat default of `false`. | Medium |
| **KF6** | `auth.ts` | Document as defence-in-depth; add a comment stating the server counter is authoritative. No behaviour change. | Low |
| **KF7** | `ledger.ts` | Resolve **GAP-1**: introduce `device:<uuid>` streams with a store-level merge view, or a monotonic per-device sequence merged into the store stream. Decide before Phase 1 ships. | **Critical** |
| **KF8** | `ledger.ts` | `verify()` must also assert that `commandId` values are unique across the stream, not just at the store index. | Low |

> **Honest framing for the shop:** the ledger gives *detectable* tampering plus a complete audit trail.
> It does not make the local database cryptographically immutable against someone with full write
> access. Real immutability requires an off-device anchor - which KF1 introduces and which the
> eventual Supabase/Postgres side can hold in a separate table the till cannot write.

---

## 5. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **An insider rewrites or truncates the ledger and it passes verify** | **Critical** | KF1 external anchor; anchor recorded off-device (Z-report print, audit table, weekly email) |
| **Stock mutation left in `recordSale()` during a partial migration** | **High** | Phase 1.3 lands as one atomic change with a test that greps for the old path |
| **Second till collides on stream seq** | **High** | GATE-4 decision; KF7 before Phase 1 ships |
| **Backfill double-counts historical sales** | **High** | `commandId` derived from existing `sale_id`; replay is idempotent |
| **Backfill aborts on out-of-order replay** | **High** | 1.11 ordering: catalogue -> prices -> receipts -> sales -> voids |
| Ledger grows unbounded on a cheap device | Medium | K6 snapshots; prune below snapshot only if a legal archive exists |
| **Event schema evolves and old events cannot replay** | **High** | K10 upcasting, before the first schema change ships |
| New event types bypass S2/S3 | Medium | KF3 makes specs mandatory |
| RLS policy count grows faster than tests | Medium | Every new table ships with a policy test |
| Phase 2 receipt numbering surprises the accountant | Medium | GATE-3 sign-off before 2.5 |
| Scope grows in Phase 3 (product images, bulk import) | Medium | Phase 3 acceptance is "run a trading day", nothing more |
| Lockout bypassable in a fresh browser | Low | Server counter is authoritative; documented as defence-in-depth (KF6) |

---

## 6. Test strategy

| Layer | What | Enforced by |
|---|---|---|
| Unit | money, barcode, calc, bill | `vitest` (exists: 69) |
| Ledger | hash chain, idempotency, tamper detection | `vitest` (exists: 52) |
| Invariants | every invariant has a failing fixture | `vitest` (add per K4) |
| Property | random command sequences | `fast-check` (new, K13) |
| Integration | RPCs against PGlite mock | `vitest` (exists: 34) |
| E2E | sell, void, refund, offline sync, shift close | Playwright (new, 6.2) |
| Audit | real ledger, chain + invariants | `npm run ldd` (exists) |

---

## 7. Open questions for the owner

1. **GATE-1a** Postgres or MariaDB?
2. **GATE-2a** Late bottle returns - allowed? Window?
3. **GATE-2b** Credit sales offline - allowed?
4. **GATE-3** Receipt numbering: accept explained gaps, or burn numbers from refused offline sales?
5. **GATE-4a** One till, or more than one within 12 months?
6. Opening-day date - determines whether Phase 5 ships before or after go-live.
7. Is there an existing product list (spreadsheet) to import, or is the catalogue entered by hand?
8. Who is the accountant, and will they review the tax report format before 5.7?
9. **New** - Where is the ledger anchor stored off-device? (Paper Z-report, owner's email, Supabase
   audit table.) Without an answer, KF1 cannot close BUG-1.

---

## 8. What I will do on approval

In order, stopping for review after each:

1. **Phase 1.8/1.9 first** - fix KF1-KF8 and settle the stream model. These are corrections to
   guarantees the plan depends on, so they precede feature work. Show failing-then-passing tests for
   BUG-1 and BUG-2 explicitly.
2. Phase 1.1-1.2: extend the kit, add snapshots, extend tests. Kit updated, no app change yet.
3. Phase 1.3-1.4: swap `recordSale()` for the engine, read stock from the projection. App changes.
4. Phase 1.5, 1.10, 1.11: backfill, settings, ordering. Then 1.6/1.7: approvals, CI.
5. Phase 2 in full.

I will not start Phase 2 until Phase 1's audit passes on a ledger that includes real demo sales,
**and** a deliberately tampered copy of that ledger fails verification against its anchor.

---

**Awaiting: GATE-1a, GATE-4a, and approval of the phase order.**
