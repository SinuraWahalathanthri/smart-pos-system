<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
## Project facts (verified by execution)
- **Schema layout. Read this before touching SQL.**
  - `supabase/migrations/0001_core.sql` .. `0004_till_auth.sql` = the **live** schema (17 tables,
    surrogate `id uuid` keys, `_cents` money). The app, the 9 SQL functions and the 22 RLS policies
    are written against it.
  - `0005_operations.sql` + `0006_operations_rls.sql` = the operations half (25 tables: suppliers,
    purchasing, customers, shifts, refunds, production, stock takes, reporting, roles). They FOLLOW
    0001's conventions and do not touch its 14 shared tables. Decision: `TASK-PLAN.md` GATE-5 (Option A).
  - `pos_db.html` is the original design document. `npm run db:plan` parses it into
    `supabase/design/0005_core_schema.sql`, which is a **reference artifact only** - it collides with
    0001 and must never be applied. `tests/schema.test.ts` validates it in isolation.
  - Three design-doc tables are deliberately absent because 0001 already models them: `staff` /
    `staff_credentials` / `store_memberships` -> `profiles`; `audit_log` -> `audit_logs`;
    `store_settings` -> `stores` columns + `settings`.
- `npm run db:plan` (tsx) regenerates the design schema. `tests/schema.test.ts` proves it executes
  on a real Postgres engine (PGlite) and that the committed file matches a fresh generation.
- **Credentials are runtime, not build-time.** `lib/supabase/config.ts` stores the project URL and
  anon key in `localStorage` so the installed desktop app can be pointed at a project without a
  rebuild. `NEXT_PUBLIC_*` is inlined by the bundler and only serves as a fallback default. Never
  hardcode credentials. `isConnected` is a **function** (it reads runtime config), not a constant.
- **PowerShell 5.1 breaks UTF-8.** Here-strings and `->` (U+2192) get mangled, and `Set-Content`
  writes UTF-16-ish bytes. Write any file with non-ASCII content through
  `python -c` with `io.open(..., encoding="utf-8", newline="\n")`, or use the editor tool.
