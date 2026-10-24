# Spice Shop POS

Barcode point-of-sale for a spice manufacturer and grocery: keyboard-first checkout, branded spice
packets sold by size, glass-bottle milk with a non-return fee, supervisor approval by badge + PIN,
offline selling, and a Supabase backend.

- **[PLAN.md](PLAN.md)** — what the system does and the build phases
- **[DESIGN.md](DESIGN.md)** — look, layout and interaction rules
- **[OPERATIONS.md](OPERATIONS.md)** — the manual for shop staff: shifts, emergencies, month-end
- **[LICENSE](LICENSE)** — AGPL-3.0-or-later: free to use and modify, modifications shared back

## Licence

Copyright (C) 2026 Sinura Wahalathanthri.

This program is free software under the **GNU Affero General Public License v3.0 or later**
(`AGPL-3.0-or-later`). You may run it, study it, modify it and redistribute it, provided modified
versions stay under the same licence. Because a POS is used over a network, the AGPL's §13 applies:
if you run a modified version as a hosted service, you must offer users of that service the
corresponding source.

Shops running the released installers or the hosted app, and staff working in them, are unaffected —
the licence governs distribution of the software, not its use.

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

## Desktop app (Electron)
The same codebase also ships as an installed desktop till. The website on Vercel is unchanged: the
desktop build is a *separate, opt-in* build of the same app, not a fork.
```bash
npm run desktop          # build the export, then open it in Electron
npm run desktop:dev      # load http://localhost:3000 instead (run `npm run dev` first)
npm run smoke:desktop    # boot the built app and check it really rendered
npm run dist:win         # Windows installer   -> release/
npm run dist:mac         # macOS .dmg
npm run dist:linux       # Linux AppImage
```
### Shipping an installer that is already connected
By default an installer starts on **Connect your database** (`/setup`): paste the project URL and the
anon key once, and it is remembered on that machine. To hand a shopkeeper an installer that is
connected from the first launch, supply the project when building:
```bash
POS_SUPABASE_URL=https://yourref.supabase.co \
POS_SUPABASE_ANON_KEY=eyJhbGci... \
npm run dist:win
```
`npm run desktop:config` (run automatically by `dist*`) turns those into
`supabase.config.json`, which electron-builder ships as a resource. `desktop/preload.js` hands it to
the page over a read-only bridge, and `lib/supabase/config.ts` treats it as the default. No
`NEXT_PUBLIC_*` is used deliberately: those get inlined by the bundler and would bake one shop's
project into the public website build. Omit both variables and you get a generic installer.

The two values can come from the shell, `.env.local`, or `.env` (see `.env.example`); the shell
wins. In CI, set the repository secrets `POS_SUPABASE_URL` and `POS_SUPABASE_ANON_KEY` and the
`Desktop installers` workflow picks them up.

Precedence, highest first: a project saved on this machine → the one shipped in the installer →
`NEXT_PUBLIC_*` build defaults. Pressing **Disconnect** on `/setup` sticks, so a preconfigured
installer does not silently reconnect itself. Inside the app, **Shop → Database connection…**
(`Ctrl+,`) reaches `/setup` at any time; there is no address bar.

### How the two targets coexist
| | Website (Vercel) | Desktop |
|---|---|---|
| Build | `npm run build` | `BUILD_TARGET=desktop npm run build` |
| Next config | server build, `cacheComponents` | `output: "export"`, `trailingSlash` |
| Serves | Vercel | Electron, from files inside the app over `app://till/` |
| Updates | on deploy | a new installer |
`next.config.ts` branches on `BUILD_TARGET`. Vercel never sets it, so a push deploys exactly what it
deployed before. The desktop build is only produced by `npm run dist*` and by the
`Desktop installers` workflow, which runs on tags (`v*`) and never on ordinary pushes.
Both talk to the *same* Supabase project and use the same login. A shop can run the website on a
laptop and an installed till on the counter at the same time; sales from both land in the same
tables, and `complete_sale()` ignores duplicates.
### Why the desktop build is a static export
A counter-side till must keep selling when the internet is down, and it cannot assume a Node server
is running on the shop's computer. The export is served by Electron itself, so there is no server to
start, and the existing offline machinery (IndexedDB + the sale queue in `lib/sync/`) works
unchanged. Credentials are entered at `/setup` and stored on the device, so one installer works for
any shop and can be re-pointed at a different project later. An installer built with `POS_SUPABASE_*`
starts connected instead; see above.
### Things worth knowing
- **`app://till/` is a real origin.** `desktop/protocol.js` serves the export; `desktop/main.js`
  registers the scheme as standard + secure *before* `app.ready`. Without that registration the
  origin becomes `null`, web fonts are blocked by CORS and `fetch()` fails ΓÇö which only shows up in a
  packaged build, so `--smoke` exists to catch exactly that.
- **The host is fixed (`till`) on purpose.** With a standard scheme the first path segment is the
  host, so `app://pos/` would parse as host `pos` with path `/` and every route would render the
  home page.
- **The installer is not code-signed.** Windows SmartScreen ("More info" ΓåÆ "Run anyway") and macOS
  Gatekeeper (right-click ΓåÆ Open) ask once. Set `CSC_LINK` / `CSC_KEY_PASSWORD` to sign.
- **The local database survives upgrades.** It lives in the OS user-data folder, not in the app
  directory, and NSIS is configured not to delete it on uninstall.
### Publishing a download
1. Bump `version` in `package.json`.
2. `git tag v0.1.1 && git push origin v0.1.1`.
The workflow builds all three platforms, verifies the app boots, and attaches the installers to the
GitHub Release for that tag. Without a tag, `workflow_dispatch` still uploads them as build
artifacts.
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

1. Create a project at supabase.com. Run every file in `supabase/migrations` in order in the SQL editor
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
