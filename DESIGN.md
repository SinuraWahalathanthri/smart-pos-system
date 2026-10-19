# POS System — Design Plan

Companion to [PLAN.md](PLAN.md). This document covers how the system **looks and behaves**: visual language, layout, screens, interaction rules and the order in which to design them. Colours and fonts are proposals until the shop confirms its brand (see §12).

---

## 1. Design Goals

| # | Goal | What it means in practice |
|---|---|---|
| 1 | **Speed over decoration** | A cashier serves a customer in seconds. Every checkout action is reachable by keyboard, and the screen never makes the cashier hunt for the next step. |
| 2 | **Impossible to misread** | Prices, quantities, weights and the total are the largest things on screen. Money is always shown as `LKR 1,234.00` in a fixed-width (tabular) font so columns line up. |
| 3 | **Mistakes are visible and recoverable** | Voids show struck-through, not gone. A wrong scan is obvious at a glance, with sound and colour. |
| 4 | **Calm under pressure** | Low visual noise, a restrained palette, and colour reserved for meaning (red = problem, amber = attention, green = done). |
| 5 | **Works on modest hardware** | A cheap 1366×768 laptop, a USB scanner, sometimes a flaky connection. No heavy animation, no big downloads at the till. |
| 6 | **Two products in one** | The **till** (cashier) is dense and fast. The **back office** (owner) is spacious and analytical. They share one design system but use different layouts. |

---

## 2. Users & Contexts

| User | Where | Device | Needs |
|---|---|---|---|
| Cashier | Counter, standing, customer waiting | Laptop/PC, USB scanner, keyboard (mouse secondary) | Speed, zero ambiguity, big numbers, never lose the bill |
| Supervisor / owner at the till | Counter | Same | Fast override flow (badge scan + PIN), clear audit feedback |
| Owner in the back office | Desk, phone, evenings | Laptop, sometimes phone | Dashboards, alerts, decisions (what to buy, what is selling), month-end reports |
| Packing staff | Packing area | Same PC | Simple Pack Stock and production forms with big inputs |

Design for the **till first**, since a slow or confusing till costs money every minute.

---

## 3. Visual Language

### 3.1 Colour tokens (CSS variables, light and dark)
Warm neutrals suit a spice shop and are easier on the eyes over a long shift. Colour is reserved for meaning.

| Token | Light | Dark | Used for |
|---|---|---|---|
| `--bg` | `#FAF8F5` | `#16130F` | Page background |
| `--surface` | `#FFFFFF` | `#201C17` | Cards, panels, bill |
| `--surface-2` | `#F2EEE8` | `#2A251F` | Rows, tiles, inputs |
| `--border` | `#E3DDD3` | `#3A332B` | Dividers |
| `--text` | `#1F1A14` | `#F3EEE6` | Body text |
| `--text-muted` | `#6B6257` | `#A89F92` | Labels, hints |
| `--primary` | `#1D4ED8` | `#6B93F5` | Main actions (Pay, Save), focus ring |
| `--accent` | `#C2410C` | `#F0743F` | Brand highlights, favourites ★ (placeholder until brand colours are known) |
| `--success` | `#15803D` | `#4ADE80` | Paid, in stock, scan OK |
| `--warning` | `#B45309` | `#FBBF24` | Low stock, expiring soon, offline queue |
| `--danger` | `#B91C1C` | `#F87171` | Void, out of stock, errors, supervisor-required |

- Contrast: text on surface meets **WCAG AA (4.5:1)**; the big total meets AAA.
- Colour is **never the only signal**: every status also has an icon or a word (e.g. "LOW 4", not just an amber dot).
- Dark mode is a first-class option (shops with dim lighting), with a toggle and `prefers-color-scheme` as the default.

### 3.1b Owner-controlled theme (no fixed brand colour)
- **Accent colour:** the owner picks it in `Settings → Appearance` from a set of presets or a custom colour picker. It sets `--primary` (buttons, focus ring, selected states) for every till and screen at once. Stored in the `settings` table (`theme.accent`) and applied on load, even offline.
- **Safety net:** the app automatically checks contrast. If the chosen colour is too light or too dark for text, it adjusts the shade for each theme and warns, so buttons stay readable. Red, amber and green keep their fixed meanings and are **not** changeable.
- **Light / Dark / Follow system:** a per-user choice from the header (☀/☾ toggle), remembered on that device. The owner can also set the till default.
- **Logo:** upload later in `Settings → Shop details`. Until then the shop name is shown as text. The logo then appears in the header, login screen and bill.