- Verification commands: `npx tsc --noEmit`, `npx vitest run`, `npx next build`.
## Onboarding, roles and bottles (0007-0011)
**Nothing is seeded in connected mode.** `ensureSeeded()` returns early when Supabase is configured;
a real shop is created only by `create_store()` (0009) from `/onboarding`. Do not add sample shops
to the migration chain - a production shop must never open to demo data.
**Tenancy.** `stores.owner_id` links a shop to the person who made it. `app_store_id()` honours a
requested `app.store_id` only for a shop the caller owns or works in, then falls back to
`profiles.last_store_id`, then the oldest profile. Never reintroduce `limit 1` as the only rule: it
was what made multi-store impossible.
**Roles are enforced in the RPCs, not the UI.** `assert_can_manage_staff()` (owner) and
`assert_can_manage_products()` (owner or supervisor) raise 42501. The dashboard hides navigation by
role purely as courtesy.
**Customers are keyed by mobile number**, unique per store (`customers_store_phone_ux`). Two people in
one household use their own numbers - there is no shared-number case. `find_customer_by_phone()`
matches the full number first, then the last 4+ digits.
**Bottles are loans, not up-front fees.** Milk at 250 does not charge the 100 deposit; it records that
the customer owes a bottle. `customer_bottles_outstanding()` = sold - returned - fee_charged.
`return_bottles()` REFUSES to act beyond what is outstanding, so the till cannot hand out a free
bottle, and refuses a product that is not `is_returnable_bottle`.
**A deposit is a line on a bill, never a ledger row on its own (0027).** F7 "Keep" adds a `bottle_fee`
line carrying the bottle's `product_id`; `complete_sale()` settles that loan from it. That is what puts
the money in the sale's subtotal, its payments, the shift's cash and finance. `charge_bottle_fee()`
wrote a ledger row with no sale behind it - cash nobody's report could see - and is now revoked from
every client. The dashboard (`/bottles`) registers returns only. `complete_sale()` refuses a deposit
for another shop's product, and settles no more than is owed: an offline bill that paid for a bottle
already returned keeps its money but writes a `bottle_deposit_excess` audit row instead of a second
settlement. The ledger amount is what the bill charged, not today's fee.
**Nothing writes `bottle_ledger` directly.** 0027 dropped the authenticated INSERT policy from 0007,
which let any till skip every guard. `bottles_returned` in a sale payload is capped at what is owed.
**A refund or cancellation reverses its bottles with negative rows** (`reverse_sale_bottles()`); the
ledger stays append-only and every SUM stays right. A refund cancels the loans its goods started; a
cancellation also reverses the bill's empties and deposits. A loan is only reversed as far as it is
still owed. Anything reading the ledger must sum `qty`, never count rows, and must filter `qty > 0`
when it wants "when did this happen".
**Never change a migration that has shipped.** 0026's `complete_sale` change was first written into
0019; a live database had already run 0019, so it would never have seen it. The PGlite tests build a
fresh database every run and cannot catch this - put the redefinition in a new migration.
**A waiver forgives money, never the bottle.** `fee_waived` rows are reported by
`customer_bottle_summary()` but deliberately NOT subtracted from `outstanding`; only a return or a
`fee_charged` row settles a loan. Getting this wrong silently forgives every waived bottle.
**Bottles are attributed to a customer, not to a bill.** `bottle_ledger` rows carry
`customer_id` (and now `created_by`), so the owner can see who still has one and who handed it back.
Walk-in sales have a null customer: they still move the shop total, and are shown as "Walk-in" rather
than being given an invented debtor.
**Every role reads the bottle book (`/bottles`).** A cashier hands the bottle over and takes it back,
so a count they cannot see is a count the shop cannot trust. `permissions().viewBottles` is `true` for
owner, supervisor and cashier, and `customer_bottle_summary()` / `bottle_totals()` / `bottle_events()` /
`customer_bottles_by_product()` are per-shop, not per-role. Do not "tidy" this into `viewAnalytics`.
A cashier reaches it with their own dashboard sign-in; the till deliberately has no link there, because
the till is signed in as a device account and the dashboard would open with the device's role.
**The /bottles headline numbers come from `bottle_totals()`, never from adding up the list.** The list
defaults to customers still owing, one page of them, so summing it drops everyone who settled.
**The till's F7 dialog and the dashboard form are the same component**
(`components/bottles/ReturnBottlesForm.tsx`). The rule must not drift between the counter and the
office. `BottleReturnDialog` is a thin wrapper; it needs an attached customer, because a return has to
land on a person.
**0026 adds `customer_bottle_summary`, `customer_bottles_by_product`, `bottle_events` and a
`(store_id, created_at desc)` index on `bottle_ledger`.** The index is not decoration: all three
functions scan one shop newest-first.
**A new RPC listed in `revoke all on function ...` must also be listed in the `grant`** - and vice
versa - unless it is internal (`bottles_owed`, `reverse_sale_bottles`) or retired
(`charge_bottle_fee`), in which case it is revoked with no grant, on purpose. `tests/platform-admin.test.ts` calls every anon-executable RPC and expects
`permission denied`, so a forgotten revoke is a test failure, not a silent hole.
**`stock_on_hand` is never written directly.** `guard_stock_columns` zeroes it on INSERT and raises on
UPDATE. Opening stock goes through `stock_movements` with type `opening` - `save_product` does this
from the `opening_stock` key. Any new screen that sets stock must do the same.
**Suppliers, stock corrections and archiving (0028).** `save_supplier()` is the only write path for
`suppliers` (guarded like `save_purchase`, owner or supervisor); suppliers are deactivated, never
deleted. `adjust_stock()` lets an owner or supervisor correct stock directly, a cashier only with an
approval token, and refuses to go below zero. Both it and `archive_product()` resolve the caller through
`app_store_id()` - 0003's unscoped `auth_user_id = auth.uid()` lookup is wrong for multi-shop owners.
A refund of a bill paid on credit is not offered in the UI: `refund_sale()` does not touch the credit
ledger, so it would hand back cash for a debt still owed. Cancelling (`void_sale()`) removes the tab entry.

**Vendor registration (0029, `lib/registration.ts`, `components/register/`).** A business signs up
with Supabase `signUp()`, confirms its email, then submits an application from `/onboarding`; a
platform admin decides it on the Applications tab of `/platform`. `create_store()` now opens a NEW shop
only for an account with an approved application (an account that already has a shop still gets it
back), so a public sign-up cannot skip the review. Do not loosen that gate. Rules:
- Nothing in registration is callable by `anon`; the account exists before any RPC runs. Every new
  function is in the anon list in `tests/platform-admin.test.ts` and `tests/vendor-registration.test.ts`.
- Registration only ever makes a shop owner, never a platform admin, and refuses a platform admin.
- `vendor_applications` and `platform_settings` have RLS on and no client grants: read them only through
  the functions. `verified_email()`, `caller_has_shop()` and `is_disposable_email()` are internal.
- Approval does not create the shop; the owner's `create_store()` does, so there is one path for every
  new shop. Tests that need a shop insert an approved application first (`tests/onboarding.test.ts`).
- `/login` sends an account with no shop to `/` (then `/onboarding` or `/platform`): such an account
  has no staff, so the PIN step was a dead end. The landing page is website-only: `isDesktopApp()`
  sends the installed till straight to `/login`.
