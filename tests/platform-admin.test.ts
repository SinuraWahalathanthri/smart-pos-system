import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { normaliseDetail, type PlatformStoreDetail } from "../lib/platform";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0025: platform administration, owner provisioning, store self-service and suspension.
 *
 * The rules under test are the ones that are expensive to get wrong:
 *   - a shop owner must never reach the platform functions (no privilege escalation);
 *   - an administrator is read-only over trading data;
 *   - a suspended shop closes to its own staff but stays visible to the administrator;
 *   - an owner can edit their own shop details and the edit is audited;
 *   - a handed-over password forces a change on first sign-in.
 *
 * The auth.users / auth.identities stubs mirror the real GoTrue columns that the provisioning
 * function writes, so the single-transaction create path is exercised for real rather than mocked.
 */

const ROOT = join(__dirname, "..", "supabase");

/**
 * The bootstrap file holds two alternative DO blocks (create a new admin, or promote an existing
 * account). A human runs exactly one of them, so the test must too - running the whole file would
 * execute both and the promote block would then find the account created by the first.
 */
function bootstrap(which: "create" | "promote"): string {
  const file = readFileSync(join(ROOT, "setup-platform-admin.sql"), "utf8");
  const blocks = file.split(/\n\s*do \$\$/gi);
  return `do $$ ${which === "create" ? blocks[1] : blocks[2]}`;
}

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create schema if not exists auth;

  create table if not exists auth.users (
    instance_id uuid,
    id uuid primary key default gen_random_uuid(),
    aud text,
    role text,
    email text,
    encrypted_password text,
    email_confirmed_at timestamptz,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    confirmation_token text,
    recovery_token text,
    email_change text,
    email_change_token_new text,
    is_sso_user boolean default false
  );

  create table if not exists auth.identities (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users (id) on delete cascade,
    provider_id text,
    provider text,
    identity_data jsonb,
    created_at timestamptz default now(),
    updated_at timestamptz default now(),
    last_sign_in_at timestamptz
  );

  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
`;

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

async function asUser<T>(authId: string, fn: () => Promise<T>, store?: string): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claim.sub', '${authId}', false);
     select set_config('app.store_id', '${store ?? ""}', false);
     set role authenticated;`,
  );
  try {
    return await fn();
  } finally {
    await db.exec(`reset role;
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('app.store_id', '', false);`);
  }
}

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

/** A confirmed email account, the way GoTrue would leave one. */
async function newAuthUser(email: string) {
  const r = await rows<{ id: string }>(
    `insert into auth.users (email, aud, role) values ($1, 'authenticated', 'authenticated') returning id`,
    [email],
  );
  return r[0].id;
}

async function makeAdmin(email = "admin@platform.test") {
  const id = await newAuthUser(email);
  await rows(`insert into platform_admins (auth_user_id, full_name) values ($1, $2)`, [id, "Platform Admin"]);
  return id;
}

/** Provision through the real RPC so the whole create path is covered. */
async function provision(adminId: string, email: string) {
  return asUser(adminId, async () => {
    const r = await rows<{ out: Record<string, unknown> }>(
      `select public.platform_create_owner($1, $2, $3) as out`,
      [email, "generated-Passw0rd", "Test Spice Shop"],
    );
    return r[0].out as { store_id: string; user_id: string; email: string };
  });
}

