# Spice Shop POS

Barcode point-of-sale for a spice manufacturer and grocery: keyboard-first checkout, branded spice
packets sold by size, glass-bottle milk with a non-return fee, supervisor approval by badge + PIN,
offline selling, and a Supabase backend.

- **[PLAN.md](PLAN.md)** — what the system does and the build phases
- **[DESIGN.md](DESIGN.md)** — look, layout and interaction rules
- **[OPERATIONS.md](OPERATIONS.md)** — the manual for shop staff: shifts, emergencies, month-end
- **[ROADMAP.md](ROADMAP.md)** — what comes next: vendor self-registration and the features for any kind of business
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
3. Create the first **platform administrator** by running `supabase/setup-platform-admin.sql` in the SQL
   editor with the placeholders filled in. Run it once, then discard the edited text: it holds a
   plain-text password. After migration `0025` this is the only account that has to be made by hand, and
   it exists because the admin panel itself provisions everyone else. Never add a self-service "become
   admin" route - it would be a permanent privilege-escalation hole.
4. Sign in as that administrator. You land on `/platform`, which lists every shop (read-only) and can
   create an owner account with a generated password. Give the owner that email and password.
5. The owner signs in and is sent to `/account?first=1` to replace the handed-over password, then to
   `/onboarding` to name the shop. The shop is created **empty**: there is no sample catalogue, and
   `seed.sql` is never run on a live shop.
6. The dashboard is where staff, products and analytics live. PINs are hashed server side and can only be
   reset there, never read back. Supervisors add products but not staff; cashiers only use the till.
   The owner can correct their own shop details (name, address, VAT number, bottle deposit, discount
   cap, tax-inclusive pricing) from the pencil beside the shop name.
7. To run a second till, add another user in Authentication and give them a staff row from the dashboard.

#### Letting businesses register themselves (migration `0029`)

Besides the admin creating owners (step 4), a business can sign itself up from the website: the public
landing page at `/` links to `/register`, the owner confirms their email, fills in the business details
on `/onboarding`, and a platform administrator approves it on the **Applications** tab of `/platform`.
Once approved, the owner opens their shop from `/onboarding`. A new shop cannot be opened without an
approved application. To switch it on in Supabase:

1. Run `supabase/migrations/0029_vendor_registration.sql`.
2. **Authentication → Providers → Email:** enable sign-ups and keep **Confirm email** on. Applications
   are refused until the email is confirmed.
3. **Authentication → URL Configuration:** set the Site URL to the website, and add
   `https://<your-site>/onboarding` to the redirect URLs (the confirmation link lands there).
4. Optional: **Authentication → Attack Protection** → enable CAPTCHA with Cloudflare Turnstile, and
   put the matching site key in `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (see `.env.example`).
5. Replace the **draft** text on `/terms` and `/privacy` with reviewed terms before opening to the
   public, and bump `platform_settings.terms_version` when they change so applicants accept the new
   version.

**Approve new applications automatically** on the Applications tab skips the review (off by default).
The mock (`npm run dev:mock`) supports the whole flow: sign in as `admin@platform.test` /
`admin-password`, and confirm a registered email with
`curl -X POST "http://127.0.0.1:54321/__mock/confirm?email=..."`.

#### What the platform administrator can and cannot do

The screen at `/platform` is deliberately narrow. It can create an owner account and their empty shop,
reset an owner's password (which forces a change on next sign-in), and suspend or restore a shop with a
recorded reason. It **cannot** read or change sales, products, stock or staff beyond a read-only history
per shop - no such RPC exists, and `platform_*` functions check `is_platform_admin()` on the server, so
reaching the URL as a shop owner returns an error rather than data. Suspending closes the shop to its own
staff (every policy resolves the store through `app_store_id()`, which returns null while suspended) but
keeps it visible to the administrator, and deletes nothing.

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