### 3.2 Typography
- **Inter** (variable) for UI. It is free, highly legible, and has **tabular numerals** (`font-variant-numeric: tabular-nums`) for money and quantities.
- Scale (till): body 16 px, line items 18 px, section labels 13 px caps, **Total 44 px bold**, change due 32 px, tile name 15 px.
- Scale (back office): body 15 px, headings 20/24/32 px.
- Monospace (`JetBrains Mono`) only for barcodes and receipt numbers.

### 3.3 Spacing, shape, elevation
- 4 px base grid. Spacing steps 4/8/12/16/24/32.
- Radius: 8 px controls, 12 px cards and tiles. No heavy shadows; 1 px borders and a single soft shadow for dialogs.
- **Touch/click targets ≥ 44 px** on the till, even though the keyboard is primary.

### 3.4 Iconography
`lucide-react` line icons, 20 px, always paired with a text label on the till. Icon-only buttons only in dense back-office tables, and then with tooltips.

### 3.5 Motion
Minimal and fast (≤150 ms): fade/slide for dialogs, a brief highlight flash on a newly added bill line. Honour `prefers-reduced-motion`. No decorative animation at the till.

### 3.6 Sound (important for scanning)
Short tones generated with the Web Audio API (no files to download):
- **Scan OK:** a short high beep. **Not found / error:** a low double tone.
- **Supervisor required:** a soft chime.
- Volume and mute are in settings. Sound is never the only signal.

---

## 4. Layout System

| Breakpoint | Target | Layout |
|---|---|---|
| ≥ 1280 px | Till PC, owner's desktop | Two-pane POS (grid + bill). Full back-office sidebar. |
| 1024 px | Small laptop, tablet landscape | Same two panes, tighter grid. Sidebar collapses to icons. |
| 768 px | Tablet portrait | Bill slides over the grid. Single column back office. |
| < 768 px | Owner's phone | **Back office only** (dashboard, alerts, reports). The POS is not offered on phones. |

The **primary design target is 1366×768**, a common cheap-laptop size. If it fits there, it fits everywhere.

- **Till layout:** fixed header (store, cashier, shift, connection status, clock), a main area with product grid (left, ~60%) and bill (right, ~40%), and a persistent shortcut bar at the bottom.
- **Back-office layout:** left sidebar navigation, top bar with search (`Ctrl+K`), notification bell and user menu, then a content area with a max width of about 1280 px.

---

## 5. Component Library

Built on **Tailwind CSS + shadcn/ui** (accessible primitives from Radix), then restyled with the tokens above.

| Component | Notes |
|---|---|
| `ScanBar` | Always-focused input at the top of the till. Large, with a barcode icon and a hint. Flashes green/red on each scan. |
| `ProductTile` | Image, name, price (or "from LKR x" / "per size"), stock badge, favourite star. States: default, focused (thick ring), pressed, out-of-stock (dimmed). |
| `ProductGrid` | Category tabs + favourites. Arrow-key navigation with type-ahead jump. |
| `WeightPicker` | Dialog with product image, size buttons labelled with number keys, quantity stepper, live price. |
| `BillLine` | Name, size/weight, qty, unit price, line total. States: selected, just-added (flash), voided (struck through with the reason). |
| `TotalsPanel` | Subtotal, discount, tax included, **Total** in the largest type on screen. |
| `PaymentDialog` | Method keys (1 Cash, 2 Card, 3 QR, 4 Credit), tendered input, **change due** in large type, split payment rows. |
| `SupervisorDialog` | Two steps: scan badge → PIN. Shows who is approving and what for. Lockout state. |
| `ShortcutBar` | Bottom strip listing the active shortcuts as keycaps, such as `F2 Qty`. Clickable. |
| `Keycap` | Small key-shaped label used everywhere shortcuts appear. |
| `CommandPalette` | `Ctrl+K`. Search actions, pages and products. |
| `StatusPill` | Online / Offline (N sales waiting to sync) / Syncing. Always visible in the till header. |
| `Toast` | Non-blocking messages ("Product not found: 479…"). Never covers the bill. |
| `KpiCard`, `Sparkline`, `DataTable`, `Calendar`, `ChartCard` | Back office. Tables support keyboard navigation, sort and CSV export. |
| `EmptyState` | Friendly guidance with one clear action. |
| `ConfirmDialog` | For destructive actions. Owner-only ones require password re-entry. |

All components are documented in one **component sheet** page inside the app (`/design`, owner-only in dev) so the look stays consistent as the app grows.

