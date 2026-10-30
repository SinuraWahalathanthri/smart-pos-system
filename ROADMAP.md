# Roadmap: from spice-shop POS to a POS any business can run

This is the feature list for growing the system from one spice shop into a platform that any shop or
company can sign up for and use day to day. It comes from a full audit of the app (October 2026):
every table and SQL function was compared against what the screens can actually reach.

Nothing here is built yet unless it is marked done. **PLAN.md** describes what the system does today
and **TASK-PLAN.md** tracks the open decisions (GATE-1 to GATE-5); this file is the list of what
comes next.

**Status key:** ✅ done · 🟡 groundwork exists (tables or functions, no screen) · ⬜ not started

**Size key:** S = days · M = 1-2 weeks · L = 3-6 weeks · XL = months

---

## Contents

1. [Vendor registration (self sign-up from the website)](#1-vendor-registration-self-sign-up-from-the-website)
2. [Phase A: finish what is half built](#2-phase-a-finish-what-is-half-built)
3. [Phase B: make the core work for any kind of business](#3-phase-b-make-the-core-work-for-any-kind-of-business)
4. [Phase C: run it as a platform](#4-phase-c-run-it-as-a-platform)
5. [Industry modes](#5-industry-modes)
6. [Integrations and hardware](#6-integrations-and-hardware)
7. [Scale, reliability and security](#7-scale-reliability-and-security)
8. [Decisions needed before building](#8-decisions-needed-before-building)
9. [Suggested order](#9-suggested-order)

---

## 1. Vendor registration (self sign-up from the website)

**Status:** ✅ built in `feature/vendor-registration` (migration 0029) · **Size:** L

> **Built:** landing page, `/register` (account, email verification, optional Turnstile CAPTCHA),
> the application form and status on `/onboarding`, the Applications tab in `/platform`
> (approve / reject / request info, optional auto-approval), and the approval gate on `create_store()`.
>
> **Not built yet:** emails about the decision (the applicant sees it in the app; an email needs an
> email service such as an Edge Function with Resend), document uploads, the plan step (waits for
> [§4.1](#41-subscriptions-and-billing)), and disposable-email blocking beyond a short built-in list.

A **vendor** here means a business (a shop, a chain or a company) that signs up to use the POS. It is
not the shop's own supplier; a supplier portal is a separate, later item ([§4.9](#49-supplier-portal-later)).

### Why

Today the only way a business gets an account is for the platform administrator to create the owner
by hand (`platform_create_owner()`, 0025). That is fine for one shop and impossible for hundreds.
Anyone should be able to go to the website, register their business, and start selling, with the
platform administrator keeping the final say over who gets in.

### What exists already

| Piece | Where | How registration uses it |
|---|---|---|
| Creating a shop and its owner profile | `create_store()` (0009), `/onboarding` | The last step of registration, unchanged |
| Owner created by the admin, with a forced password change | `platform_create_owner()`, `/account?first=1` (0025) | Stays as the "admin invites a business" path |
| Suspending a shop | `platform_set_store_active()`, filter in `app_store_id()` | Reused for "approved, then suspended" and for rejected applications |
| Platform admin screen | `/platform`, `components/platform/PlatformScreen.tsx` | Gets an **Applications** tab |
| Admin action log | `platform_audit` table | Records every approval and rejection |

### The flow

```
Public website          Registration form            Email check            Admin review            Shop opens
--------------    ->    -----------------    ->    ---------------    ->    ------------    ->    -------------
/ (landing page)        /register                  Supabase sends a        /platform              /onboarding
Pricing, features,      Business details,          verification link.      "Applications" tab:    prefilled from
"Register your          owner account,             Unverified accounts     approve, reject or     the application,
business" button        business type, plan,       cannot submit.          ask for more info.     then /dashboard.
                        terms acceptance.
```

1. **Landing page (`/`)** for visitors who are not signed in: what the product does, which kinds of
   business it suits, pricing, and a **Register your business** button. Signed-in users keep today's
   routing in `app/page.tsx`.
2. **Registration form (`/register`)**, in steps:
   - **Owner account:** full name, email, mobile number, password (with a strength check).
   - **Business:** legal name, trading name, business type (retail, grocery, restaurant/café, pharmacy,
     salon/service, wholesale, other), country, currency, address, phone, VAT/tax number and
     business registration number (both optional), number of locations, number of tills.
   - **Plan:** free trial or a paid plan (see [§4.1](#41-subscriptions-and-billing)).
   - **Agreement:** accept the terms of service and privacy policy, with the version and time stored.
3. **Email verification.** The account is created with Supabase Auth `signUp()`, which sends a
   verification email. The application cannot be submitted until the email is confirmed.
4. **Submission.** The verified, signed-in user submits the application. Their status page shows
   *Pending review*, *More information needed*, *Approved* or *Rejected*, with the admin's message.
5. **Admin review** on a new **Applications** tab in `/platform`: a list of pending applications
   with the business details, an **Approve** button, a **Reject** button (reason required) and a
   **Request info** button (message required). Each decision is written to `platform_audit`.
6. **Approval** creates the shop (the same work `create_store()` does today, with the business type,
   currency and modules from the application), makes the applicant its owner, and emails them a
   link. Their first sign-in lands on `/onboarding`, prefilled, for a final check.
7. **Optional auto-approval**, a platform setting: verified email plus a valid business type
   approves straight into a free trial, and the admin reviews afterwards. Off by default.

### Data model (new migration)

- `vendor_applications`
  - `id`, `auth_user_id` (the applicant), `status` (`draft`, `submitted`, `info_requested`,
    `approved`, `rejected`, `withdrawn`)
  - business fields: legal name, trading name, business type, country, currency, address, phone,
    tax number, registration number, locations count, tills count
  - `plan_code`, `terms_version`, `terms_accepted_at`
  - `reviewed_by`, `reviewed_at`, `decision_reason`, `store_id` (set on approval)
  - `created_at`, `updated_at`
- `vendor_application_files` (optional): business registration certificate or ID, kept in private
  Supabase Storage, readable by the applicant and platform admins only.
- A unique index so one account has at most one open application.

### Functions (RPCs)

| Function | Who may call it | What it does |
|---|---|---|
| `submit_vendor_application(jsonb)` | Signed-in user with a **verified** email | Creates or updates their own application and submits it |
| `my_vendor_application()` | Signed-in user | Returns their application and status |
| `withdraw_vendor_application()` | The applicant | Withdraws a pending application |
| `platform_vendor_applications(status)` | Platform admin | Lists applications to review |
| `platform_review_vendor_application(id, decision, reason)` | Platform admin | Approves (creates the shop and owner), rejects, or asks for information; writes `platform_audit` |

### Rules that must hold

- **No anonymous RPC.** Registration starts with Supabase `signUp()`, so every function above runs for
  an authenticated user. Each one is revoked from `public, anon` and added to the anon list in
  `tests/platform-admin.test.ts` (see AGENTS.md).
- **Registering never makes anyone a platform admin.** Platform admins are still created only by
  `supabase/setup-platform-admin.sql`. Registration only ever creates a shop owner.
- **No shop exists until approval** (or auto-approval). A pending applicant who reaches `/onboarding`
  sees their application status, not the form, so they cannot create a shop around the review.
- **A rejected or withdrawn application leaves no shop behind.** An approved shop that is later
  closed is suspended, never deleted, exactly as today.
- **Abuse protection:** CAPTCHA on the form, rate limits per IP and per email on sign-up, email
  verification required, and disposable-email domains blocked.
- **Personal data:** the application holds personal and business details, so it is readable only by
  the applicant and platform admins, never by other shops, and documents live in private storage.

### Screens to build

- `/` landing page (public)
- `/register` multi-step form, `/register/verify` ("check your email"), `/register/status`
- `/platform` → new **Applications** tab, with a count badge for pending ones
- Emails: verify address, application received, more information needed, approved, rejected

### Tests

- A verified user can submit; an unverified user and `anon` cannot.
- Approval creates exactly one shop with the applicant as owner; rejection creates none.
- Only a platform admin can list or review applications; a shop owner cannot.
- An applicant cannot read another applicant's application.

---

## 2. Phase A: finish what is half built

Features the database already supports, or that every POS is expected to have.

### 2.1 Done in `fix/dashboard-blockers`

| Feature | Status |
|---|---|
| Create and edit suppliers (`save_supplier`, 0028) | ✅ |
| Set a supervisor's badge from the Staff screen | ✅ |
| Refund or cancel a sale from Receipts | ✅ |
| Stock corrections, deactivate a product, archive a product | ✅ |

### 2.2 Still to build

| Feature | Status | Size | Notes |
|---|---|---|---|
| **Shifts and cash drawer**: opening float, cash in/out, close shift, X report (mid-shift) and Z report (end of day), expected vs counted cash | 🟡 | M | `shifts`, `cash_movements` tables exist with no functions |
| **Split payments**: pay part cash, part card, part credit | ⬜ | M | `payments` already allows several rows per sale; the till allows one method |
| **Receipt printing**: browser print first (80 mm layout), then direct thermal printing and cash-drawer kick from the desktop app | ⬜ | M | No print code anywhere today; the invoice is an HTML download |
| **Digital receipts**: email, WhatsApp or SMS link | ⬜ | S-M | |
| **Partial refunds**: refund some lines or some quantity, not the whole bill | ⬜ | M | `refund_sale()` refunds every line |
| **Refund a credit sale**: write a credit-note entry against the customer's tab | ⬜ | S | Today only cancellation is offered for tab sales |
| **Edit and merge customers**: change name or number, merge duplicates, deactivate | ⬜ | S | Only `add_customer` exists |
| **Loyalty redemption**: spend points at the till, configurable earn rate | 🟡 | M | Points are earned but cannot be spent; rate is hardcoded in `lib/points.ts` |
| **Stock takes**: count all or part of the shop, review differences, post corrections in one go | 🟡 | M | `stock_takes`, `stock_take_lines` exist with no functions |
| **Expiry tracking by batch**: record expiry on receiving, sell oldest first, warn before expiry | 🟡 | L | `product_batches`, `batch_allocations` exist with no functions |
| **Purchase orders**: order from a supplier, receive against the order, part deliveries | 🟡 | L | `purchase_orders`, `goods_receipts` and their lines exist with no functions |
| **Expense receipts and categories**: attach a photo of the bill, rename and manage categories | 🟡 | S | `attach_expense_receipt()`, `save_expense_category()` have no screen |
| **Reports wired up**: sales and expense CSV exports, expense trend chart | 🟡 | S | `sales_export()`, `expense_export()`, `expense_trend()` are never called |
| **Price history** view per product | 🟡 | S | `product_price_history` has no screen |
| **Platform admin log viewer** | 🟡 | S | `platform_audit` is written but never shown |
| **Alerts**: in-app bell, daily email digest, browser push for low stock, expiry, unpaid bills | 🟡 | M | `notifications` table is filled by stock triggers but never shown |
| **Product images** | ⬜ | S | Deliberately left out to avoid storage; needed for most retail |
| **CSV import** of products, customers and opening stock | ⬜ | M | Essential for onboarding a shop that already has a catalogue |
| **Camera barcode scanning** on phones and tablets | ⬜ | S | Planned in PLAN.md (`@zxing/browser`) |
| **Wire up or remove `lib/ldd`** (event ledger, about 1,700 lines, tested, not imported) | 🟡 | S | Decide; dead code confuses contributors |

---

## 3. Phase B: make the core work for any kind of business

The current model has spice-shop assumptions built in: pack sizes in grams, glass bottles inside the
sale function, one VAT rate, three fixed roles, LKR by default, one till. These items remove them.

### 3.1 Business type and modules

**Status:** ⬜ · **Size:** L

- Each shop picks a **business type** at registration ([§1](#1-vendor-registration-self-sign-up-from-the-website)),
  which switches on a sensible set of **modules**.
- Modules can be turned on or off later in settings: weighed goods, returnable containers (bottles),
  production/manufacturing, customer credit, loyalty, batches and expiry, tables (restaurant),
  appointments (services), serial numbers.
- Screens, till buttons and navigation hide what a shop has not switched on. Functions refuse
  module-specific actions for shops that have them off.
- The bottle logic in `complete_sale()` / `refund_sale()` moves behind the "returnable containers"
  module so other shops never touch it.

### 3.2 Products: variants, modifiers and units

**Status:** ⬜ · **Size:** XL

- **Variants** replace `pack_sizes`: any product can have options (size, colour, weight, flavour),
  each with its own SKU, barcode, price and stock. The spice shop's 50 g / 250 g / 1 kg packets
  become variants with a "weight" option, so nothing is lost.
- **Modifiers and add-ons** for food and drink: extra cheese, no sugar, large cup, priced or free.
- **Units of measure**: piece, kg, g, litre, metre, box of 12, with conversion (buy by the box, sell
  by the piece).
- **Bundles and kits**: one item made of several stock items.
- **Serial and IMEI numbers** for electronics.
- **Several barcodes per product** (`product_barcodes` already exists).
- **Archived-product view** to find and restore archived items.

### 3.3 Tax

**Status:** ⬜ · **Size:** L

- **Tax classes**: several rates per shop (standard, reduced, zero, exempt), set per product.
- **Inclusive or exclusive pricing**, per shop.
- **Compound and multiple taxes** on one line (VAT plus a levy).
- **Country presets** (Sri Lanka VAT and SSCL first), always editable, never hardcoded.
- Keep the current rule: the app reports figures and never says "payable" (AGENTS.md, Finance).

### 3.4 Roles and permissions

**Status:** 🟡 · **Size:** M

- **Custom roles** with a permission matrix: void, refund, discount above X %, see cost, edit price,
  manage stock, open the cash drawer, view reports, manage staff.
- `roles`, `permissions` and `role_permissions` tables exist; today `permissions()` in `useShop.ts`
  hardcodes three roles.
- Keep enforcement in the functions, not the UI.

### 3.5 Promotions

**Status:** ⬜ · **Size:** L

- Percentage and fixed discounts on products, categories or the whole bill.
- Buy X get Y, multi-buy ("3 for 500"), bundles at a set price.
- Time-limited offers and happy hours, coupon codes, customer-group prices.
- Clear rules for which promotion wins when two apply.

### 3.6 Customers and loyalty

**Status:** ⬜ · **Size:** M

- Customer groups (wholesale, staff, VIP) with their own prices.
- Configurable loyalty: earn rate, redemption value, expiry, tiers.
- **Gift cards and store credit**, with a balance ledger like the credit ledger.
- Customer purchase history and simple marketing lists (with consent).

### 3.7 Multiple locations and tills

**Status:** ⬜ · **Size:** XL

- **Several branches per company**, with a head-office view across all of them.
- **Stock transfers** between branches, with in-transit stock.
- **Device register**: name each till, see when it last synced, revoke a lost device (`devices` table exists).
- **Several tills per shop** with safe receipt numbering (GATE-3, GATE-4 in TASK-PLAN.md).
- Prices and products shared across branches, with per-branch overrides.

### 3.8 Localisation

**Status:** ⬜ · **Size:** M

- Currency, number and date formats per shop.
- Languages, starting with Sinhala and Tamil (PLAN.md currently says English only).
- Time zone per shop, used for "today", shifts and reports.

---

## 4. Phase C: run it as a platform

### 4.1 Subscriptions and billing

**Status:** ⬜ · **Size:** L

- Plans (free trial, basic, pro, enterprise) with limits: locations, tills, staff, products, modules.
- Online payment for subscriptions (card, bank transfer; a local gateway such as PayHere for Sri Lanka).
- Trial expiry, grace period, then read-only mode, never data deletion.
- Invoices for the subscription itself, and a billing page for the owner.

### 4.2 Company accounts

**Status:** ⬜ · **Size:** M

- A **company** above shops: one owner, several branches, shared settings and catalogue.
- Company-level users (area manager, accountant) who see several branches.

### 4.3 Public API and webhooks

**Status:** ⬜ · **Size:** L

- A documented REST API with per-shop API keys and scopes.
- Webhooks for sale completed, refund, low stock, new customer.
- Rate limits and an API usage page.

### 4.4 Reporting

**Status:** ⬜ · **Size:** L

- Report builder: pick measures, group by, filter, save.
- Scheduled reports by email (daily takings, weekly stock).
- Fill `daily_sales_rollup` and `monthly_summaries` with scheduled jobs so large shops stay fast.
- Demand forecasting and reorder suggestions (in PLAN.md, not built).

### 4.5 Data ownership

**Status:** ⬜ · **Size:** M

- Full export of a shop's data (CSV and JSON) on request.
- Automatic backups, and a documented restore process.
- Account closure that keeps the data for the legally required period, then removes personal data.

### 4.6 Platform administration

**Status:** ⬜ · **Size:** M

- Applications queue ([§1](#1-vendor-registration-self-sign-up-from-the-website)).
- Plan and billing view per shop, usage against limits.
- Support access that the shop owner grants and can revoke, with every action logged. The admin panel
  stays read-only over trading data (AGENTS.md).
- Announcements to all shops (maintenance, new features).

### 4.7 White-label

**Status:** ⬜ · **Size:** M

- Custom logo, colours and receipt header per shop or per reseller.
- Custom domain for resellers.

### 4.8 Help and onboarding

**Status:** ⬜ · **Size:** M

- Guided first-run checklist (add products, add staff, open the till, first sale).
- In-app help articles and a support contact form.
- Demo mode that never touches a real shop's data (AGENTS.md: no sample shops in connected mode).

### 4.9 Supplier portal (later)

**Status:** ⬜ · **Size:** L

- Suppliers log in to see purchase orders, confirm deliveries and upload invoices.
- Only after purchase orders ([§2.2](#22-still-to-build)) exist.

---

## 5. Industry modes

Each is a module from [§3.1](#31-business-type-and-modules).

| Mode | Features | Size |
|---|---|---|
| **Restaurant / café** | Table map, open tabs per table, split bill, kitchen tickets (KOT), kitchen display screen, course timing, tips, service charge | XL |
| **Services / salon** | Appointment calendar, staff schedules, service durations, deposits, reminders | L |
| **Pharmacy** | Batch and expiry (required), prescription notes, controlled-item logging | L |
| **Wholesale** | Price tiers by quantity, customer-specific prices, quotations, delivery notes, credit terms | L |
| **Electronics / hardware** | Serial numbers, warranties, repairs and job cards | L |
| **Manufacturing** (today's spice production, generalised) | Bill of materials, production runs, waste, cost per unit | M (exists for spices) |
| **Clothing / fashion** | Size and colour variant grid, seasonal collections, exchanges | M |

---

## 6. Integrations and hardware

### Integrations · ⬜

- **Accounting:** Xero, QuickBooks, or a CSV journal for a local accountant.
- **Payments:** card terminals, LankaQR and bank QR with automatic confirmation.
- **E-commerce:** Shopify and WooCommerce, with shared stock.
- **Delivery apps:** PickMe Food, Uber Eats (restaurant mode).
- **Messaging:** WhatsApp Business API and SMS gateway for receipts and reminders.
- **E-invoicing** where a country requires it.

### Hardware · ⬜

- Thermal receipt printers (ESC/POS over USB or network from the desktop app).
- Cash drawer kick.
- Weighing scales (read the weight directly, not just pick a pack size).
- Barcode label printer for shelf labels and price stickers (`weight_labels` table exists).
- Customer-facing display showing the bill and the total.

---

## 7. Scale, reliability and security

| Item | Size | Notes |
|---|---|---|
| Benchmark row-level security under load; `app_store_id()` runs on every policy check | M | Before onboarding large tenants |
| Pre-computed report tables filled by scheduled jobs | M | Raw-table reports are fine at 300 bills a day, not for a chain |
| Error tracking and monitoring (for example Sentry) for web and desktop | S | |
| Two-factor sign-in for owners and platform admins | M | PLAN.md lists TOTP for owners |
| Single sign-on for company accounts | L | Enterprise plan |
| Desktop auto-update and staged rollout | M | |
| `.gitattributes` pinning `*.sql text eol=lf` | S | Removes the CRLF test trap in AGENTS.md |
| Load and offline-sync testing with several tills | M | Linked to GATE-4 |
| Data retention and privacy policy, consent records | M | Needed before public sign-up ([§1](#1-vendor-registration-self-sign-up-from-the-website)) |

---

## 8. Decisions needed before building

| Decision | Affects | Notes |
|---|---|---|
| **Licence**: AGPL-3.0 or a commercial or dual licence | Selling to companies and resellers | AGPL may put off businesses that want to embed or white-label the system |
| **Approval model** for vendor registration: manual review, auto-approve, or auto-approve trials only | [§1](#1-vendor-registration-self-sign-up-from-the-website) | |
| **Plans and pricing** | [§4.1](#41-subscriptions-and-billing) and registration | |
| **Several tills per shop** (GATE-4) and receipt numbering (GATE-3) | [§3.7](#37-multiple-locations-and-tills) | Already open in TASK-PLAN.md |
| **Offline credit sales** (GATE-2b) | Credit, multiple tills | Already open in TASK-PLAN.md |
| **Which industries come first** | [§5](#5-industry-modes) | Restaurant mode is the largest single piece |
| **Hosting and region** for the platform | Cost, data residency | Supabase Pro at minimum for live shops (PLAN.md) |

---

## 9. Suggested order

1. **Phase A** ([§2.2](#22-still-to-build)): shifts, split payments, printing, partial refunds, CSV
   import. A shop cannot run day to day without these.
2. **Vendor registration** ([§1](#1-vendor-registration-self-sign-up-from-the-website)) together with
   **business type and modules** ([§3.1](#31-business-type-and-modules)), because the type picked at
   sign-up decides what the shop sees.
3. **Variants, tax classes, custom roles** ([§3.2](#32-products-variants-modifiers-and-units)-[§3.4](#34-roles-and-permissions)),
   so the first non-spice shops fit.
4. **Subscriptions and billing** ([§4.1](#41-subscriptions-and-billing)) before opening sign-up widely.
5. **Multiple locations and tills** ([§3.7](#37-multiple-locations-and-tills)), then industry modes
   ([§5](#5-industry-modes)) and integrations ([§6](#6-integrations-and-hardware)) by demand.
