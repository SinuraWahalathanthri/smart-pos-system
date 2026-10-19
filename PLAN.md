# POS System — Architecture & Build Plan

A barcode-driven point-of-sale system for small-to-medium shops (Sri Lankan grocery context),
backed by Supabase. It covers the cashier POS, supervisor overrides (Keels-style item voids),
inventory, low-stock alerts, fast-mover analytics, demand forecasting, purchase scheduling,
tax, and monthly business summaries.

---

## 0. Build Status (updated 2026-10-14)

| Phase | State |
|---|---|
| 0 Setup | **Done**: Next.js 16 + TypeScript + Tailwind 4, Dexie, Zustand, Vitest, README |
| 1 Core data + auth | **Mostly**: schema, RLS, seed; till sign-in via Supabase Auth + staff code/PIN checked on the server. Not yet: catalogue editing screens and image upload |
| 2 POS checkout + offline + keyboard | **Mostly**: full keyboard till, picture grid, pack-size picker, scan, bill, payments (cash/card/QR), hold/recall, calculator, **offline queue with sync to Supabase**. Not yet: shifts, credit, receipt output |
| 3 Overrides & audit | **Mostly**: badge + PIN approval with lockout (till and `verify_supervisor`), Keels-style void, fee waiver, discount limit, audit log in the database. Not yet: refunds, product-archive screen |
| 4 Inventory & alerts | **Database only**: stock ledger, guard, low/out-of-stock alerts. No screens yet |
| 5–10 | Not started |

Money is stored as **integer cents** (not `numeric(12,2)`), in the till and in the database.

## 1. Goals & Constraints

| Goal | How the design meets it |
|---|---|
| Low running cost | Supabase (Postgres + Auth + Realtime + Edge Functions + pg_cron) does the whole backend. No separate server. Forecasting runs as SQL, so there is no ML service to pay for. |
| Fast checkout | Barcode-first UI with every common action on a keyboard shortcut. Product catalogue cached on the till. |
| Security for risky actions | Roles + Postgres Row Level Security (RLS). Sensitive actions go through server-side functions that check a supervisor badge scan **and** PIN together. Everything is written to an audit log. |
| Trustworthy numbers | Stock is an append-only **movement ledger**, not a number people edit. Sales and line items are never hard-deleted, only voided with a reason. |
| Keeps working if the internet drops (Phase 2) | IDs are generated on the client (UUIDs) from day one, so sales can be queued offline and synced later without clashes. |

---

## 1a. Confirmed Requirements (from Q&A, 2026-10-14)

| Area | Decision |
|---|---|
| Scale | **Single shop**, 1–3 staff, under 1,000 products. `store_id` stays in the schema so branches can be added later. |
| Connectivity | **Offline selling is required.** It moves from Phase 8 to Phase 2 (see §10). |
| Business | **Spice manufacturer + small grocery.** Raw produce (e.g. dry chilli) is bought, sun-dried, ground and packed into retail packs and bulk/business packs. The grocery side sells biscuits, milk packets, glass-bottle milk, etc. **No vegetables, fruit or meat.** |
| Selling by weight | **Spices are sold in weighted packets.** Spices are weighed and sealed in the shop into **branded packets of fixed sizes** (50 g, 250 g, 500 g, 1 kg, etc.), and each size is counted as its own stock. Pick the product, choose a pack size, and that size's price shows live. The same line can be added by **scanning a pack barcode**, so both ways give an identical bill line. Barcodes may not exist on spice packs at first, so the tiles work on their own and barcodes can be attached later (§4.1b). |
| Product images | Every product shows with a picture in the POS grid. One tap or `Enter` adds a unit item (e.g. biscuits). A weighted item opens the weight picker (§8b). |
| Production | Tracked in the app: raw material in, drying and grinding losses, packed units out, cost per pack (§4.7). |
| Returnable bottles | Glass-bottle milk sells at **LKR 250**. If the customer does not hand back an empty bottle, a **LKR 100 penalty fee** is added to the bill (§4.8). It is a fee, not a refundable deposit. |
| Hardware | PC/laptop + USB barcode scanner. **No printer and no cash drawer for now.** Cash is handled by hand and recorded in the POS (tendered, change due, cash-in/cash-out entries). Receipt printing and the drawer-kick are built as switches to turn on later. |
| Registration | **VAT-registered, fully legal business.** VAT is on, prices are tax-inclusive. |
| Supervisor approval | **Badge barcode scan + PIN, always together** (two-factor). Neither works alone (§3). |
| Input | **Full keyboard-only operation**, with the mouse also working for every action (§8a). |
| Receipts | On-screen receipt, PDF download, send by WhatsApp/SMS/email (optional, on request), and a printer-ready layout. |
| Payments | Cash, card (external terminal, reference recorded only), QR/bank transfer (LankaQR reference), and **customer credit accounts**. |
| Customers | Walk-in by default. An optional customer record (name, phone) can be attached to a sale. Required for credit accounts. **No loyalty points.** |
| Promotions | Percentage/amount discounts, buy-X-get-Y, and time-limited offers on products. |
| Tax | **Prices include tax.** Calculated: VAT (collected − paid), other sales levies, and an estimated income tax on profit. All percentages are set by the owner. |
| Alerts | In-app bell + dashboard, daily email digest, phone/browser push (PWA). No WhatsApp/SMS alerts, to avoid per-message cost. |
| Purchasing | Mix: some suppliers on recurring schedules, others ad hoc. |
| Expiry | **Tracked per batch.** Expiry date recorded on receiving, with alerts before expiry (§7). |
| Returns | Supervisor approves, cash back. Item goes back to stock or to a damaged/expired list. |
| Language | English only. |
| Budget | Supabase Free while building, upgrade to Pro before the shop goes live. |

---