---

## 6. Key Screens (wireframes)

### 6.1 Till: main checkout (`/pos`)
```
┌───────────────────────────────────────────────────────────────────────────────────────┐
│ ☰ SpiceShop   Cashier: Nimal   Shift #14 open 08:02      ● Online      10:41   ☀/☾   │
├────────────────────────────────────────────────┬──────────────────────────────────────┤
│ ▌▌▌ Scan barcode or type a code…          [F3 🔍] │  BILL #10231                Walk-in ▾ │
│ ★ Favourites │ Spices │ Biscuits │ Milk │ Other  │ ───────────────────────────────────  │
│                                                │  1 Curry Powder 250 g   ×1    450.00 │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │ ▶2 Marie Biscuit        ×2    240.00 │
│ │ [img]  │ │ [img]  │ │ [img]  │ │ [img]  │   │  3 Milk (glass)         ×1    250.00 │
│ │ Curry  │ │ Chilli │ │ Marie  │ │ Milk   │   │  4 Bottle not returned        100.00 │
│ │ powder │ │ powder │ │ 120    │ │ 250    │   │ ───────────────────────────────────  │
│ │ 5 sizes│ │ 5 sizes│ │        │ │        │   │  Subtotal                   1,040.00 │
│ └────────┘ └────────┘ └────────┘ └────────┘   │  VAT included                  0.00  │
│ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐   │                                      │
│ │  …     │ │        │ │        │ │        │   │  TOTAL        LKR 1,040.00           │
│ └────────┘ └────────┘ └────────┘ └────────┘   │  [ F12  PAY ]            [F9 Hold]   │
├────────────────────────────────────────────────┴──────────────────────────────────────┤
│ F2 Qty  F3 Find  F4 Calc  F5 Customer  F6 Discount  F7 Bottle  F8 Void  F9 Hold  F12 Pay │
└───────────────────────────────────────────────────────────────────────────────────────┘
```
- The **bill is always visible**, and the Total is the biggest element. Selected line has a clear marker (▶ plus a highlight).
- The scan bar keeps focus. Clicking a tile or closing a dialog returns focus to it.
- A voided line stays visible, struck through in muted red with "Voided: wrong item".
- The "Bottle not returned" fee line is locked (padlock icon). Only a supervisor can remove it.

### 6.2 Weight / pack-size picker
```
┌──────────────────────────────────────────────┐
│  [img]  Curry Powder                      ✕   │
│         Choose pack size                      │
│  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│  │ 1    │ │ 2    │ │ 3    │ │ 4    │ │ 5    │ │
│  │ 50 g │ │100 g │ │250 g │ │500 g │ │ 1 kg │ │
│  │  95  │ │ 180  │ │ 450  │ │ 880  │ │1,700 │ │
│  │ 24 in│ │ 12 in│ │ 3 LOW│ │ 30 in│ │ 8 in │ │   ← stock per size
│  └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ │
│  Packets   [ − ]  1  [ + ]                    │
│  LINE PRICE            250 g × 1 = LKR 450.00 │
│                          [ Esc Cancel ] [ Enter Add ] │
└──────────────────────────────────────────────┘
```
- Number keys pick a size, `+`/`-` change packets, `Enter` adds, `Esc` cancels. Out-of-stock sizes are dimmed with "0 in stock".
- If the owner enables custom weight, a sixth "Custom g" tile appears.

### 6.3 Supervisor approval dialog
```
┌──────────────────────────────────────┐
│ 🔒 Supervisor approval needed        │
│ Remove item: Marie Biscuit ×1        │
│                                      │
│ ① Scan supervisor badge   ✔ Kamal    │
│ ② Enter PIN               [ ● ● ● ● ]│
│                                      │
│ Reason  [Wrong item ▾]               │
│              [ Esc Cancel ] [Enter OK]│
└──────────────────────────────────────┘
```
- Step 1 listens for the badge scan anywhere in the dialog. On success the name appears and focus jumps to the PIN field. A wrong PIN shakes the field once and shows "2 tries left". Lockout shows a clear countdown message.
- Then, for a void, a prompt "Scan the item to remove" (or select the line) completes the Keels-style flow.

