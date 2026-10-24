# Operating the Spice Shop POS

This is the manual for the people who actually run the till and the back office. It is not about
installing the software or editing code — see [README.md](README.md) for that.

Read the first two sections before your first shift. The rest is reference: find the task you need.

Money is shown in Sri Lankan rupees. Everything the system stores is in **cents**, so LKR 1,250.50 is
stored as `125050`. Anywhere a screen asks for an amount, type it in rupees with a decimal point
(`1250.50`), not in cents.

---

## Contents

1. [Who can do what](#1-who-can-do-what)
2. [Before the shop opens](#2-before-the-shop-opens)
3. [Selling: the till](#3-selling-the-till)
4. [The back office](#4-the-back-office)
5. [Recording production](#5-recording-production)
6. [What goes wrong, and what to do](#6-what-goes-wrong-and-what-to-do)
7. [The three emergency scenarios](#7-the-three-emergency-scenarios)
8. [Daily close-down checklist](#8-daily-close-down-checklist)
9. [Month-end](#9-month-end)
10. [Rules the system enforces that surprise people](#10-rules-the-system-enforces-that-surprise-people)

---

## 1. Who can do what

Three roles. The menu only shows what your role may use, and every action is checked again on the
server — so hiding a button is not the security, it is just tidiness.

| Task | Owner | Supervisor | Cashier |
|---|---|---|---|
| Sell at the till | yes | yes | yes |
| Approve a discount / remove a line | yes | yes | **no** — needs a supervisor badge + PIN |
| Receipts, customers | yes | yes | no |
| Products, barcodes, packet sizes, stock | yes | yes | no |
| Credit (lending, repayments) | yes | yes | no |
| Production, purchases, expenses | yes | yes | no |
| Finance, profitability, tax | yes | yes | no |
| **Audit trail** | yes | **no** | no |
| **Finance settings** (VAT rate, cost method, fiscal year) | yes | **no** | no |
| Staff and roles | yes | no | no |

Two consequences worth stating plainly:

- A **supervisor cannot see the audit trail**. That is deliberate: the trail shows what the owner
  changed, and that is not a supervisor's business.
- A **supervisor cannot change** the VAT rate, the cost method or the fiscal year start. Those change
  what every report says, so they are owner-only. If a supervisor tries, the server refuses even
  though the button was visible.

---

## 2. Before the shop opens

Do these in order. Each one takes under a minute when it is routine.

### 2.1 Check the sync badge

The header shows the till's connection to the server. Read it before you trust any number.

| What you see | What it means | What to do |
|---|---|---|
| Nothing / green | Synced in the last 30 seconds | Carry on |
| "Syncing" | A push is in progress | Wait; do not close the browser |
| **"No internet connection"** | The device itself is offline | Keep selling — this is expected and safe. See [7.1](#71-the-internet-goes-down-mid-shift) |
| **"Server not reachable"** | The device has internet but cannot reach Supabase | Keep selling. Check wifi/router. If it persists past 15 minutes, see [6.4](#64-server-not-reachable) |
| **"Till sign-in expired"** | Your session token is too old to push sales | **Act now.** Sign the till out and back in. Sales are still safe on the device but are not reaching the server |
| **"Sync problem"** | The server rejected a sale | **Hover the badge and read the message.** This is the only state that needs the exact text; see [6.5](#65-sync-problem) |

The till pushes every 30 seconds, and immediately when the network comes back. A short outage is
never an emergency.

### 2.2 Confirm the date and the staff list

Open the till and check the date shown in the header is today. A device with a wrong clock produces
receipts with wrong timestamps, and those cannot be corrected later — a sale's time is part of the
record.

Check that every staff member on shift appears in the staff list with the right role. Adding a
cashier takes a minute now and cannot be done quickly under a queue.

### 2.3 Check the float

Count the cash drawer and record it. The system does not track the physical drawer, so this is your
own discipline: the reports tell you what *should* be there, not what is.

---

## 3. Selling: the till

The till is keyboard-first. A barcode scanner acts as a keyboard, so scanning and typing are the
same thing.

### 3.1 A normal sale

1. Scan or type a barcode. The line appears with the price.
2. Repeat for each item.
3. `F12` to pay. Choose the method (cash, card, bank).
4. For cash, type the amount tendered; the change is shown. `F10` means exact cash.
5. Confirm. The receipt is printed and the sale is stored **on the device first**, then pushed to the
   server within 30 seconds.

The sale is real the moment you confirm it. The server push is a copy, not the original — this is
what makes offline selling safe.

### 3.2 Selling a weighed item

Products with `weighted` sale mode ask for a weight rather than a quantity. Put the goods on the
scale, type the weight in kilograms, confirm. Do not type grams: `0.25` is 250 g, `250` is 250 kg.

### 3.3 Selling a spice packet

Spice packets are sold as **packet sizes** of a product (250 g, 500 g, 1 kg), each with its own
barcode and price. Scan the packet's barcode; the size is chosen for you. If a customer asks for a
size you do not stock, do not substitute a different barcode — the stock records will disagree with
the shelf and the profitability report will be wrong from then on.

### 3.4 Quantities without scanning

Type `5*` then scan, to add five of the same item. `+` and `-` change the quantity of the selected
line (`F2` for a specific quantity). `↑` / `↓` move between bill lines. `Ctrl+1…9` switches product
category.

### 3.4a The full key list

`F2` quantity · `F3` find product · `F4` calculator · `F5` attach customer · `F6` bill discount ·
`F7` bottle return (`Shift+F7` undoes it) · `F8` remove line (supervisor) · `F9` hold / recall ·
`F10` exact cash · `F12` pay · `Ctrl+K` command palette · `Ctrl+L` lock · `?` show the sheet ·
`Esc` back to the scan bar.

Press `?` in the till for this list on screen — it is generated from the same registry the keys
themselves use, so it cannot drift out of date.

### 3.5 A discount, or removing a line

Both need a supervisor: **badge scan + PIN**, or the owner's PIN. This is not a nuisance check. A
cashier who could discount freely could sell to a friend at cost, and no report would show it as
anything other than a low-margin day.

### 3.6 Glass-bottle milk returns

`F7` records an empty bottle coming back. The non-return fee is reversed on that line. Record the
return at the moment it happens; the system cannot tell a returned bottle from one that never came
back, so a forgotten return is a small permanent loss.

### 3.7 Holding a sale

`F9` holds the current basket and starts a clean one; `F9` again recalls it. Useful when a customer
forgets their wallet. Held baskets are stored on the device (in the browser's database), so they
survive closing and reopening the browser — but they live on **that device only** and are never
synced, so a basket held on the counter till will not appear on the office machine.

### 3.8 Locking the till

`Ctrl+L` locks the screen while you step away. Always lock rather than closing the browser: closing
loses nothing, but reopening takes longer and looks like a fault to the next customer.

### 3.9 The command palette

`Ctrl+K` opens a search over everything the till can do. If you cannot remember a key, use this
instead of hunting.

---

## 4. The back office

The header carries the four screens used daily — **Overview, Customers, Products, Finance**. The
**hamburger menu** (☰) holds everything, grouped:

- **Shop** — Overview, Receipts, Customers, Credit
- **Stock** — Products, Production, Purchases
- **Money** — Finance, Expenses, Profitability, Tax
- **Admin** — Staff, Audit

A group disappears entirely if your role cannot use any of it, so the menu never shows a dead link.

### 4.1 Products

Each product has a name, a category, a sale mode (`unit` for counted goods, `weighted` for goods sold
by weight), a cost price and a selling price.

**Packet sizes** are added per product: a label (`250 g`), a weight in grams, a price, and optionally
the branded pouch used for it. Packets have their own stock count and their own barcodes.

**Barcodes** can be attached to a product or to one of its packet sizes. A barcode is unique per shop,
so the scanner can never be ambiguous. If a supplier changes a barcode, add the new one — do not
replace the old one, or last month's receipts stop making sense.

**Cost price** feeds every profit figure. If it is wrong, profitability is wrong, and nothing else will
tell you. Update it when a supplier bill changes the price; `Purchases` does this for you when the
goods are received.

`Products → Stock` is where stock is adjusted: a goods receipt, a wastage write-off, a physical
count correction. **Purchases does not move stock** — it records what the supplier charged. This
separation is intentional and is the single most common source of confusion. See [6.2](#62-stock-and-the-shelf-disagree).

### 4.2 Customers and credit

A customer record holds a name, phone and any credit limit. Selling on credit is a supervisor/owner
decision (`manageCredit`).

Recording a **repayment** reduces what is owed. Part-payments are normal. The customer list shows
what each person owes; a customer over their limit is a conversation, not a system block.

### 4.3 Receipts

Every sale appears here, newest first, with its status: **completed**, **voided** or **refunded**.

- **Download invoice** produces the invoice exactly as it was frozen at the moment of sale, including
  the VAT that applied then. If you change the VAT rate today, last month's invoices do not change.
  This is why invoices are frozen rather than recalculated.
- A sale that has not yet synced cannot produce an invoice; the button tells you
  *"Invoice for #N is not ready yet"*. Wait for the sync badge to go green and try again.
- **Cancelling** a sale requires a reason and is recorded in the audit trail. **Refunding** requires a
  reason too. Nothing is ever deleted.

### 4.4 Purchases (supplier bills)

This records **what a supplier charged you**, not what arrived on the shelf.

Fields: supplier, their invoice number, goods-received date, payment-due date, subtotal, input VAT,
and freight/duty.

Freight and duty are added to the **cost of the goods** rather than treated as an expense. That is
why there is a "what were the extra costs?" note when you enter any — write the real reason ("lorry
hire from Kandy"), because it is the only explanation anyone will have later.

Recording payment later (`Pay`) is separate from recording the bill. A bill can sit at *part paid*
for weeks; the status is derived from the payments, not typed in.

**If you get a supplier bill wrong**, do not delete it. Void it with a reason. See
[6.6](#66-i-entered-a-wrong-expense-or-supplier-bill).

### 4.5 Expenses

The day-to-day outgoings: rent, electricity, wages, transport, pouches.

- **Category** — pick the closest one; you can add categories.
- **Date of the expense** — when it was incurred, not when you typed it. A backdated expense is
  flagged in the audit screen's "worth a look" list, which is a prompt to write a note, not an accusation.
- **Paid now** — leave blank if it is on terms. The expense then shows as *unpaid*.
- **Payment method** — cash, bank transfer, cheque, card.
- **VAT included** — only if the bill shows tax separately.
- **This is a regular bill** — tick it and choose how often. A new expense is created on each cycle;
  this one stays as it is.

**Voiding** needs a reason and keeps the entry visible, struck through. An expense that can
disappear is not a record.

### 4.6 Finance

One month at a time, chosen with the month picker.

- **Money in / out / left** for the month.
- **Top expense categories** — where the money went.
- **Cost method** — the footer says `Costs at latest price` or `Costs at moving average`. This is an
  owner setting and it changes every profit figure. Read it before comparing two months; if it
  changed in between, the comparison is not like-for-like.
- **Finance settings** (owner only): VAT rate, cost method, fiscal year start month. Changing these
  is logged in the audit trail.

The figures are explicitly labelled as estimates where they are estimates. Treat the tax screen as a
record of what happened, not as a filing.

### 4.7 Profitability

Per-product revenue, cost, gross profit, margin and units sold, for the chosen month. Sort by any of
those from the top-right.

A supervisor sees this but with the advisory banner. Products with no cost recorded show a margin
that is too good to be true — fix the cost price in Products before believing the number.

### 4.8 Tax

VAT collected on sales, VAT paid on purchases, and the net, over a chosen range: this month, last
quarter, this year, or custom dates. The fiscal year start is an owner setting (default April).

Export gives you the underlying rows. Give the export to your accountant rather than the screen.

### 4.9 Audit (owner only)

Two halves:

- **Worth a look** — patterns, not findings: an unusually large expense, the same diesel bill twice, a
  cost changed with no reason written, negative stock, sales below cost. Every one is phrased as a
  question with the evidence attached. The system cannot tell a mistake from a decision, and it never
  blocks or reverses anything.
- **Recorded activity** — the append-only trail: who changed what, when, and why. Filter by action.
  Export the visible rows to CSV.

The trail cannot be edited or removed, **including by you**. That is the point.

---

## 5. Recording production

This is the screen that matters most for a spice business, and the one people get wrong. Read this
whole section once, properly.

A **production batch** takes raw material out of stock, uses labour and gas, produces packets, and
works out what one packet cost. It posts as **one transaction**: if any line is wrong, nothing moves.
A half-posted batch would leave the shelf and the cost records disagreeing, which is worse than
refusing the entry.

### 5.1 Before you start a batch

Three things must already exist, and it is much easier to check now than halfway through:

1. **The product being made** — a product in Products.
2. **Its packet sizes** — the sizes you are about to produce, each with a weight and a price. If the
   product has no packet sizes, the dialog will tell you
   *"This product has no packet sizes. Add one under Products before recording a batch."*
3. **The raw material as a product** — bulk turmeric is a product too, with a cost price. If the bulk
   material is not in Products, issuing it has nothing to draw from.

### 5.2 Filling in the form

**Top row — what you are making**

- **Product made** — the finished product. This is not the raw material.
- **Batch reference** — leave blank and one is generated. Use your own if you keep a paper batch book;
  matching the two later is much easier when the numbers agree.
- **Date** — when the batch was made. Backdating is allowed; it is not a way to hide anything, because
  the entry is logged with the time you actually typed it.

**Raw material used** — each line has three parts: **Material**, **Qty**, and a remove button.

- *Material* offers **whole products** (bulk goods, in their own unit — kilograms for a weighed
  product) and **specific packets** (an already-packed item being repacked).
- *Qty* is in the material's **own unit**. A weighed material: kilograms (`2.5` = 2.5 kg). A packet:
  the number of packets. This is the field people get wrong most often — typing `250` for 250 g issues
  250 kilograms and empties your stock.
- Material comes out of stock **at the cost it is already recorded at**.

**What the batch produced** — each line: **Packet size**, **Units**, and a remove button.

- *Packet size* lists only the packet sizes of the product you selected above, with the current count
  on hand in brackets.
- *Units* is how many packets you produced.
- Each output **adds stock** and receives the calculated cost per unit.

**Labour and other costs** — each line: **Cost type**, **What it was for**, **Amount (LKR)**.

- *Cost type*: Labour, Gas/electricity, Packaging, Transport, Other.
- *What it was for*: write something a stranger could understand — "Two workers, half a day",
  "Gas cylinder for the roaster". This text is the only explanation anyone will have later.
- *Amount*: rupees, e.g. `4500.00`, not cents.

**Notes** — anything else. Free text.

**The footer** shows the live **cost per unit** as you type: *"Cost per unit: LKR 42.50 for 500 units"*.
Watch it before you post. If it looks absurd, a quantity is wrong. Nothing is committed until you
press **Post batch**.

### 5.3 A worked example

Repacking 25 kg of bulk turmeric into 250 g packets.

- Product made: `Turmeric powder`
- Raw material used: `Turmeric — bulk` · Qty `25` (kilograms)
- What the batch produced: `250 g` · Units `95` (95 × 250 g = 23.75 kg; about 5% loss is normal
  and is absorbed into the cost per unit)
- Labour and other costs: `Labour` · "Two workers, half a day" · `3500.00`;
  `Packaging` · "Branded 250 g pouches" · `1200.00`
- Notes: "Batch 42, Tur 25/09"

Post it once. The bulk stock drops by 25 kg, 95 packets are added, and the cost per packet reflects
material plus labour plus pouches.

**If you notice a mistake after posting**, do not post a correcting batch without thinking. There is
no edit and no delete — a posted run is the record. Options, in order of preference:

1. If the error is only in the **notes**, leave it; the notes are cosmetic.
2. If a **quantity** is wrong, post a correcting batch in the opposite direction (a negative
   adjustment is not possible through this screen, so record the difference as a stock adjustment in
   Products → Stock) and write a note explaining it.
3. If the **cost per unit** is now wrong for stock already sold, tell the owner before changing
   anything. The owner can adjust the product's cost price; doing it without understanding why will
   make this month's profitability wrong in a different way.

---

## 6. What goes wrong, and what to do

Each heading is something that actually happens. The messages are quoted exactly as the system
shows them, so you can match what is on screen.

### 6.1 "Could not find the function public.finance_summary(p_from, p_to) in the schema cache"

**This is not something you did, and no data is lost.** The screen is asking the database for a
report that has not been installed on it.

It happens when the finance part of the database was never set up on the server the app is connected
to. It is not fixable from the till or the back office.

**What to do:** tell whoever administers the system, and quote the message. They need to run the four
finance migration files on the database, in order. Until then, Finance, Expenses, Profitability, Tax,
Purchases and Production will all show a similar message.

**What still works:** selling, receipts, customers, products, credit. The till does not depend on the
missing part.

**Do not** create a second shop, re-run setup, or delete anything to "fix" this. The message is
identical every time and has nothing to do with your entries.

### 6.2 Stock and the shelf disagree

The usual causes, in order of likelihood:

1. **A purchase was recorded and the goods arrived, but stock was never received.** Purchases records
   the bill only. Use Products → Stock to receive the goods.
2. **A production batch issued a quantity in the wrong unit** (`250` instead of `0.25`). Check
   Production for a batch with an implausible material quantity.
3. **Sales were made while a device was offline and that device was never synced.** Check the sync
   badge on every till.
4. **Goods were sold without a barcode scan** (a manual price entry). Those sales do not reduce stock
   for the scanned item.
5. **Wastage was not written off.** Spilled, damp or expired stock still counts until it is adjusted.

**What to do:** count the shelf, then adjust in Products → Stock with a note. Do not adjust to hide
the discrepancy without finding the cause — the same error will happen again next month.

### 6.3 A sale is on the device but not on the server

The receipt exists and printed, but Receipts does not show it, or its invoice is "not ready yet".

The sale is **safe**. It is in the till's local database and will be pushed when the connection is
good. Do not re-enter it: two copies of the same sale is worse than a late one.

**What to do:** check the sync badge. If it says *"Till sign-in expired"*, sign the till out and back
in — that is the one cause that will never resolve on its own. If it says *"Server not reachable"*,
check the network. Otherwise wait a full minute and check again.

### 6.4 "Server not reachable"

The device has internet but the database is not answering. Often the router, sometimes the provider.

**Keep selling.** The till is designed for this.

Escalate if it lasts more than about 15 minutes, or if other websites also fail (that is your
connection, not the POS).

### 6.5 "Sync problem"

Hover the badge: the tooltip carries the server's actual message. That text is the diagnosis; without
it nobody can help you.

Common ones and what they mean:

| Message | Meaning | Action |
|---|---|---|
| `not_authenticated` | The session is no longer valid | Sign the till out and in again |
| `sale not found` | A push referred to a sale that is not on the server | Usually harmless; note the time and tell the administrator if it repeats |
| `financial records are for the owner and supervisors` | The signed-in user's role changed, or is wrong | Check the role in Staff |
| `only the shop owner can do this` | An owner-only action was attempted by someone else | Expected; ask the owner |

### 6.6 I entered a wrong expense or supplier bill

**Do not delete it.** There is no delete, by design.

- **Wrong amount, wrong category, wrong date** — void it with a clear reason ("entered twice",
  "wrong supplier"), then enter a correct one. The audit trail shows both, and the month's expenses
  are right.
- **Paid to the wrong person** — void and re-enter. The payment itself is a separate record; note in
  the void reason that a payment was also made, so the owner can reconcile the bank.
- **Duplicate** — void the second one with the reason "duplicate of voucher NNN".

### 6.7 "cannot pay more than the amount" / "that is more than the % still owed"

You are recording a payment larger than what is outstanding. The system will not let you overpay.

Check whether an earlier payment was already recorded. If a payment was entered twice, void the
duplicate payment rather than adding a negative one.

### 6.8 "a reason is required to void an expense" (or a purchase, or a sale)

Voiding always needs a reason. It is not optional and not a formality: it is the only thing that
explains the void to whoever reads the trail in six months. Write what happened, not "error".

### 6.9 "a supplier bill cannot be settled on credit" / "an expense cannot be settled on credit"

These record money going **out**. They are either paid or unpaid; there is no "credit" concept for
them. For a bill you will pay later, leave **Paid now** blank and record the payment when it happens.
Credit in this system means money a **customer** owes you.

### 6.10 "not available for your role"

You opened a screen your role cannot use. It is not a fault. The menu hides these, so this usually
means a bookmark or a link shared by someone else.

### 6.11 "NotAllowed" / the audit screen says a supervisor cannot see it

Correct and deliberate. The audit trail is the owner's alone.

### 6.12 The date or time on a receipt is wrong

The device clock is wrong. Sales already recorded keep the wrong time permanently. Fix the device
clock now, and tell the owner so the affected receipts are known to be mis-timed.

### 6.13 "a run must produce something" / "a run needs at least one output"

A production batch with no output. Enter at least one packet size and a quantity above zero. A batch
that produced nothing is usually a cancelled batch — do not record it at all.

### 6.14 "input quantities must be positive"

One of the raw-material quantities is zero or negative. Remove the empty line instead of leaving it
at zero.

### 6.15 The invoice will not download

*"Invoice for #N is not ready yet — it is written once the till syncs this sale."*

The sale exists on the device but the server has not received it, so it has not frozen the invoice
yet. Wait for a green sync badge and retry. If it has been like this for hours, see [6.3](#63-a-sale-is-on-the-device-but-not-on-the-server).

### 6.16 Two people edited the same thing

Last save wins for descriptive fields (a customer's phone number). Financial records are different:
they are never edited in place, only voided and re-entered, so two people cannot silently overwrite
each other's money.

---

## 7. The three emergency scenarios

### 7.1 The internet goes down mid-shift

**The till keeps working. This is what it was built for.**

1. Keep selling exactly as normal. Every sale is written to the device first.
2. Tell the cashiers that receipts will print but sync will lag.
3. Do not restart the computer, and do not clear the browser data. The unsynced sales live there.
4. When the connection returns, the till syncs within 30 seconds of the network coming back. Watch the
   badge until it is green.
5. **Before closing**, confirm the badge is green. If it cannot be restored, see [7.3](#73-the-device-is-dying-with-unsynced-sales).

The one thing that breaks this is a browser with the local data cleared, or a private/incognito
window. Never run the till in a private window.

### 7.2 The power goes out

Same as above, with the added risk that the device may die before the sales are synced.

1. If you have a UPS, the till keeps running; keep selling.
2. If the machine will die, **stop selling on it** the moment you know power is not coming back
   quickly, and switch to a paper receipt book.
3. When power returns, start the till and check the sync badge. Anything entered before the outage is
   still there.
4. Reconcile the paper sales into the system afterwards. Record them with the real time where you can;
   where you cannot, use the earliest plausible time and note it.

**Batteries matter more than backups here.** A laptop with a charged battery is a functioning till. A
desktop without a UPS is not.

### 7.3 The device is dying with unsynced sales

The worst case. The sales exist only in that browser's local database.

1. **Do not close the browser, do not shut down, do not clear anything.** Get power to the device
   first.
2. If the device is truly failing, get the network working — even a phone hotspot — so the till can
   push. It retries every 30 seconds.
3. Note the time of the last green sync badge you saw, and the receipts printed after it. That paper
   is your only record of the gap.
4. If the device is lost or will not start: those sales are gone, and only the receipts exist. Tell
   the owner immediately. They can be re-entered later as historical sales, but the stock effect will
   not be exact.
5. Never "fix" this by clearing the browser to make the app start faster. That deletes the sales.

### 7.4 Found: what to do if the wrong shop is selected

If the account belongs to more than one shop, a **shop selector** appears in the header. Every screen
follows the selected shop. Checking in the wrong shop produces entries that are not wrong, just in the
wrong place — and moving them is manual work.

**Rule:** look at the shop name in the header before entering anything financial.

---

## 8. Daily close-down checklist

Ten minutes, in this order.

1. **Sync badge green.** If not, do not close the browser until it is, or follow [7.3](#73-the-device-is-dying-with-unsynced-sales).
2. **Count the cash drawer.** Compare with the day's takings on Overview. A difference is a
   conversation, not a correction — never adjust the system to match the drawer.
3. **Receipts:** scan for anything `voided` or `refunded` and check each has a reason you would be
   happy to read aloud.
4. **Expenses:** enter today's outgoings now. A week of unrecorded expenses is how a month-end turns
   into an afternoon.
5. **Stock:** write off anything spoiled today. It is easier now than at the count.
6. **Production:** if you ran a batch today, post it today while you still remember the quantities.
7. **Notes:** anything unusual — a large cash refund, a customer dispute, a barcode scanner failure —
   write it in the audit notes or on the receipt. Future-you will not remember.

---

## 9. Month-end

1. **Fix cost prices before running anything.** Profitability, finance and tax all read the cost
   record. Wrong costs make every report wrong, and none of them will warn you.
2. **Reconcile purchases** — every supplier bill received this month is entered, and the ones paid
   are marked paid.
3. **Reconcile credit** — customers who owe, and whether the amounts match what they remember.
4. **Run Finance, Profitability and Tax for the month.** Read the cost-method note in the Finance
   footer before comparing to last month.
5. **Export** each report you need. The export is the rows behind the screen; give the accountant the
   export, not a screenshot.
6. **Read the audit screen's "worth a look" list** for the month. Every item is a question. Answer
   them in the notes — a pattern with no explanation is exactly what an auditor will ask about.
7. **Do not change the VAT rate, cost method or fiscal year start mid-month** unless you intend to,
   and note why. Every comparison across that boundary becomes approximate.

---

## 10. Rules the system enforces that surprise people

These are all deliberate. Knowing them avoids most "the system is broken" moments.

- **Nothing financial can be deleted.** Void with a reason. The entry stays visible, struck through.
- **The audit trail cannot be edited, including by the owner.** Reading it is owner-only.
- **Purchases does not move stock.** Receiving goods is a separate action in Products → Stock.
- **A bill recorded as part-paid cannot be overpaid.** The status is derived from payments, never
  typed.
- **Invoices are frozen at the time of sale.** Changing the VAT rate today does not change last
  month's invoices.
- **A production batch posts all at once or not at all.** A half-posted batch would break the stock
  and cost records, so it is refused instead.
- **Quantities in production are in the material's own unit.** Kilograms for a weighed product,
  packets for a packet. `250` is not 250 g.
- **Freight and duty are cost of goods, not expenses.** That is why they are on the purchase form and
  not in the expense book.
- **Credit means a customer owes you.** There is no credit concept for money you owe a supplier; a
  bill is simply unpaid until paid.
- **The "worth a look" alerts never block anything.** They are questions with evidence, not findings.
  A large bill in a busy week looks the same as a mistake.
- **Cost method changes every profit figure.** Read it before comparing periods.
- **Discounts and line removals need a supervisor.** Always. No exceptions for staff you trust.

---

## Getting help

When reporting a problem, include:

1. **The exact message**, copied if possible. "Sync problem" tells nobody anything; the tooltip text
   underneath it is the diagnosis.
2. **Which screen**, and which shop (top-left of the header).
3. **What you did just before** it appeared.
4. **The time**, and whether the sync badge was green at the time.

Do not fix a financial discrepancy by deleting or editing records. Void with a reason, and tell the
owner what happened.