## 2. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | **Next.js (App Router) + TypeScript**, installable as a **PWA** | One codebase for the till PC, the owner's laptop and a phone. Installable, full-screen, works on cheap hardware. |
| UI | Tailwind CSS + shadcn/ui | Quick to build, and the components are easy to make touch-friendly. |
| State/data | TanStack Query + Zustand (cart state) | Server cache plus a fast local cart. |
| Offline (Phase 2) | Dexie (IndexedDB) | Local product cache and an offline sales queue. |
| Barcode | USB/Bluetooth HID scanners (they type like a keyboard), plus `@zxing/browser` for phone-camera scanning | HID scanners are cheap and need no drivers. |
| Charts | Recharts | |
| Backend | **Supabase**: Postgres, Auth, RLS, RPC functions, Realtime, Edge Functions, pg_cron, Storage | |
| Email/alerts | Resend (free tier) via an Edge Function. WhatsApp/SMS can be added later. | |
| Receipts | 80mm thermal printer through browser print CSS (later: ESC/POS via WebUSB for the cash-drawer kick) | |
| Hosting | **Cloudflare Pages** or **Netlify** (free tiers allow commercial use) | ⚠️ Vercel's free Hobby plan does **not** allow commercial use. |

### Cost notes
- **Supabase Free**: 500 MB database, and the project **pauses after 7 days with no activity**. That's fine for development. For a live shop, move to **Pro (~US$25/month)** to get daily backups and no pausing. Losing sales data is the most expensive failure this system can have.
- Rough storage estimate: about 300 bills/day × 5 lines ≈ 550k rows a year, which is well under 500 MB.

---

## 3. Users, Roles & Permissions

| Role | Who | Can do |
|---|---|---|
| `owner` | Shop owner | Everything: analytics, tax settings, staff management, product delete, purchase scheduling, reports. **Can also use the POS as a cashier.** |
| `supervisor` (admin) | Floor manager or trusted staff | Approve voids, refunds, price overrides, discounts above the limit, and stock adjustments. Can use the POS. |
| `cashier` | Till operator | Scan and sell, take payments, open/close their shift, request a supervisor override. |

### Authentication
- **Owner/supervisor**: Supabase Auth with email and password (plus optional TOTP 2FA for the owner).
- **Cashiers**: sign in quickly on a till that has already been logged in (device session) using a **staff code + 4–6 digit PIN**. The PIN is stored as a bcrypt hash (`pgcrypto`). Cashiers don't need email addresses.
- **Supervisor override credential**: the supervisor **scans the barcode on their staff ID badge and then types their PIN** (the PIN field takes focus automatically after the scan, so it is still quick). **Both are always required.** A stolen badge alone, or a guessed PIN alone, cannot approve anything. Both are stored only as hashes, and the check runs on the server.
  - 3 wrong PIN attempts lock that supervisor's approvals for 5 minutes and notify the owner.
  - The owner, who is already signed in, approves with their **PIN only**. This is still written to the audit log as self-approved.

### Actions that need elevated authorization

| Action | Required |
|---|---|
| Void a scanned line (wrong or double scan) | Supervisor override (badge scan + PIN) **+ scan of the item's barcode** (or, for a spice line without a barcode, select the line) |
| Void a whole bill / cancel sale | Supervisor override |
| Refund / return | Supervisor override |
| Manual price change at the till | Supervisor override |
| Discount above the configurable limit (e.g. 5%) | Supervisor override |
| Stock adjustment (damage, expiry, count correction) | Supervisor or owner |
| Edit product price/cost | Owner (or supervisor if allowed in settings) |
| **Delete (archive) product** | **Owner only + password re-entry**. This is a soft delete. |
| Change tax rates, manage staff, view profit/tax reports | Owner only |

Every one of these goes into `audit_logs` with who requested it, who approved it, the before and after values, the time and the device.

---

## 4. Key Workflows

### 4.1 Checkout (cashier)
1. Cashier is logged in and has an open **shift** with an opening cash float.
2. Scan barcode → look up the product in the local cache → add the line (scanning again increases the quantity).
   - Unknown barcode → show a "Not found" toast. A supervisor can quick-add the product.
   - Items without a barcode (e.g. spices not yet labelled) are added by **clicking the product tile** instead (§4.1b). Both routes end in the same bill line.
   - Your own spice packs get **internally generated EAN-13/Code-128 barcodes** with printable labels (§4.7).
3. Hotkeys: `F2` quantity, `F4` calculator, `F8` void line (asks for a supervisor), `F9` hold bill, `F12` pay.
4. Payment: cash (change is calculated automatically), card, QR (LankaQR), or split payment.
5. On completion, a single `complete_sale` RPC call does all of the following **in one transaction**: inserts the sale, its items and payments, writes `stock_movements` (type `sale`), and returns the receipt number.
6. Print the receipt.

### 4.1b Selling spices by weight (tile route and barcode route)

Each spice has a **price per kg** and a set of **pack sizes** (for example 50 g, 100 g, 250 g, 500 g, 1 kg). Unit items (biscuits, milk packets) have a single price and no pack sizes.