- The decision is shown in the app only; there is no email service yet. `/terms` and `/privacy` are
  drafts. Bump `platform_settings.terms_version` with the text, or applicants keep accepting the old one.

**The mock backend (`npm run dev:mock`) serves plain table reads and set-returning RPCs.** Before that
it returned only the first row of a `returns table` function and 404'd every table but `products`, so
the shop switcher, receipts and stock history crashed under it while working on real Supabase.

**Analytics hide cost, not just the button.** `product_analytics()` returns null `cost_cents` and
`margin_cents` for a supervisor, so the number never reaches the browser.

## Toolchain

**Next.js is pinned exactly (no `^`)**. `next` and `eslint-config-next` must
always carry the same version. Security patches have arrived as patch releases
on the current minor (16.4.0 -> 16.4.1 for two critical RCEs), so check
`npm audit` before assuming a major bump is needed.

**`next build` fails once on a vulnerable version, then continues on retry.**
That first exit 1 is an advisory gate, not a compile error. Do not "fix" it by
pinning an older version.

**Line endings are a trap.** `core.autocrlf=true` and no `.gitattributes`, but
`tests/schema.test.ts` compares a generated file byte-for-byte. A fresh clone
or worktree gets CRLF and that test fails with a whole-file diff that looks
like schema drift but is not. Normalise `supabase/design/0005_core_schema.sql`
to LF before trusting a schema failure in a new checkout. A `.gitattributes`
pinning `*.sql text eol=lf` would remove the trap for good.

**`tsc --noEmit` needs a build first.** `LayoutProps` and friends are ambient
types emitted into `.next/types`; without a prior `next build`, tsc reports
`Cannot find name 'LayoutProps'`. Run `npm run build` before typechecking in a
clean environment.

**Never use `window.prompt`, `window.alert` or `window.confirm`.** The app runs
both in a browser and in Electron (`desktop/`), and Electron's renderer does not
implement `prompt()` at all - it returns `null` immediately without drawing
anything. A feature built on it therefore works in dev and silently does nothing
in the packaged till, which is the worst possible failure mode. `alert` and
`confirm` are implemented but still block the renderer, so use `components/ui/
Dialog.tsx` for all three. The staff PIN reset is the cautionary example.

Verify UI that touches browser-only APIs in the desktop build, not just
`localhost:3000`.

## Finance (0021-0024, `lib/finance.ts`, `components/dashboard/finance/`)

**Purchases are not expenses.** A supplier bill creates a payable and capitalises stock; the cost only
reaches `finance_summary` as COGS when the goods sell. Never add `purchases_cents` into
`operating_expenses_cents` - that double-counts stock and makes a month with a big delivery look like
a loss. `capital_expenses_cents` is likewise excluded from net profit, on purpose.

**The profit identity is tested, not assumed.** `net_sales = gross - discounts - refunds`,
`gross_profit = net_sales - cogs`, `net_profit = gross_profit - operating_expenses`. If you change
one side of any of these, run `tests/finance.test.ts` before anything else.

**A loss is a negative number.** Nothing is clamped to zero. A product sold below cost keeps its
negative margin, and `is_below_cost` is a separate flag rather than `margin_pct < 0`, because a
negative margin also happens on a discount that was deliberate.

**Expenses are voided, never deleted.** `voided_at` is set with a reason and every report filters it
out. There is no delete grant. A trigger also blocks UPDATE of a paid amount once payments exist,
so the recorded money cannot contradict the payments ledger.

**Refunds land in their own period.** `refund_sale()` writes to `refunds`/`refund_lines` dated when
the money went back. It never rewrites the original sale, so a closed month stays closed - which is
what makes the month-by-month comparison trustworthy.

**Cost is snapshotted at sale time.** `sale_items.cost_cents` is captured by `complete_sale()`.
Changing a cost later (`set_product_cost`) affects future sales only. This is why a cost change
requires a reason and is written to `product_cost_history` + `audit_log`.

**No VAT rate is hardcoded.** `finance_settings.vat_rate_pct` starts at 0 and `tax_summary()` reports
a *difference*, not a liability - whether it is payable depends on rules the app does not encode.
`save_finance_settings()` is owner-only. Do not "fix" the wording to say "VAT payable".

**Alerts are questions, not findings.** `finance_alerts()` returns `severity = 'review'` only. Nothing
blocks, reverses or accuses. Keep it that way: a large bill in a busy week looks exactly like a
mistake to a pattern matcher.

**The audit trail is append-only** (`audit_log`, no UPDATE/DELETE grant, owner-read only). `audit_trail()`
and `audit_actions()` are the only way the UI reads it.

