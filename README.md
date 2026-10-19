# Spice Shop POS

Barcode point-of-sale for a spice manufacturer and grocery: keyboard-first checkout, branded spice
packets sold by size, glass-bottle milk with a non-return fee, supervisor approval by badge + PIN,
offline selling, and a Supabase backend.

- **[PLAN.md](PLAN.md)** — what the system does and the build phases
- **[DESIGN.md](DESIGN.md)** — look, layout and interaction rules

## Run it

```bash
npm install
npm run dev -- --port 3100
```

Open http://localhost:3100 and sign in with a demo account (development only):

| Who | Staff code | PIN | Badge (scan or type) |
|---|---|---|---|
| Owner | `1` | `9999` | none (approves with PIN only) |
| Supervisor Kamal | `2` | `2222` | `SUP-0002` |
| Cashier Nimal | `3` | `3333` | none |

The till stores everything in the browser (IndexedDB), so it works with no backend yet.
Demo barcodes: `4790000000044` Marie Biscuit · `4790000000075` glass-bottle milk · `4790000000013` Curry Powder 250 g.

## Keyboard (full list: press `?` in the till)

`F2` qty · `F3` find · `F4` calculator · `F6` discount · `F7` empty bottle returned · `F8` remove line
(supervisor) · `F9` hold / recall · `F10` exact cash · `F12` pay · `Ctrl+K` command palette ·
`Ctrl+L` lock · `5*` then scan = quantity 5 · `↑/↓` select line · `+/−` quantity · `Esc` back to the scan bar.

## Checks

```bash
npm run lint        # eslint
npx tsc --noEmit    # types
npm test            # logic, sync and database tests (real migrations on an in-process Postgres)
npm run build
```

## Backend (Supabase)

`supabase/migrations/` holds the schema, row-level security and server functions (`0001`-`0011`);
`supabase/seed.sql` loads a demo shop, which is only used by the local stand-in and the tests.
The database tests apply the real migrations to PGlite (Postgres in WebAssembly), so no Docker is needed.

### Try connected mode with no account

```bash
npm run dev:mock
```

Starts a local stand-in for Supabase (it runs the real migrations and seed in memory) and the app pointed at it.
Sign the till in with `till@shop.test` / `till-password`, then staff as in the table above. Use it to watch
sales upload, to cut the connection (`POST http://127.0.0.1:54321/__mock/offline?on=1`), and so on.
Data resets each run. It is a development tool, not a real server.

### Connect to a real Supabase project

1. Create a project at supabase.com. Run `supabase/migrations/0001` to `0011` in order in the SQL editor
   (or `npx supabase link` then `npx supabase db push`).
2. `npm run dev`, then open `/setup` and paste the project URL and the **anon** key (never the service_role
   key - the form rejects it). Credentials are stored on the device, so pointing a till at a project needs
   no rebuild. `.env.example` is only for pre-configuring a fixed single-shop build.
3. Create the owner's account in Authentication -> Users -> Add user, with auto-confirm on. This is the
   person who will set the shop up.
4. Open the app and sign in. First run goes to `/onboarding`: name the shop and it is created **empty**.
   There is no sample catalogue, and `seed.sql` is never run on a live shop.
5. The dashboard is where staff, products and analytics live. PINs are hashed server side and can only be
   reset there, never read back. Supervisors add products but not staff; cashiers only use the till.
6. To run a second till, add another user in Authentication and give them a staff row from the dashboard.

`supabase/setup-shop.example.sql` is no longer needed for a new shop (onboarding does the same work from
the app). It stays as a reference for scripting a shop by hand.

### How the till and Supabase work together

- The till always sells against local data, so a dropped connection never stops a sale.
- Each sale uploads to `complete_sale()`. The server checks it and ignores a repeat, so a retry cannot double-count.
- The catalogue and stock come down from the server (minus sales not yet uploaded).
- Staff PINs and supervisor badges are checked **by the server**, which counts wrong tries and locks people out.
  Offline, the till falls back to a copy it made the last time that person authenticated online on that till.
  Someone who has never signed in on this till cannot be approved offline.
- The header tells the cashier what is happening: Online, Offline · n to upload, Sign in again, or n sales refused.

## Status

| Done | Next |
|---|---|
| Till: scan, picture grid, spice pack-size picker, bill, bottle fee, supervisor void (badge + PIN, lockout), hold/recall, discount, calculator, cash/card/QR, lock screen, light/dark + owner accent colour | Back office: products + images, inventory, purchasing, analytics, tax and month-end |
| **Connected to Supabase**: till + staff sign-in, server-checked PIN and badge, catalogue and stock download, sale upload with offline queue, sync status | Shift open/close, refunds, credit accounts, receipts (PDF / printer) |
| Database: schema, RLS, stock ledger + low-stock alerts, `complete_sale`, approvals, archive, stock adjustment | Verify against a real Supabase project (only tested so far against the local stand-in) |
| **Owner setup**: onboarding creates an empty shop, staff management, product management, per-product analytics, customers by mobile, bottle loans tracked per customer | Shifts, refunds, purchasing screens |