**Route A: no barcode (click / keyboard)**
```
Click the "Curry Powder" tile (or arrow to it and press Enter)
  → Weight picker opens, showing the product image and price per kg
       [1] 50 g   Rs 90      [2] 100 g  Rs 180     [3] 250 g  Rs 450
       [4] 500 g  Rs 900     [5] 1 kg   Rs 1,800   [6] Custom…  ____ g
       Packets: [ 1 ]        Live line price:  250 g × 1  =  Rs 450.00
  → Press the number key (or click a size, or type grams), then Enter
  → Line added: "Curry Powder 250 g   × 1   Rs 450.00"
```
**Route B: barcode (scan)**
```
Scan the pack's barcode → pack_size found → same line "Curry Powder 250 g × 1 Rs 450.00"
```
- Both routes produce the **identical bill line**: product, weight, packets, price. The price for the chosen weight is always visible as you pick it, and it matches what the barcode would give.
- **Price rule:** each pack size has its **own fixed price** (a 50 g packet is usually dearer per kg than a 1 kg packet), and prices include tax. The per-kg price is optional. It is used for reporting and, if the owner enables it, for custom weights.
- **Custom weight:** **off by default**, since the shop sells fixed branded packets. The owner can switch it on for a product, and the line price is then `price per kg × grams ÷ 1000` (rounded to the shop's rounding setting), which deducts from bulk stock. If a scale is added later, a `Read from scale` button can fill the weight field.
- **Stock deduction:** selling a packet deducts **one packet from that pack size's own count** (50 g, 250 g, 500 g and 1 kg stocks are separate). The owner also sees one total per spice in **kg equivalent** (bulk kg + packets × pack weight), and low-stock alerts work per pack size.
- **Barcodes can be added later without touching history.** Each pack size is its own record, and a barcode is just attached to it. The settings page has an **"Assign barcodes"** tool: it generates an EAN-13 for every pack size and prints a label sheet. Scanning works the moment a barcode is attached. Old bills are unchanged.
- **Weight-embedded labels (optional, later):** if the shop later prints labels with the weight or price inside the barcode (for custom weights like 375 g), `parseWeighted` reads them. It is off by default.
- The same logic applies to anything else sold by weight.

### 4.2 Supervisor line void (Keels-style)
```
Cashier presses F8 / "Remove item"
  → Modal: "Supervisor required" → supervisor scans their badge, then types their PIN (both required)
  → Modal: "Scan item to remove" → supervisor scans the product barcode
  → System finds the matching active line in the current bill
       (if qty > 1: ask how many to remove)
  → Select reason: Wrong item / Double scan / Customer changed mind / Price issue
  → RPC void_sale_item(sale_id, barcode, qty, reason, supervisor_credential)
       - verifies the credential server-side (SECURITY DEFINER function)
       - marks the line `voided` (never deleted), records voided_by + reason
       - writes audit_logs
  → Line shows struck-through on screen and the total updates
```
Doing the void **before payment** means no stock movement has been written yet, so there's nothing to reverse. Voids **after payment** are refunds. A refund writes a `return` stock movement.

> Voids are tracked per cashier and per supervisor. A high void rate is a classic sign of theft, so it is shown on the owner's dashboard.

### 4.3 Owner as cashier
The owner uses the same `/pos` screen. Because their role already covers supervisor rights, override prompts are approved automatically, but they are still written to the audit log as self-approved.

### 4.4 Low-stock alert
- A trigger on `stock_movements` updates `products.stock_on_hand`.
- If stock falls to or below `reorder_level` (or the forecast says **days of cover < lead time**), it creates one `notifications` row. Duplicates are prevented until the product is restocked.
- The owner's dashboard gets it instantly through **Supabase Realtime** (bell icon + badge).
- A daily 8 AM pg_cron job emails a digest of low and out-of-stock items through an Edge Function.

### 4.5 Purchasing & scheduling
1. **Reorder Suggestions** page lists every product with its forecast demand, current stock, quantity already on order, and the **suggested order quantity**. Products are grouped by supplier.
2. Owner selects items → **Create Purchase Order** (draft) → sets the **scheduled purchase/delivery date**.
3. A calendar view shows upcoming purchase dates. Recurring schedules are supported (e.g. "Supplier X every Monday").
4. Reminder notification the day before.
5. **Receive goods**: scan items in, enter received quantity and actual cost. This writes `purchase` stock movements, updates the cost price, and records **input VAT** paid.

### 4.6 Month-end summary
pg_cron runs on the 1st of each month at 00:30 and builds a `monthly_summaries` row for the previous month. The owner can also generate one on demand, view it, and export it to PDF/CSV.

### 4.7 Spice production (raw → dried → ground → packed)
Raw material is a stock item too (unit `kg`). Finished spice is either kept as **bulk powder in kg** (sold by weight, made to order) or packed into **pre-packed pack sizes** (§4.1b), or both.

```
1. Buy raw chilli            → purchase order received      → raw stock +480 kg   (cost Rs X/kg)
2. Start a production run    → pick the raw material and the weight issued (e.g. 480 kg wet)
3. Record drying output      → weight after sun-drying (e.g. 150 kg)         → drying loss 68.7%
4. Record grinding output    → weight of powder (e.g. 142 kg)                → grinding loss 5.3%
5. Record packing            → packs produced per SKU (e.g. 400 × 250 g, 420 × 100 g)
                               + weight left over / wasted
6. Close the run             → one transaction:
     raw stock −480 kg (type 'production_in'),
     finished packs +N (type 'production_out'),
     cost per pack = (raw cost + extra costs: labour, gas/power, packaging) ÷ packs
```
- Overall **yield %** (finished kg ÷ raw kg issued) is stored for every run. The owner sees yield trends and compares one supplier's chilli against another's.
- Extra costs (labour, drying, packaging materials) can be added to a run, so each pack's **cost** and **margin** are accurate. This also feeds COGS for the monthly summary.
- **Packaging materials** (empty pouches, labels) are trade/raw items consumed when a run is packed. They get low-stock alerts like anything else.
- **Pack label barcodes:** the app generates a barcode for each of your own SKUs and lets you print the labels (A4 sheet via PDF now, label printer later).
- Raw material can be **bulk-sold** (business packs, e.g. 5 kg or 25 kg) as normal products. These are produced as finished SKUs the same way.
- Batch/expiry: finished packs inherit a batch number and a best-before date from the production run (§7 batches).
- **Packing step choices:** powder from the grind goes into **bulk stock (kg)**, or straight into **branded packets** of chosen sizes, or is split between the two. Packing can also be done later, outside a production run (§4.7b).

### 4.7b Packing at the shop (bulk powder → branded packets)
Staff weigh the powder and seal it into branded packets, sometimes the same day as grinding and sometimes later as stock runs low. A quick **Pack Stock** screen records it in seconds:
```
Pack Stock  →  choose the spice (e.g. Curry Powder)
            →  choose pack size and enter packets made:  250 g × 120,  500 g × 40,  1 kg × 10
            →  optional: wastage / spillage (g)
            →  Save → one transaction:
                 bulk powder −(120×0.25 + 40×0.5 + 10×1) kg = −60 kg  (+ wastage)
                 packets: 250 g +120, 500 g +40, 1 kg +10
                 packaging: matching branded pouches −120 / −40 / −10
                 packing_logs row (who, when, batch no, best-before)
```
- Each pack size is linked to its **branded pouch** (a packaging item), so pouches are deducted automatically and run out alerts work.
- The screen warns when the bulk powder isn't enough.
- Each packing session gets a **batch number, a manufacture date (defaults to today) and an expiry date (defaults to manufacture date + the product's shelf life)**, so expiry tracking works per packet batch.
- Printing the matching barcode labels is one click from the same screen (§4.1b "Assign barcodes").

### 4.8 Returnable glass milk bottles (milk LKR 250 + LKR 100 non-return fee)
Glass-bottle milk is a normal product priced at **LKR 250**. The customer is expected to hand back an empty bottle when buying. **If they don't, a LKR 100 penalty fee is added to the bill.** This is a charge, not a refundable deposit, so nothing is held for the customer.

| Situation | What the cashier does | Result |
|---|---|---|
| Customer buys milk **and hands back an empty bottle** | Scan milk, press `F7` **Bottle returned** (once per empty) | Bill LKR 250. No fee. Empty-bottle stock +1. |
| Customer buys milk **without an empty** | Scan milk. The system **automatically adds a "Bottle not returned" LKR 100 line** | Bill LKR 350. The bottle is recorded as outstanding. |
| Customer buys 3 milks and returns 2 empties | Scan ×3, `F7` ×2 | Fee applies to 1 bottle: 3 × 250 + 100 = LKR 850. |
| Customer brings an empty later (no purchase) | `F7` on an empty cart → **Late return** | Bottle accepted, empties +1, outstanding −1. **No refund of the earlier fee** by default (a supervisor can waive or refund it, if the owner allows). |

- The fee line is `kind = fee`. The cashier **cannot delete it**. Only a supervisor (badge + PIN) can waive it, and every waiver is audited.
- The fee counts as **shop income** in the monthly summary under "Bottle fees". Whether VAT applies to it is a tax-category setting, so the accountant can confirm.
- **Bottle stock** is tracked: full bottles, empties awaiting the dairy's collection, and bottles outstanding with customers (sold − returned).
- For a recorded customer, their personal outstanding bottle count is kept, which is a useful reminder for regulars.
- The dairy's collection of empties is recorded as a movement, so empties on hand stay correct.
- The `/bottles` page shows bottles not returned and the fees collected for the month.

### 4.9 Cash handling without a drawer
- Cash is physically kept somewhere separate, and **every movement is recorded in the POS** so the shift balance reconciles:
  - Opening float at shift start.
  - **Cash sales** (tendered and change due are recorded on every bill).
  - **Paid-in / paid-out** entries (`cash_movements`): float top-up, supplier paid from the till, supervisor-approved bottle-fee refunds, owner withdrawals. Each has a reason, and paid-outs above a limit need a supervisor.
  - At shift close the cashier counts the cash, and the app shows **expected vs counted, with the difference** (over/short).
- When a drawer is added later, the only change is a "kick drawer on payment" switch in settings.

---

## 5. Analytics & Forecasting (all in SQL, so it costs nothing extra)

A nightly job (pg_cron, 01:00) rolls sales up into `daily_product_sales(product_id, date, qty, revenue, cost)`. Every analytic below reads from that small table, not from raw sales.

### 5.1 Fast-moving products
- **Velocity** = average units sold per day over 7, 30 and 90 days.
- **ABC classification** by revenue: A = top 80% of revenue, B = next 15%, C = last 5%.
- **Movement class**: Fast / Medium / Slow / **Dead stock** (no sales in 30+ days, so cash is sitting on the shelf).
- Also shown: top/bottom 10 by quantity, revenue and margin, sales by hour of day and day of week (to plan staffing), and category breakdown.

### 5.2 Demand forecast & reorder quantity
The method is simple, explainable and cheap. It is the right fit for a shop without years of data:

```
daily_forecast  = weighted moving average of the last 28 days
                  (recent weeks weighted more)
                  × day-of-week factor (e.g. Saturdays sell 1.4× average)
safety_stock    = z × σ(daily sales) × √(lead_time_days)        z = 1.65 → ~95% service level
reorder_point   = daily_forecast × lead_time_days + safety_stock
order_qty       = daily_forecast × (lead_time_days + days_until_next_purchase)
                  + safety_stock − stock_on_hand − qty_on_order
                  → rounded up to the supplier's pack size (e.g. cases of 24)
days_of_cover   = stock_on_hand / daily_forecast
```
- `lead_time_days`, `pack_size` and the purchase cycle are stored per product or supplier.
- New products with fewer than 14 days of history fall back to their manual `reorder_level`.
- Later upgrade path: Holt-Winters exponential smoothing, plus festival-season multipliers (Avurudu in April, Christmas, Vesak).

### 5.4 Raw-material planning (spice side)
Forecasting works at two levels:
1. **Finished packs:** the normal forecast above, per SKU.
2. **Raw material:** demand for each SKU is converted back to raw kg using the recent average **yield %**:
   `raw_kg_needed = Σ (forecast packs × pack weight) ÷ average yield`
   - **Drying and grinding capacity** and weather matter. The owner can enter a "max kg per week" capacity so suggestions don't exceed it.
   - **Harvest/season buying:** chilli is often cheaper in season. A **seasonal stock-up** suggestion compares months of stock cover against shelf life, so the owner can buy more when the price is low and still avoid overbuying.
   - Also shown: dry-chilli stock in kg, days of cover, and the **cost per kg trend** for each supplier.
- The same low-stock rule applies to **packaging materials** (pouches, labels), with a lead time and reorder level.

### 5.3 Owner dashboard (home)
Today's sales, bill count, average basket size, gross profit, low-stock count, upcoming purchases, voids today, a 30-day sales trend, top movers, and a cashier performance table.

---

## 6. Tax & Financials

- `tax_rates` table: name, rate %, `effective_from`. Rates change by law, so historical bills keep the rate that applied when they were made. Each product links to a tax category (Standard / Exempt / Zero-rated). Many basic food items in Sri Lanka are VAT-exempt.
- Shop setting: **prices are VAT-inclusive or VAT-exclusive**.
- Each `sale_item` stores `tax_rate` and `tax_amount` **at the time of sale** (a snapshot, not a lookup).
- `expenses` table: rent, electricity, salaries, transport and so on, with a category, an amount, an optional input-tax amount, and a receipt photo (Supabase Storage).
- Other configurable levies (e.g. SSCL) and an estimated income tax % on profit.
- **Bottle non-return fees** are shown on their own line ("Bottle fees"). Their VAT treatment is a setting to confirm with the accountant.
- **Raw produce and some packed foods may be VAT-exempt or taxed differently.** The tax category is set per product, so the accountant can confirm each one.
- **Input VAT** is claimed on raw purchases and packaging only where the supplier's invoice carries VAT. The PO receive screen records it per invoice.

**Monthly summary contains:**
| Section | Figures |
|---|---|
| Sales | Gross sales, discounts, refunds/voids, net sales, number of bills, average bill value |
| Cost | COGS (from the cost snapshot on each sale line), gross profit, gross margin % |
| Expenses | Total by category |
| Profit | Net profit = gross profit − expenses |
| Tax | Output VAT collected − input VAT paid (purchases + expenses) = **VAT payable**. Other levies. Estimated income tax. |
| Inventory | Closing stock value, purchases made, top 10 movers, dead stock |
| Control | Voids/refunds by cashier, cash-drawer over/short per shift |

> ⚠️ Tax rules and registration thresholds change. Keep every rate configurable, and have the shop's accountant confirm the setup. The app produces estimates, not filed returns.

---

## 7. Database Schema (Supabase / Postgres)

All tables have `id uuid pk default gen_random_uuid()` and `created_at timestamptz` unless noted.
A `store_id` column is included from the start so multi-branch support is cheap to add later.

```text
── Organisation & people ─────────────────────────────────
stores              (name, address, phone, vat_no, currency='LKR', prices_include_tax bool,
                     max_cashier_discount_pct, receipt_footer)
profiles            (id = auth.users.id | null for PIN-only staff, store_id, full_name,
                     staff_code unique, role enum[owner|supervisor|cashier],
                     pin_hash, badge_code_hash, is_active)
devices             (store_id, name, last_seen_at)                 -- registered tills

── Catalogue ─────────────────────────────────────────────
categories          (store_id, name, parent_id)
suppliers           (store_id, name, phone, email, lead_time_days, order_cycle_days, notes)
tax_rates           (store_id, name, rate_pct, effective_from, effective_to)
products            (store_id, sku, name, category_id, supplier_id, tax_category,
                     unit enum[pcs|kg|g|l|ml], cost_price, sell_price,
                     sale_mode enum[unit|weighted],    -- weighted = priced per kg, picked by weight
                     price_per_kg numeric, min_weight_g, weight_step_g, rounding_rule,
                     stock_on_hand numeric,            -- unit items: pieces. weighted: BULK kg. Trigger-maintained.
                     reorder_level, pack_size, lead_time_days (override),
                     kind enum[raw_material|packaging|finished|trade|fee],
                     has_expiry bool, shelf_life_days (default expiry for own packs), image_path, thumb_path, is_favourite bool, sort_order,
                     is_active bool default true, archived_at, archived_by)
pack_sizes          (product_id, label '250 g', weight_g, price_override (nullable),
                     is_prepacked bool default true,   -- true: own packet stock (the shop's normal case);
                                                       -- false: only for the optional custom-weight mode
                     packets_on_hand numeric,          -- used when is_prepacked
                     packaging_product_id,             -- the branded pouch consumed per packet packed
                     sort_order, hotkey 1-9, is_active)
product_barcodes    (product_id, pack_size_id nullable, barcode unique per store, is_primary)
                     -- unit item: product barcode. spice: one barcode per pack size.

── Production (spice side) ──────────────────────────────
production_runs     (store_id, run_no, raw_product_id, raw_issued_kg, raw_unit_cost,
                     dried_kg, ground_kg, packed_kg, wastage_kg,
                     extra_costs jsonb [{label, amount}], yield_pct,
                     status enum[open|closed], started_at, closed_at, closed_by,
                     notes)
production_outputs  (run_id, product_id, packs_produced, batch_no, best_before, unit_cost)
production_inputs   (run_id, product_id, qty, unit_cost)   -- packaging materials consumed
packing_logs        (store_id, product_id, pack_size_id, packets_made, bulk_kg_used, wastage_g,
                     batch_no, best_before, packed_by, created_at)   -- from the Pack Stock screen

── Returnable bottles ────────────────────────────────────
bottle_ledger       (store_id, product_id, customer_id nullable, qty_change,
                     type enum[sold|returned_with_purchase|returned_later|fee_charged|
                               fee_waived|fee_refunded|collected_by_dairy], sale_id, amount, created_by)
                     -- empties on hand and bottles outstanding are derived from this ledger

── Cash handling ─────────────────────────────────────────
cash_movements      (shift_id, type enum[float|paid_in|paid_out|bottle_refund|owner_draw],
                     amount, reason, approved_by, created_by)

── Customers, credit & promotions ───────────────────────
customers           (store_id, name, phone, credit_limit, balance_owed, notes)
customer_payments   (customer_id, amount, method, received_by)   -- settling a credit balance
promotions          (store_id, name, type enum[percent|amount|buy_x_get_y], value,
                     product_id | category_id, buy_qty, free_qty, starts_at, ends_at, is_active)

── Inventory ledger (source of truth for stock) ──────────
product_batches     (product_id, pack_size_id nullable, batch_no, manufacture_date, expiry_date,
                     qty_received, qty_remaining, unit_cost,
                     purchase_order_id, received_at)           -- FEFO: first-expiry-first-out
                     -- products with has_expiry=true sell from the earliest-expiring batch;
                     -- stock_movements carry a batch_id;
                     -- a daily job raises `expiry_soon` notifications (e.g. 14 days before)
stock_movements     (store_id, product_id, qty_change numeric (+/-),
                     type enum[sale|return|purchase|adjustment|void|opening],
                     ref_table, ref_id, unit_cost, reason, created_by)

── Sales ─────────────────────────────────────────────────
shifts              (store_id, device_id, cashier_id, opened_at, closed_at,
                     opening_float, expected_cash, counted_cash, over_short)
sales               (store_id, shift_id, cashier_id, receipt_no (sequence per store),
                     status enum[open|held|completed|cancelled|refunded],
                     subtotal, discount_total, tax_total, grand_total, completed_at,
                     client_created_at)            -- client UUID for offline sync
sale_items          (sale_id, product_id, pack_size_id nullable, barcode_scanned (null if tile route),
                     weight_g nullable, price_per_kg_snapshot, name_snapshot, qty,
                     unit_price, cost_snapshot, discount, tax_rate, tax_amount, line_total,
                     status enum[active|voided], voided_by, void_reason, voided_at)
payments            (sale_id, method enum[cash|card|qr|credit], amount, tendered, change, ref)
                     -- 'credit' increases customers.balance_owed; requires sales.customer_id
                     -- sales also gets: customer_id (nullable), promo_discount
refunds             (sale_id, approved_by, reason, amount)  + refund_items

── Purchasing ────────────────────────────────────────────
purchase_orders     (store_id, supplier_id, status enum[draft|scheduled|ordered|received|cancelled],
                     scheduled_date, recurrence_rule (nullable, e.g. 'WEEKLY:MON'),
                     expected_total, received_at, invoice_no, input_tax_amount, created_by)
purchase_order_items(po_id, product_id, suggested_qty, ordered_qty, received_qty, unit_cost)

── Money & tax ───────────────────────────────────────────
expense_categories  (store_id, name)
expenses            (store_id, category_id, amount, input_tax_amount, date, note,
                     receipt_path, created_by)

── Analytics (filled by cron) ────────────────────────────
daily_product_sales (store_id, product_id, date, qty, revenue, cost)      pk(product_id,date)
product_forecasts   (product_id, computed_at, avg_daily, dow_factors jsonb, std_dev,
                     safety_stock, reorder_point, suggested_qty, days_of_cover,
                     abc_class, movement_class)
monthly_summaries   (store_id, month date, data jsonb, generated_at)

── Control ───────────────────────────────────────────────
notifications       (store_id, type enum[low_stock|out_of_stock|purchase_due|high_voids|system],
                     product_id, po_id, title, body, is_read, resolved_at)
audit_logs          (store_id, action, entity, entity_id, requested_by, approved_by,
                     before jsonb, after jsonb, reason, device_id)
settings            (store_id, key, value jsonb)
```

### Important DB rules
- **No hard deletes** on products, sales or sale_items. Products are archived (`is_active=false`). Archived products disappear from POS search but stay in historical reports.
- `stock_on_hand` is updated **only** by a trigger on `stock_movements`. The client is never allowed to set it.
- All money columns use `numeric(12,2)`. Never use floats.
- Indexes: `product_barcodes(store_id, barcode)`, `sales(store_id, completed_at)`, `sale_items(sale_id)`, `stock_movements(product_id, created_at)`, `daily_product_sales(store_id, date)`.

### Server-side functions (Postgres RPC, `SECURITY DEFINER`)
| Function | Purpose |
|---|---|
| `complete_sale(payload jsonb)` | Transactional: sale + items + payments + stock movements |
| `verify_supervisor(badge_code, pin, action)` | Checks **both** the badge hash and the PIN hash, enforces the 3-attempt lockout, and returns a **short-lived approval token** (expires after 60 s, single use, tied to one action) |
| `void_sale_item(sale_id, barcode, qty, reason, approval_token)` | Keels-style void |
| `refund_sale(...)`, `adjust_stock(...)`, `override_price(...)` | Require an approval token |
| `archive_product(product_id, reason)` | Owner only, audited |
| `receive_purchase_order(po_id, items jsonb)` | Stock in + cost update |
| `refresh_daily_sales()`, `compute_forecasts()`, `generate_monthly_summary(month)` | Called by pg_cron |

### RLS (summary)
- Every table: a user only sees rows where `store_id` matches their profile.
- `cashier`: SELECT on products/barcodes/categories. INSERT sales **only via RPC**. No direct UPDATE/DELETE on anything.
- `supervisor`: plus stock adjustments (via RPC) and viewing sales.
- `owner`: full access to their store, including financial tables (`expenses`, `monthly_summaries`, `tax_rates`, cost prices).
- Cost price and profit columns are hidden from cashiers through views (`products_public`).

### Scheduled jobs (pg_cron)
| When | Job |
|---|---|
| Daily 01:00 | `refresh_daily_sales()` → `compute_forecasts()` |
| Daily 08:00 | Low-stock and purchase-due digest (Edge Function → email) |
| 1st of month 00:30 | `generate_monthly_summary(previous month)` |
| Every 5 min (Phase 2) | Clean up expired approval tokens |

---

## 8. Screens

### POS (cashier, supervisor, owner)
- `/login` — owner/supervisor email login, plus till PIN login
- `/pos` — main checkout: scan bar, cart table, totals, hotkey bar, **calculator drawer**, held bills
- `/pos/shift` — open/close shift, cash count
- `/pos/history` — today's bills, reprint receipt, start a refund (needs a supervisor)

### Back office (owner; parts visible to supervisor)
- `/dashboard` — KPIs, alerts, sales trend, top movers
- `/products` — list, add/edit, barcodes, bulk CSV import, archive (owner + re-auth)
- `/inventory` — stock levels, movement history, stock adjustment, stock take
- `/analytics` — fast movers, ABC, dead stock, hourly heatmap, forecasts
- `/purchasing/suggestions` — reorder suggestions → create PO
- `/purchasing/calendar` — scheduled purchase dates (month/week view)
- `/purchasing/orders/[id]` — PO detail, receive goods by scanning
- `/production` — runs list, new run wizard (issue raw → dried → ground → packed), yield and cost reports, pack-label printing
- `/bottles` — full/empty/outstanding bottle counts, non-return fees collected, collections by the dairy
- `/suppliers`
- `/expenses`
- `/reports/monthly` — month-end summary, PDF/CSV export
- `/reports/tax` — VAT collected vs paid, payable
- `/staff` — add staff, set role, reset PIN, print badge barcodes
- `/audit` — audit log viewer with filters
- `/settings` — store info, tax rates, discount limits, receipt layout, notification email

### 8a. Keyboard System

Principles: the checkout screen never needs a mouse. Focus always returns to the scan input after any dialog closes. Every shortcut is also a visible button, so mouse use still works. Shortcuts are defined in one registry (`lib/keyboard/shortcuts.ts`), which drives the key handler, the cheat sheet, the command palette and the remapping screen.

| Key | Action |
|---|---|
| *(scan / type code + Enter)* | Add item |
| `5*` then scan | Quantity prefix: add 5 of the next scanned item |
| `↑ / ↓` | Move between cart lines |
| `+ / −` | Change quantity of the selected line |
| `Del` | Remove the selected line, which asks for a supervisor (badge scan + PIN, then item scan or line select) |
| `F2` | Edit quantity of the selected line |
| `F3` | Product search by name or code (arrows pick, Enter adds) |
| `F4` | Calculator drawer |
| `F5` | Attach customer (search by name/phone) |
| `F6` | Bill discount (supervisor above the limit) |
| `F8` | Void line or cancel bill (supervisor) |
| `F9` | Hold bill, or open the held-bills list to recall one |
| `F10` | Quick pay: exact cash |
| `F12` or `Enter` on an empty scan bar | Open payment |
| In the payment dialog: `1` Cash, `2` Card, `3` QR, `4` Credit, `Tab` splits the payment | Type the tendered amount + `Enter` to show the change due |
| `Ctrl+K` | Command palette: search any action, page or product |
| `?` | Shortcut cheat sheet |
| `Esc` | Close dialog and return focus to the scan bar |
| `Ctrl+L` | Lock the till (PIN to resume) |

- **Remappable:** the owner can rebind keys in `/settings/keyboard`. Bindings are stored in the `settings` table, with conflict detection and a reset-to-default button.
- **Back office:** `g` then `d`/`p`/`i`/`a` jumps to Dashboard/Products/Inventory/Analytics, `n` creates a new item in the current list, and `/` focuses the search box.
- **Scanner vs typing:** the scan buffer (see §9) ignores human-speed typing. The quantity prefix is accepted only when typed at human speed.
- Large focus rings, no focus traps, and a `prefers-reduced-motion` option.

### 8b. POS Screen: Product Grid & Weight Picker

```
┌────────────────────────────────────────────┬───────────────────────────────┐
│ [ Scan or type code ........ ]   F3 Search │  BILL #10231        Cashier: A │
│ ─ Favourites │ Spices │ Biscuits │ Milk │ … │  Curry Powder 250 g ×1  450.00 │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐    │  Marie Biscuit      ×2  240.00 │
│ │ img │ │ img │ │ img │ │ img │ │ img │    │  Milk (glass)       ×1  250.00 │
│ │Curry│ │Chili│ │Marie│ │Milk │ │Turm.│    │  Bottle not returned    100.00 │
│ │/kg  │ │/kg  │ │ 120 │ │ 250 │ │/kg  │    │ ──────────────────────────────│
│ └─────┘ └─────┘ └─────┘ └─────┘ └─────┘    │  Subtotal           1,040.00 │
│  …                                          │  TOTAL              1,040.00 │
│ F2 Qty  F4 Calc  F5 Customer  F7 Bottle     │  [F12 Pay]  [F9 Hold]         │
│ F8 Void F9 Hold  F10 Exact cash             │                               │
└────────────────────────────────────────────┴───────────────────────────────┘
```
- **Tiles:** a picture, the name, and either the price (unit items) or "Rs X/kg" (weighted items). Low-stock and out-of-stock tiles show a small badge, and out-of-stock tiles are dimmed but still sellable if the owner allows it.
- **Unit item** (biscuits, milk packets): one click or `Enter` adds 1. Holding a quantity prefix (`5*`) adds 5.
- **Weighted item** (curry powder): opens the weight picker (§4.1b) with the preset sizes on number keys, a custom-gram field, and the live price.
- **Category tabs and Favourites:** `Ctrl+1…9` switches tab. The owner marks favourites (the 20–30 fastest sellers) and orders them.
- **Keyboard:** `Tab` moves focus between scan bar, grid and cart. In the grid, arrows move between tiles, `Enter` selects, and typing letters jumps to the matching product name (type-ahead). `Esc` returns to the scan bar. The mouse and touch work for everything.
- **Images:**
  - Uploaded to Supabase Storage, **resized in the browser to about 400 px WebP (20–40 KB)** before upload, because Supabase's server-side image resizing is a paid feature.
  - A small thumbnail is stored too, for the grid.
  - Images are **cached on the till** with the product list, so tiles still show with no internet.
  - Products without a picture show a coloured tile with initials. A missing picture never blocks selling.
  - The camera or any file picker can be used to add a picture.
- **Grid vs scan:** the scan bar is always active, even while the grid is showing, so a scanned barcode and a clicked tile can be mixed freely within one bill.

### Calculator
- A slide-out panel on the POS (`F4`) that also works from the back office.
- Basic arithmetic, a memory key, and a **"Tender" mode**: enter the cash given and see the change due.
- Keyboard-driven (numpad), pure client-side, and never touches the bill.

---

## 9. Project Structure

```text
pos-system/
├─ app/
│  ├─ (auth)/login/
│  ├─ (pos)/pos/                 # checkout, shift, history
│  ├─ (admin)/                   # layout guarded by role
│  │  ├─ dashboard/  products/  inventory/  analytics/
│  │  ├─ purchasing/{suggestions,calendar,orders}/
│  │  ├─ suppliers/  expenses/  reports/{monthly,tax}/
│  │  └─ staff/  audit/  settings/
│  └─ layout.tsx
├─ components/
│  ├─ pos/          # Cart, ScanInput, ProductGrid, WeightPicker, TotalsPanel, PaymentDialog, SupervisorOverrideDialog
│  ├─ calculator/   # Calculator, TenderMode
│  ├─ analytics/    # charts, KPI cards
│  └─ ui/           # shadcn components
├─ features/        # domain logic per module (sales, inventory, purchasing, tax, auth)
│  └─ <module>/{api.ts, hooks.ts, types.ts, schema.ts(zod)}
├─ lib/
│  ├─ supabase/{client.ts, server.ts, middleware.ts}
│  ├─ barcode/{useScanner.ts, generateEan13.ts, labels.tsx, parseWeighted.ts (optional), camera.ts}
│  ├─ money.ts      # rounding, tax math (unit-tested)
│  ├─ print/receipt.tsx
│  └─ offline/      # Phase 2: dexie db, sync queue
├─ supabase/
│  ├─ migrations/   # 0001_core.sql, 0002_sales.sql, 0003_rls.sql, 0004_rpc.sql, 0005_cron.sql …
│  ├─ functions/    # edge functions: send-digest, monthly-report-pdf
│  └─ seed.sql      # demo store, products, staff
├─ types/database.ts  # generated: supabase gen types typescript
├─ tests/           # vitest (money/tax/forecast), playwright (checkout + void flow)
├─ middleware.ts    # route protection by role
└─ PLAN.md
```

### Barcode scanner hook (how HID detection works)
A scanner "types" characters very quickly (under ~30 ms between keys) and ends with `Enter`. `useScanner` listens globally, puts fast keystrokes into a buffer, and fires `onScan(code)` when it sees `Enter`. A human typing slowly is ignored, so scans work even when no input box has focus.

---

## 10. Build Phases

| Phase | Scope | Outcome |
|---|---|---|
| **0. Setup** (≈2 days) | Repo, Next.js, Supabase project, CLI migrations, type generation, CI lint/test | Skeleton deployed |
| **1. Core data + auth** (≈1 week) | Stores, profiles, roles, RLS, login + PIN login, products/pack sizes/barcodes CRUD, product image upload (resized in the browser), CSV import | Owner can load the catalogue |
| **2. POS checkout + offline + keyboard** (≈3 weeks) | Scan hook, keyboard registry (§8a), **product-image grid + weight picker (§4.1b, §8b)**, cart, quantity prefix, hold/recall, `complete_sale`, payments (cash/card/QR), on-screen + PDF receipt, shifts, calculator, **Dexie product cache + offline sale queue + sync** | Shop can sell, even offline |
| **3. Overrides & audit** (≈1 week) | Supervisor badge + PIN approval, lockout, approval tokens, line void, bill cancel, cash refunds, price override, audit log, archive product | Keels-style control |
| **4. Inventory, batches & alerts** (≈1.5 weeks) | Stock ledger trigger, adjustments, stock take, **expiry batches (FEFO)**, low-stock + expiry notifications, Realtime bell, email digest, PWA push | Owner knows what's running out or expiring |
| **5. Purchasing** (≈1 week) | Suppliers, POs, scheduling calendar, recurring + ad hoc, receive by scan with expiry date | Restocking loop closed |
| **6. Production & bottles** (≈2 weeks) | Raw/packaging/finished product kinds, production runs with yield and cost, internal barcode + label generation, **Pack Stock screen (bulk → branded packets, pouch deduction)**, bottle non-return fee rules (`F7`), bottle ledger, "Assign barcodes" tool for spice pack sizes, cash-in/cash-out records | The spice side and milk bottles work end to end |
| **7. Customers, credit & promotions** (≈1 week) | Customer records, credit sales and settlements, promotion engine | Credit and offers work at the till |
| **8. Analytics & forecast** (≈2 weeks) | Daily rollups, fast movers, ABC, dead stock, pack forecast, **raw-material planning from yield**, dashboard | Data-driven buying |
| **9. Tax & reports** (≈1 week) | Tax rates (VAT, other levy, income-tax estimate), expenses, monthly summary job (incl. production cost and bottle fees), PDF/CSV export | Month-end in one click |
| **10. Hardening** (≈1 week) | Backups (Pro upgrade), thermal-printer driver + cash-drawer kick (when hardware arrives), WhatsApp/email receipt sending, remappable-keys UI, Playwright end-to-end tests, training mode | Production-ready |

---

## 11. Still Open

1. **Product and size list:** which spices and which sizes does each one come in? This is needed for the first data import and does not block the design. (The plan assumes a fixed price per size.)
2. **Branded pouches:** are pouches bought separately for each size? If so, each pack size gets its own pouch item for automatic deduction.
3. **Late bottle returns (undecided by the owner):** if a customer pays the LKR 100 fee and brings the bottle back later, is it refunded? This is built as an **owner setting**, not hard-coded, so it can be decided any time: *No refund* (default), *Refund within N days with supervisor approval*, or *Always waive on return*.
4. **Offline rules:** how long may a till stay offline, and should the offline till refuse credit sales and supervisor voids it cannot verify? (Recommended: yes, offline allows only cash/card/QR sales.)
5. **Existing data:** is there a current product list (Excel/CSV or an old system) to import?
6. **Who builds and maintains this**, and when should the shop go live? This sets the realistic timeline (the phases total about 12 weeks for one developer).
