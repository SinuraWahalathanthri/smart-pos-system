import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0009: onboarding. A brand-new owner creates their shop, and the shop starts EMPTY.
 *
 * The point of these tests is the production requirement: no sample shop, no seeded catalogue.
 * A fresh shop must have zero products, zero customers and zero sales, and the owner must be able
 * to run the whole setup from the app rather than the SQL editor.
 */

const ROOT = join(__dirname, "..", "supabase");

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid());
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

const rows = async <T>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;

async function asUser<T>(authId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '', false);`);
  }
}

/**
 * A new account. Since 0029 a new shop needs an approved vendor application, so by default the
 * account gets one (written directly, standing in for the platform admin's approval).
 */
const newAccount = async ({ approved = true } = {}) => {
  const id = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  if (approved) {
    await db.query(
      `insert into vendor_applications
         (auth_user_id, status, owner_name, legal_name, business_type, country, terms_version, terms_accepted_at)
       values ($1, 'approved', 'Test Owner', 'Test Business', 'grocery', 'Sri Lanka', '2026-10', now())`,
      [id],
    );
  }
  return id;
};

const createStore = (auth: string, args: unknown[]) =>
  asUser(auth, async () => {
    const r = await rows<{ r: Record<string, unknown> }>(
      `select public.create_store(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`,
      args,
    );
    return r[0].r;
  });

const myShop = (auth: string) =>
  asUser(auth, async () => (await rows<{ r: Record<string, unknown> }>(`select public.my_shop() as r`))[0].r);

describe("onboarding a new shop", () => {
  it("reports an un-onboarded account before it has a shop", async () => {
    const auth = await newAccount();
    const shop = await myShop(auth);
    expect(shop.onboarded).toBe(false);
  });

  it("creates the shop, the owner profile, and starts completely empty", async () => {
    const auth = await newAccount();
    const out = await createStore(auth, ["Sinura Spice House", "12 Main St", "0771234567", null]);

    expect(out.created).toBe(true);
    const storeId = out.id as string;

    const store = await rows<{ name: string; owner_id: string; currency: string; bottle_fee_cents: string }>(
      `select name, owner_id, currency, bottle_fee_cents from stores where id = $1`,
      [storeId],
    );
    expect(store[0].name).toBe("Sinura Spice House");
    expect(store[0].owner_id).toBe(auth);
    expect(store[0].currency).toBe("LKR");
    expect(Number(store[0].bottle_fee_cents)).toBe(10000);

    // The owner is staff, so the till has somebody to sign in as.
    const owner = await rows<{ role: string; staff_code: string }>(
      `select role, staff_code from profiles where store_id = $1`,
      [storeId],
    );
    expect(owner).toEqual([{ role: "owner", staff_code: "1" }]);

    // Production requirement: nothing is pre-filled.
    for (const table of ["products", "customers", "sales", "categories", "stock_movements", "devices"]) {
      const r = await rows<{ n: number }>(`select count(*)::int as n from ${table} where store_id = $1`, [
        storeId,
      ]);
      expect(r[0].n, `${table} should be empty`).toBe(0);
    }
  });

  it("reports onboarded afterwards, with the shop and role", async () => {
    const auth = await newAccount();
    const out = await createStore(auth, ["Second Shop", null, null, null]);
    const shop = await myShop(auth);

    expect(shop.onboarded).toBe(true);
    expect(shop.role).toBe("owner");
    expect((shop.store as Record<string, unknown>).id).toBe(out.id);
    expect((shop.store as Record<string, unknown>).name).toBe("Second Shop");
  });

  it("does not create a duplicate shop if onboarding is submitted twice", async () => {
    const auth = await newAccount();
    const first = await createStore(auth, ["Once Only", null, null, null]);
    const again = await createStore(auth, ["Once Only", null, null, null]);

    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.id).toBe(first.id);

    const r = await rows<{ n: number }>(`select count(*)::int as n from stores where owner_id = $1`, [auth]);
    expect(r[0].n).toBe(1);
  });

  it("refuses a shop with no name", async () => {
    const auth = await newAccount();
    await expect(createStore(auth, ["   ", null, null, null])).rejects.toThrow(/shop name is required/i);
  });

  it("refuses a nonsense discount percentage", async () => {
    const auth = await newAccount();
    await expect(
      createStore(auth, ["Bad Discount", null, null, null, "LKR", true, 10000, 150]),
    ).rejects.toThrow(/between 0 and 100/i);
  });

  it("refuses a negative bottle fee", async () => {
    const auth = await newAccount();
    await expect(
      createStore(auth, ["Bad Fee", null, null, null, "LKR", true, -1, 5]),
    ).rejects.toThrow(/bottle fee cannot be negative/i);
  });

  it("refuses a new shop to an account without an approved application (0029)", async () => {
    const auth = await newAccount({ approved: false });
    await expect(createStore(auth, ["Unreviewed Shop", null, null, null])).rejects.toThrow(/wait for approval/i);
    expect(await rows(`select 1 from stores where name = 'Unreviewed Shop'`)).toEqual([]);
  });

  it("links the approved application to the shop and copies its business type", async () => {
    const auth = await newAccount();
    const out = await createStore(auth, ["Typed Shop", null, null, null]);
    const store = await rows<{ business_type: string; country: string }>(
      `select business_type, country from stores where id = $1`,
      [out.id],
    );
    expect(store[0]).toEqual({ business_type: "grocery", country: "Sri Lanka" });
    const app = await rows<{ store_id: string }>(`select store_id from vendor_applications where auth_user_id = $1`, [auth]);
    expect(app[0].store_id).toBe(out.id);
  });

  it("refuses onboarding with no signed-in account", async () => {
    await expect(
      asUser("", async () => rows(`select public.create_store('Anon Shop')`)),
    ).rejects.toThrow(/not_authenticated/i);
  });

  it("keeps the owner's own shop hidden from other owners", async () => {
    const mine = await newAccount();
    const theirs = await newAccount();
    const myStore = await createStore(mine, ["Private Shop", null, null, null]);

    const seen = await asUser(theirs, async () =>
      rows<{ id: string }>(`select id from stores where id = $1`, [myStore.id]),
    );
    expect(seen).toEqual([]);
  });

  it("lets the owner immediately add staff and products after onboarding", async () => {
    // The whole point: no SQL editor needed to get to a usable shop.
    const auth = await newAccount();
    const store = await createStore(auth, ["Ready Shop", null, null, null]);

    const staff = await asUser(auth, async () => {
      await db.query(`select set_config('app.store_id', $1, false)`, [store.id as string]);
      const r = await rows<{ r: { id: string } }>(
        `select public.create_staff('Kasun', '2', 'cashier', '1234') as r`,
      );
      return r[0].r;
    });
    expect(staff.id).toBeTruthy();

    const product = await asUser(auth, async () => {
      await db.query(`select set_config('app.store_id', $1, false)`, [store.id as string]);
      const r = await rows<{ r: { id: string } }>(
        `select public.save_product('{"name":"Cinnamon","price_cents":80000}'::jsonb) as r`,
      );
      return r[0].r;
    });
    expect(product.id).toBeTruthy();

    const counts = await rows<{ staff: number; products: number }>(
      `select (select count(*)::int from profiles where store_id = $1) as staff,
              (select count(*)::int from products where store_id = $1) as products`,
      [store.id],
    );
    expect(counts[0]).toEqual({ staff: 2, products: 1 }); // owner + cashier, one product
  });
});