### 6.4 Payment dialog
```
┌──────────────────────────────────────────────────┐
│ PAY                                 TOTAL 1,040.00│
│ [1 Cash] [2 Card] [3 QR] [4 Credit]    [Tab Split]│
│                                                  │
│ Cash received   [  1,500.00 ]     F10 = exact    │
│                                                  │
│  CHANGE DUE         LKR 460.00     ← 32 px, green │
│                          [ Esc Back ]  [Enter Complete sale] │
└──────────────────────────────────────────────────┘
```
- Quick notes keys for common denominations (`5`=500, `1`=1000…) are shown as small chips.
- After completing, a **success screen** (1.5 s or a keypress) shows the change due and "Next customer", then focus returns to the empty bill. A receipt panel offers View / PDF / Print / Send.
- Credit payment requires a chosen customer, otherwise it opens the customer picker first.

### 6.5 Other till screens
Held bills list (`F9`), customer picker (`F5`), shift open/close with cash count (expected vs counted), cash-in/out form, and bill history with refund start. All dialogs share the same dialog style, with Enter to confirm and Esc to cancel.

### 6.6 Back office: dashboard
```
┌ Sidebar ┬──────────────────────────────────────────────────────────────┐
│ Dashboard│ Good morning, Owner                       🔔 3   Ctrl+K search │
│ Products │ ┌ Today ┐ ┌ Bills ┐ ┌ Avg basket┐ ┌ Gross profit┐ ┌ Low stock┐ │
│ Inventory│ │ 84,200│ │  63   │ │  1,336    │ │ 31,900      │ │   7  ⚠   │ │
│ Production│ └───────┘ └───────┘ └───────────┘ └─────────────┘ └──────────┘ │
│ Purchasing│ Sales, last 30 days (line + comparison to previous period)     │
│ Analytics │ ┌ Fast movers (top 10) ┐ ┌ Needs reordering ┐ ┌ Coming up ┐    │
│ Reports  │ │ bars                  │ │ product · days left│ │ Mon: Supplier A │
│ Staff    │ └──────────────────────┘ └──────────────────────┘ └────────────┘ │
│ Settings │ Voids today: 2 (Nimal 2)   Bottles outstanding: 14   Cash over/short │
└──────────┴──────────────────────────────────────────────────────────────┘
```
- KPIs first, then a trend, then **actions** (what needs reordering, what is coming up), because the owner uses it to decide.
- Each card links to its detailed page. Numbers always show a comparison (▲ 8% vs last week).

### 6.7 Back office: other key screens
| Screen | Design notes |
|---|---|
| **Products** | Table with thumbnails, search, filters; edit drawer with image upload (drag/drop or camera), pack sizes grid (size · price · barcode · stock), and tax category. "Assign barcodes" button prints the label sheet. |
| **Pack Stock** | One big form: spice → rows per pack size with `packets made` inputs → shows bulk kg used and pouches used live → Save. Designed for staff in the packing area. |
| **Production run wizard** | Stepper: Issue raw → Drying → Grinding → Packing → Costs → Review. Yield % and loss % shown live with colour (green normal, amber outlier). |
| **Reorder suggestions** | Table grouped by supplier, with suggested qty, days of cover, a checkbox to select, and a "Create PO" button. |
| **Purchasing calendar** | Month/week view. Scheduled POs appear as chips; drag to reschedule; click to open. Recurring ones carry a ↻ icon. |
| **Analytics** | Tabs: Fast movers, ABC, Dead stock, Forecast, Hours/days heatmap. Every chart has a table view toggle for accuracy. |
| **Month-end summary** | A printable page: headline numbers, tax block (VAT collected − paid = payable), expense table, and "Export PDF / CSV". |
| **Audit log** | Filterable table. Voids, waivers and refunds show the requester, approver and reason on one row. |

### 6.8 Login
Two entry points: **Owner/supervisor email login** and a **Till login** (staff code + PIN on a large number pad that also accepts the keyboard). Minimal, with the shop's logo.

---

## 7. Interaction Rules (apply everywhere)

1. **Focus is sacred.** After any dialog closes or any action completes on the till, focus returns to the scan bar. No dead ends where a click is required.
2. **Enter confirms, Esc cancels**, in every dialog. The default button is highlighted.
3. **Visible focus**: a 3 px primary ring on whatever is focused. Never removed.
4. **Shortcuts are discoverable**: the bottom bar shows the keys, tooltips show them on hover, `?` opens the full sheet, `Ctrl+K` finds anything.
5. **Destructive and risky actions** name what will happen ("Remove Marie Biscuit ×1 from this bill") and need the right authority (§3 of PLAN.md).
6. **Never block on the network.** Actions complete locally and sync in the background. The `StatusPill` shows the state, and a bill is never lost.
7. **Instant feedback** on every scan: line flash + tone + a toast if the code is unknown. An unknown barcode offers "Add new product" for a supervisor.
8. **Numbers are right-aligned, tabular, with thousands separators.** Currency is `LKR` or `Rs` consistently (one setting).
9. **No surprises on totals**: the total never changes without the bill line that caused it being visible.
10. **Undo where safe**: removing an unpaid line via supervisor is the only removal, but quantity changes and held bills can be reverted.