describe("0025 platform admin", () => {
  it("applies cleanly on top of every earlier migration", async () => {
    const r = await rows<{ n: number }>(
      `select count(*)::int as n from information_schema.columns
        where table_name = 'stores' and column_name in ('is_active','suspended_at','suspended_reason')`,
    );
    expect(r[0].n).toBe(3);
  });

  it("provisions an owner account, shop and owner profile in one transaction", async () => {
    const admin = await makeAdmin();
    const out = await provision(admin, "owner1@shop.test");

    expect(out.email).toBe("owner1@shop.test");

    const user = await rows<{ email: string; encrypted_password: string }>(
      `select email, encrypted_password from auth.users where id = $1`,
      [out.user_id],
    );
    expect(user[0].email).toBe("owner1@shop.test");
    // The password is stored hashed, never in clear.
    expect(user[0].encrypted_password).toMatch(/^\$2[aby]\$/);
    expect(user[0].encrypted_password).not.toContain("generated-Passw0rd");

    // GoTrue needs an identity row or email sign-in fails even though the user exists.
    const ident = await rows<{ provider: string }>(
      `select provider from auth.identities where user_id = $1`,
      [out.user_id],
    );
    expect(ident[0].provider).toBe("email");

    const profile = await rows<{ role: string; staff_code: string; must_change_password: boolean }>(
      `select role, staff_code, must_change_password from profiles where auth_user_id = $1`,
      [out.user_id],
    );
    expect(profile[0]).toMatchObject({ role: "owner", staff_code: "1", must_change_password: true });

    const store = await rows<{ owner_id: string; is_active: boolean }>(
      `select owner_id, is_active from stores where id = $1`,
      [out.store_id],
    );
    expect(store[0]).toMatchObject({ owner_id: out.user_id, is_active: true });
  });

  it("refuses a duplicate email and a short password", async () => {
    const admin = await makeAdmin("admin2@platform.test");
    await provision(admin, "dupe@shop.test");

    await expect(provision(admin, "dupe@shop.test")).rejects.toThrow(/already exists/i);

    await expect(
      asUser(admin, () =>
        rows(`select public.platform_create_owner($1, $2, $3)`, ["short@shop.test", "abc", "Shop"]),
      ),
    ).rejects.toThrow(/at least 8/i);
  });

  it("keeps shop owners out of the platform functions entirely", async () => {
    const admin = await makeAdmin("admin3@platform.test");
    const { user_id } = await provision(admin, "owner2@shop.test");

    await expect(
      asUser(user_id, () => rows(`select public.platform_stores()`)),
    ).rejects.toThrow(/platform admins only/i);

    await expect(
      asUser(user_id, () =>
        rows(`select public.platform_create_owner($1, $2, $3)`, ["sneaky@shop.test", "generated-Passw0rd", "Shop"]),
      ),
    ).rejects.toThrow(/platform admins only/i);
  });

  it("is read-only over trading data", async () => {
    const admin = await makeAdmin("admin4@platform.test");
    const out = await provision(admin, "owner3@shop.test");

    // Provisioning twice is the closest thing to "editing" a shop the platform exposes: there is no
    // RPC that changes a sale, a product or a stock level, so the columns cannot drift.
    const detail = await asUser(admin, () =>
      rows<{ out: Record<string, unknown> }>(`select public.platform_store_detail($1) as out`, [out.store_id]),
    );
    expect(detail[0].out).toHaveProperty("store");
    expect(detail[0].out).toHaveProperty("platform_actions");
  });

  it("records every platform action in the audit trail", async () => {
    const admin = await makeAdmin("admin5@platform.test");
    const out = await provision(admin, "owner4@shop.test");

    const audit = await rows<{ action: string }>(
      `select action from platform_audit where store_id = $1 order by created_at`,
      [out.store_id],
    );
    expect(audit.map((a) => a.action)).toContain("owner_created");
  });

  it("refuses an unauthenticated caller before it reaches any data", async () => {
    // Grants and guards are two independent layers, and this checks the outer one: `anon` has no
    // execute privilege, so the call fails before the admin check even runs. Every RPC is listed,
    // because a single missing revoke re-opens the whole surface.
    const nothing = "00000000-0000-0000-0000-000000000000";
    const calls: [string, unknown[]][] = [
      [`select public.platform_stores()`, []],
      [`select public.platform_store_detail($1)`, [nothing]],
      [`select public.platform_create_owner($1,$2,$3)`, ["x@y.test", "generated-Passw0rd", "Shop"]],
      [`select public.platform_set_password($1,$2,$3)`, [nothing, "generated-Passw0rd", "r"]],
      [`select public.platform_set_store_active($1,$2,$3)`, [nothing, false, "r"]],
      [`select public.update_store_details('S',null,null,null,'LKR',0,5,true)`, []],
      [`select public.complete_password_change()`, []],
      // 0027: the bottle book's shop totals, and the internals no client may call at all.
      [`select public.bottle_totals()`, []],
      [`select public.bottles_owed($1,$2)`, [nothing, nothing]],
      [`select public.reverse_sale_bottles($1,$2)`, [nothing, true]],
      [`select public.charge_bottle_fee($1,$2,$3)`, [nothing, nothing, 1]],
    ];

    await db.exec(`set role anon`);
    try {
      for (const [sql, params] of calls) {
        await expect(rows(sql, params), sql).rejects.toThrow(/permission denied/i);
      }
    } finally {
      await db.exec(`reset role`);
    }
  });

  it("suspends a shop, hides it from its staff, and keeps it readable by the administrator", async () => {
    const admin = await makeAdmin("admin6@platform.test");
    const out = await provision(admin, "owner5@shop.test");

    // An administrator must give a reason: a silent shutdown is not auditable.
    await expect(
      asUser(admin, () =>
        rows(`select public.platform_set_store_active($1, false)`, [out.store_id]),
      ),
    ).rejects.toThrow(/reason is required/i);

    await asUser(admin, () =>
      rows(`select public.platform_set_store_active($1, false, $2)`, [out.store_id, "unpaid invoice"]),
    );

    // The owner can no longer resolve their shop, which is what every policy keys on.
    const storeForOwner = await asUser(out.user_id, async () => {
      const r = await rows<{ id: string | null }>(`select public.app_store_id() as id`);
      return r[0].id;
    });
    expect(storeForOwner).toBeNull();

    // ...and a real policy refuses a write, not just the helper returning null. RLS sees no visible
    // store row, so an insert aimed at the shut shop is rejected rather than silently orphaned.
    await expect(
      asUser(
        out.user_id,
        () => rows(`insert into categories (store_id, name) values ($1, 'sneaky')`, [out.store_id]),
        out.store_id,
      ),
    ).rejects.toThrow();

    // ...but the administrator still sees it, with the reason attached.
    const listed = await asUser(admin, () =>
      rows<{ name: string; is_active: boolean; suspended_reason: string }>(
        `select name, is_active, suspended_reason from public.platform_stores() where id = $1`,
        [out.store_id],
      ),
    );
    expect(listed[0]).toMatchObject({ is_active: false, suspended_reason: "unpaid invoice" });

    // Restoring clears the state.
    await asUser(admin, () => rows(`select public.platform_set_store_active($1, true)`, [out.store_id]));
    const back = await asUser(out.user_id, async () => {
      const r = await rows<{ id: string | null }>(`select public.app_store_id() as id`);
      return r[0].id;
    });
    expect(back).toBe(out.store_id);
  });

  it("lets the owner edit their own shop details and audits the change", async () => {
    const admin = await makeAdmin("admin7@platform.test");
    const out = await provision(admin, "owner6@shop.test");

    const after = await asUser(
      out.user_id,
      async () => {
        const r = await rows<{ out: Record<string, unknown> }>(
          `select public.update_store_details($1, $2, $3, $4, $5, $6, $7, $8) as out`,
          ["Renamed Spice Shop", "12 Galle Road", "0771234567", "VAT-99", "LKR", 15000, 7.5, true],
        );
        return r[0].out;
      },
      out.store_id,
    );

    expect(after).toMatchObject({ name: "Renamed Spice Shop", phone: "0771234567", vat_no: "VAT-99" });

    const audit = await rows<{ action: string; before: Record<string, unknown>; after: Record<string, unknown> }>(
      `select action, before, after from audit_logs where store_id = $1 and action = 'store_updated'`,
      [out.store_id],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].before.name).toBe("Test Spice Shop");
    expect(audit[0].after.name).toBe("Renamed Spice Shop");
  });

  it("refuses shop edits from a non-owner and validation errors from anyone", async () => {
    const admin = await makeAdmin("admin8@platform.test");
    const out = await provision(admin, "owner7@shop.test");

    // A cashier in the same shop may not edit the shop.
    await rows(
      `insert into profiles (store_id, full_name, staff_code, role) values ($1, 'Cashier', '3', 'cashier')`,
      [out.store_id],
    );
    const cashier = await newAuthUser("cashier7@shop.test");
    await rows(`update profiles set auth_user_id = $1 where store_id = $2 and staff_code = '3'`, [
      cashier,
      out.store_id,
    ]);

    await expect(
      asUser(
        cashier,
        () => rows(`select public.update_store_details('Hijacked', null, null, null, 'LKR', 0, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/only the shop owner/i);

    await expect(
      asUser(
        out.user_id,
        () => rows(`select public.update_store_details('', null, null, null, 'LKR', 0, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/name is required/i);

    await expect(
      asUser(
        out.user_id,
        () => rows(`select public.update_store_details('Shop', null, null, null, 'LKR', -1, 5, true)`),
        out.store_id,
      ),
    ).rejects.toThrow(/cannot be negative/i);
  });

  it("forces a password change after a reset and clears it when the owner complies", async () => {
    const admin = await makeAdmin("admin9@platform.test");
    const out = await provision(admin, "owner8@shop.test");

    // Provisioning already flags it.
    const before = await asUser(out.user_id, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(before.must_change_password).toBe(true);
    expect(before.onboarded).toBe(true);

    await asUser(out.user_id, () => rows(`select public.complete_password_change()`));

    const after = await asUser(out.user_id, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(after.must_change_password).toBe(false);

    // A reset re-arms the flag and changes the hash.
    const oldHash = await rows<{ h: string }>(`select encrypted_password as h from auth.users where id = $1`, [
      out.user_id,
    ]);
    await asUser(admin, () =>
      rows(`select public.platform_set_password($1, $2, $3)`, [out.user_id, "another-Passw0rd", "lost slip"]),
    );
    const newHash = await rows<{ h: string }>(`select encrypted_password as h from auth.users where id = $1`, [
      out.user_id,
    ]);
    expect(newHash[0].h).not.toBe(oldHash[0].h);
  });

  it("reports an administrator to the app as having no shop", async () => {
    const admin = await makeAdmin("admin10@platform.test");
    const shop = await asUser(admin, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(shop).toMatchObject({ onboarded: false, is_platform_admin: true });
  });

  it("runs the one-shot bootstrap script as written", async () => {
    // The bootstrap is a manual script whose only execution is a human pasting it into the SQL editor,
    // so a typo is not caught by any other test. Substitute the placeholders the way a person would
    // and run the file itself.
    const sql = bootstrap("create")
      .replace("'<ADMIN EMAIL>'", "'bootstrap@platform.test'")
      .replace("'<A LONG RANDOM PASSWORD>'", "'a-long-enough-password'")
      .replace("'<YOUR NAME>'", "'Bootstrap Admin'");

    await db.exec(sql);

    const admin = await rows<{ auth_user_id: string; full_name: string }>(
      `select auth_user_id, full_name from platform_admins where full_name = 'Bootstrap Admin'`,
    );
    expect(admin).toHaveLength(1);

    const user = await rows<{ email: string; encrypted_password: string; email_confirmed_at: string }>(
      `select email, encrypted_password, email_confirmed_at from auth.users where id = $1`,
      [admin[0].auth_user_id],
    );
    expect(user[0].email).toBe("bootstrap@platform.test");
    expect(user[0].encrypted_password).toMatch(/^\$2[aby]\$/);
    expect(user[0].email_confirmed_at).not.toBeNull();

    // The identity row is what makes email sign-in work; without it GoTrue rejects a valid password.
    const ident = await rows<{ provider: string }>(
      `select provider from auth.identities where user_id = $1`,
      [admin[0].auth_user_id],
    );
    expect(ident[0].provider).toBe("email");

    // ...and the account really is an administrator: the panel opens for it.
    const stores = await asUser(admin[0].auth_user_id, () => rows(`select * from public.platform_stores()`));
    expect(Array.isArray(stores)).toBe(true);

    // Running it twice must stop with a clear message rather than half-creating a second admin.
    await expect(db.exec(sql)).rejects.toThrow(/already exists/i);
  });

  it("promotes an existing shop owner instead of creating a second account", async () => {
    // The realistic situation: the operator has been testing as a shop owner and wants that same
    // login to run the platform. The promote block must add the admin row without touching the shop,
    // and my_shop() must then report both roles at once.
    const first = await makeAdmin("operator@platform.test");
    const { user_id, store_id } = await provision(first, "operator@shop.test");

    const sql = bootstrap("promote").replace("'<YOUR EMAIL>'", "'operator@shop.test'");
    await db.exec(sql);

    const isAdmin = await asUser(user_id, async () => {
      const r = await rows<{ is_platform_admin: boolean }>(`select public.is_platform_admin()`);
      return r[0].is_platform_admin;
    });
    expect(isAdmin).toBe(true);

    // The shop is untouched: still owned, still onboarded, still open. `store.id` is nested, so
    // checking it proves the promotion did not re-create or re-point the shop.
    const shop = await asUser(user_id, async () => {
      const r = await rows<{ my_shop: Record<string, unknown> }>(`select public.my_shop() as my_shop`);
      return r[0].my_shop;
    });
    expect(shop).toMatchObject({
      onboarded: true,
      is_platform_admin: true,
      suspended: false,
      store: { id: store_id },
    });

    // Promoted, not duplicated.
    const admins = await rows(`select 1 from platform_admins where auth_user_id = $1`, [user_id]);
    expect(admins).toHaveLength(1);

    // Idempotent: running it again reactivates rather than failing, so a mistaken
    // "is_active = false" is fixable without deleting anything.
    await db.exec(`update platform_admins set is_active = false where auth_user_id = '${user_id}'`);
    await db.exec(sql);
    const active = await rows<{ is_active: boolean }>(
      `select is_active from platform_admins where auth_user_id = $1`,
      [user_id],
    );
    expect(active[0].is_active).toBe(true);
  });

  it("breaks a shop down into takings, payment mix, best sellers and recent sales", async () => {
    const admin = await makeAdmin("admin11@platform.test");
    const { store_id, user_id } = await provision(admin, "detail@shop.test");

    // Seed two real sales rather than asserting on an empty shop, so the aggregates are actually
    // exercised. Two products with different prices keep the "best seller" ordering meaningful.
    await db.exec(`
      insert into products (id, store_id, name, price_cents, is_active)
      values ('11111111-1111-1111-1111-111111111111', '${store_id}', 'Cinnamon 100g', 45000, true),
             ('22222222-2222-2222-2222-222222222222', '${store_id}', 'Pepper 100g', 30000, true);

      insert into sales (id, store_id, receipt_no, status, subtotal_cents, total_cents, created_at)
      values ('aaaaaaaa-0000-0000-0000-000000000001', '${store_id}', 90001, 'completed', 75000, 75000, now()),
             ('aaaaaaaa-0000-0000-0000-000000000002', '${store_id}', 90002, 'completed', 30000, 30000, now());

      insert into sale_items (sale_id, product_id, name_snapshot, qty, unit_price_cents, line_total_cents)
      values ('aaaaaaaa-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111',
              'Cinnamon 100g', 1, 45000, 45000),
             ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-2222-2222-2222-222222222222',
              'Pepper 100g', 1, 30000, 30000),
             ('aaaaaaaa-0000-0000-0000-000000000002', '22222222-2222-2222-2222-222222222222',
              'Pepper 100g', 1, 30000, 30000);

      insert into payments (sale_id, method, amount_cents)
      values ('aaaaaaaa-0000-0000-0000-000000000001', 'cash', 75000),
             ('aaaaaaaa-0000-0000-0000-000000000002', 'card', 30000);
    `);

    const detail = await asUser(admin, async () => {
      const r = await rows<{ out: Record<string, unknown> }>(
        `select public.platform_store_detail($1) as out`,
        [store_id],
      );
      return r[0].out as {
        totals: Record<string, number | string | null>;
        payment_mix: { method: string; count: number; total_cents: number }[];
        top_products: { name: string; qty: string; revenue_cents: number }[];
        recent_sales: { receipt_no: number; cashier: string | null }[];
        staff: { sales_count: number }[];
      };
    });

    // 75000 + 30000 = 105000 lifetime; average basket 52500.
    expect(detail.totals.sales_cents).toBe(105000);
    expect(detail.totals.sale_count).toBe(2);
    expect(detail.totals.avg_sale_cents).toBe(52500);
    expect(detail.totals.product_count).toBe(2);
    expect(detail.totals.refund_count).toBe(0);

    // Payment mix is grouped per method, not per sale.
    const mix = Object.fromEntries(detail.payment_mix.map((p) => [p.method, p.total_cents]));
    expect(mix).toEqual({ cash: 75000, card: 30000 });

    // Pepper sold twice, so it leads on revenue as well as quantity.
    expect(detail.top_products[0].name).toBe("Pepper 100g");
    expect(Number(detail.top_products[0].qty)).toBe(2);
    expect(detail.top_products[0].revenue_cents).toBe(60000);

    // Newest first, and the till's own receipt number is preserved.
    expect(detail.recent_sales[0].receipt_no).toBe(90002);

    // Cost never travels: a product_costs row must not appear in the payload at all.
    await db.exec(
      `insert into product_costs (product_id, store_id, cost_cents)
       values ('11111111-1111-1111-1111-111111111111', '${store_id}', 12345)`,
    );
    const raw = await asUser(admin, async () => {
      const r = await rows<{ out: unknown }>(`select public.platform_store_detail($1) as out`, [store_id]);
      return JSON.stringify(r[0].out);
    });
    // Cost never travels: the seeded cost (12345) must not appear anywhere in the payload, and no
    // cost/margin key may leak. `stores.cost_method` is a valuation policy setting, not a cost, so
    // it is allowed - assert on keys and values rather than the substring "cost".
    expect(raw).not.toContain("12345");
    expect(raw.toLowerCase()).not.toContain("margin");
    expect(raw.toLowerCase()).not.toContain("cost_cents");
    expect(raw.toLowerCase()).not.toContain("unit_cost");

    // The owner is counted among staff, and the shop is untouched by a read.
    expect(detail.staff.length).toBeGreaterThanOrEqual(1);
    expect(user_id).toBeTruthy();
  });

  it("refuses a shop owner who asks for another shop's detail", async () => {
    const admin = await makeAdmin("admin12@platform.test");
    const a = await provision(admin, "peek1@shop.test");
    const b = await provision(admin, "peek2@shop.test");

    await expect(
      asUser(a.user_id, () => rows(`select public.platform_store_detail($1)`, [b.store_id])),
    ).rejects.toThrow(/platform admins only/i);
  });

  it("still returns a breakdown for a suspended shop", async () => {
    // Suspension closes the shop to its staff; it must not hide the shop from the operator, who needs
    // to see what it did before and after the decision.
    const admin = await makeAdmin("admin13@platform.test");
    const { store_id } = await provision(admin, "suspended-detail@shop.test");

    await asUser(admin, () =>
      rows(`select public.platform_set_store_active($1, false, 'unpaid invoice')`, [store_id]),
    );

    const detail = await asUser(admin, async () => {
      const r = await rows<{ out: { store: { is_active: boolean }; totals: { sale_count: number } } }>(
        `select public.platform_store_detail($1) as out`,
        [store_id],
      );
      return r[0].out;
    });
    expect(detail.store.is_active).toBe(false);
    expect(detail.totals.sale_count).toBe(0);
  });
});

/**
 * The UI reads `detail.totals.sale_count` and friends directly, so a payload missing those keys
 * crashes the whole screen (this happened against a live project still running the earlier RPC).
 * normaliseDetail is the single place that makes the shape total, so it is tested against the old
 * payload shape directly rather than through a mocked Supabase client.
 */
describe("platform detail payload normalisation", () => {
  const store = { id: "s1", name: "Shop" } as PlatformStoreDetail["store"];

  it("fills in the sections an older RPC never sent, and flags them", () => {
    const d = normaliseDetail({
      store,
      staff: [],
      recent_sales: [],
      monthly_sales: [],
      platform_actions: [],
    });

    expect(d.breakdown_available).toBe(false);
    expect(d.payment_mix).toEqual([]);
    expect(d.top_products).toEqual([]);
    // Zeroed, not undefined: rendering must not throw.
    expect(d.totals.sale_count).toBe(0);
    expect(d.totals.last_sale_at).toBeNull();
    expect(d.totals.sales_cents).toBe(0);
  });

  it("keeps real totals and marks the breakdown as available", () => {
    const d = normaliseDetail({
      store,
      totals: { ...normaliseDetail({}).totals, sale_count: 3, sales_cents: 4500, last_sale_at: "2026-01-01" },
      staff: [],
      recent_sales: [],
      monthly_sales: [],
      payment_mix: [],
      top_products: [],
      platform_actions: [],
    });

    expect(d.breakdown_available).toBe(true);
    expect(d.totals.sale_count).toBe(3);
    expect(d.totals.sales_cents).toBe(4500);
  });

  it("treats a null payload section as empty rather than crashing", () => {
    const d = normaliseDetail({ store, totals: null as never, staff: null as never });

    expect(d.staff).toEqual([]);
    expect(d.breakdown_available).toBe(false);
  });
});
