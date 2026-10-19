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
`return_bottles()` / `charge_bottle_fee()` both REFUSE to act beyond what is outstanding, so the till
cannot hand out a free bottle or charge twice. `return_bottles()` also refuses a product that is not
`is_returnable_bottle`.
**`stock_on_hand` is never written directly.** `guard_stock_columns` zeroes it on INSERT and raises on
UPDATE. Opening stock goes through `stock_movements` with type `opening` - `save_product` does this
from the `opening_stock` key. Any new screen that sets stock must do the same.
**Analytics hide cost, not just the button.** `product_analytics()` returns null `cost_cents` and
`margin_cents` for a supervisor, so the number never reaches the browser.
Scratch-file discipline: put temporary scripts outside the repo, or delete them in the same command.