**Expense categories are seeded by a trigger** on `stores` insert (`seed_expense_categories_for`),
not on first use. Seeding on demand left the suggestion list empty the first time the form opened.

**Money never leaves as a float.** All amounts are `bigint` cents, rendered by `formatMoney`, and
exported as a decimal string by `centsToDecimal`. CSV cells are prefixed with `'` when they start
with `= + - @` (spreadsheet injection).

Scratch-file discipline: put temporary scripts outside the repo, or delete them in the same command.

## Platform administration (0025, `lib/platform.ts`, `components/platform/`)

**The admin panel is read-only over trading data, by construction.** `platform_stores()` and
`platform_store_detail()` are the only reads, and no RPC exists that edits a sale, product or stock
level. Do not add "helpful" admin write paths: the value of this role is that a compromised admin
account cannot falsify a shop's books.

**`platform_admins` is a principal, not a role.** It is a separate table keyed by `auth_user_id`, and
an admin belongs to no store. `is_platform_admin()` is security definer because clients cannot read
the table. Never add a self-service "become admin" path - the bootstrap script
(`supabase/setup-platform-admin.sql`) is deliberately the only way to make the first one.

**Every new function needs BOTH a guard and a `revoke ... from public, anon`.** The guards were right
first time, but `platform_store_detail()` and `complete_password_change()` were still executable by
`anon` through the default PUBLIC grant. `tests/platform-admin.test.ts` calls every RPC as `anon`
and asserts `permission denied`; add any new function to that list.

**The breakdown must never include cost or margin.** `platform_store_detail()` reports takings,
payment mix, best sellers by *revenue*, staff activity and low stock - enough to judge whether a
shop is healthy. It must not join `public.product_costs`, which is owner-only so cashiers cannot see
it. A compromised admin account that could read shop costs would leak every tenant's margins. The
test seeds a cost row and asserts neither the value nor a `cost_cents`/`margin` key appears.

**Suspension is a filter in `app_store_id()`, not a check in each policy.** Because every policy
resolves the store through that function, `where st.is_active` in its `allowed` CTE closes the shop to
its own staff in one place. It also means a suspended shop must stay *visible* to the platform
functions (they query `stores` directly, not through the helper) - so "suspended" is never "deleted".
`my_shop()` returns `onboarded: true, suspended: true` so the app shows "closed" rather than offering
the onboarding flow, which would silently create a second shop.

**A generated password is shown once and then unrecoverable.** Password hashing uses
`extensions.crypt()`, which lives in the `extensions` schema, so every security-definer function that
touches it needs `search_path = public, extensions`.
`platform_create_owner()` writes the auth user, the `auth.identities` row (without it email sign-in
fails even though the user exists), the store and the owner profile in ONE transaction. The account is
flagged `must_change_password`, and `/account?first=1` blocks the app until it is replaced - otherwise
whoever wrote the password down still has access. Clear the flag only after `auth.updateUser()`
succeeds, never before.

**The admin screen is outside `DashboardShell` on purpose.** An administrator holds no shop, so
`useShop` (which redirects when there is no store) would bounce them forever. `app/page.tsx` is the
single place that decides the landing route; keep the three cases (admin / must-change-password /
new owner) in order there.

PowerShell note: the shell is a persistent session, and an unterminated heredoc hangs it with no
recovery except a reset. Write files with the editor tool rather than `node -e "..."`.

## Compact (phone) till layout
- `lib/viewport.ts` is the single source of truth for the breakpoint: `COMPACT_MAX_WIDTH = 1023`
  mirrors Tailwind's `lg`, so JS and CSS never disagree. `useIsCompact()` is `useSyncExternalStore`
  (server snapshot is always `false`), so the first client paint matches the server HTML.
- Below `lg` the bill moves into `<Sheet>` and `<MobileDock>` replaces `<ShortcutBar>`. The scan bar
  is deliberately *not* autofocused at compact width - it would raise the on-screen keyboard over the
  product grid. Tap it explicitly instead.
- Overlay z-index order is toast (40) < modal dialog / sheet / actions menu (50). Do not give a toast
  a higher value than a modal: a modal must never be obscured by a transient message.
- Keyboard hints (`Button keycap=`, `<Keycap>`) carry `.keycap-hint`, hidden under
  `@media (pointer: coarse)`. A phone has no F-keys, so the hint would point at nothing.
- Verify phone layout by driving Chrome over CDP with **both** `setDeviceMetricsOverride` (390x844)
  and `setTouchEmulationEnabled`; without the second call `(pointer: coarse)` does not match and
  keycap hints still render.
- `next dev` refuses to start a second instance in the same directory. To test a change that the
  running dev server has not picked up, restart it - a stale CSS chunk otherwise hides new rules
  (the production build was already correct, which is what isolated this).