---

## 8. States to Design (not just the happy path)

| State | Treatment |
|---|---|
| **Offline** | Header pill turns amber: "Offline: 3 sales saved on this PC". Credit sales and supervisor voids are disabled with an explanation ("needs internet to verify"). |
| **Syncing / sync error** | Pill shows progress; errors list the failed bill with a Retry button. |
| **Empty bill** | Friendly prompt: "Scan an item or pick one below". |
| **Loading** | Skeleton rows (no spinners over the bill). |
| **Out of stock** | Tile dimmed with "Out"; adding shows a warning toast, and the owner's setting decides if selling is blocked. |
| **Low stock / expiring** | Amber badge on tile and in the back office; the date and quantity are shown. |
| **Unknown barcode** | Red flash + low tone + toast with the code. |
| **Locked supervisor** | Dialog explains the lockout and when it ends. |
| **Session timeout / till lock** | `Ctrl+L` lock screen requires a PIN, with the bill preserved. |
| **Printer missing** | Receipt options simply hide "Print" until a printer is enabled in settings. |
| **Errors** | Plain language and a next step, never raw error codes. |

---

## 9. Accessibility & Usability

- Full keyboard operation with logical tab order and no focus traps (`Esc` always exits).
- Contrast AA minimum, no colour-only signals, labels on every control.
- Respect `prefers-reduced-motion` and `prefers-color-scheme`.
- Text scales with the browser zoom to 200% without breaking the till layout.
- Screen-reader labels on tiles, bill lines and status changes (`aria-live` announces "Added: Marie Biscuit, 120").
- A **training mode** (Phase 10): a clearly bannered sandbox where new staff practise without creating real sales.

---

## 10. Content & Microcopy

- Plain English, short, action first: "Remove item", "Scan supervisor badge", "Enter PIN".
- Money: `LKR 1,234.00`. Weights: `250 g`, `1 kg`. Dates: `14 Oct 2026`. Time: 24-hour or 12-hour as a setting.
- Errors say what to do: "Barcode 4791234567890 isn't in the product list. Ask a supervisor to add it."
- Bills say "Bottle not returned (LKR 100)" so the customer understands the extra charge.

---

## 11. Design Process & Deliverables

Design happens **before** the build, in small steps that each get your approval.

| Step | Deliverable | Output |
|---|---|---|
| 1. Brand & tokens | Confirm logo, brand colours, the till screen size. Lock colour/type/spacing tokens. | Token file + one-page style sheet |
| 2. Till prototype | **Clickable HTML prototype of `/pos`**: grid, scan simulation, weight picker, bill, supervisor dialog, payment and change due. Real keyboard shortcuts. | Prototype you can try with a keyboard |
| 3. Till review | You and the cashier try it, then we adjust layout, key choices and wording. | Approved till design |
| 4. Back-office mockups | Dashboard, Products editor, Pack Stock, Purchasing calendar, Analytics, Month-end summary. | Static mockups |
| 5. Component sheet | All components in all states (§5, §8), light and dark. | `/design` page in the app |
| 6. Build | Implement with the shared components (Phase 0 onwards of PLAN.md). | Working app |

Recommended order: **1 → 2 → 3** first, because the till is the screen that matters most and the keyboard feel is hardest to judge from a picture. The prototype can run in a browser before any backend exists.

---

## 12. Open Design Questions

1. ~~Brand~~ **Resolved:** no fixed colour. The owner picks the accent in Settings (§3.1b). The logo will be uploaded later, and the shop name shows as text until then.
2. **Till screen:** what size and type is the till monitor (a 15" laptop at 1366×768, a 1920×1080 desktop, a touchscreen)? This sets tile sizes and touch targets.
3. ~~Light or dark~~ **Resolved:** both, chosen per user, with a till default set by the owner.
4. ~~Product photos~~ **Resolved:** the owner adds a photo when creating each product. Square photos on a plain background look best, and the app crops and resizes them.
5. **Receipts:** should the bill header show a logo and the shop's VAT number and contact details? (Needed anyway for VAT bills.)
