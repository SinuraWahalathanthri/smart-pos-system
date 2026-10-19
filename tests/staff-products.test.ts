import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0008: staff and product management called from the dashboard.
 *
 * The shop's rules, as permissions:
 *   owner       may add staff and products
 *   supervisor  may add products, may NOT touch staff
 *   cashier     may do neither
 *
 * These run through SECURITY DEFINER functions, so the checks below are the real boundary - the
 * UI hiding a button is not what stops a supervisor creating a cashier.
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

async function asUser<T>(authId: string, fn: () => Promise<T>, store: string): Promise<T> {
  await db.exec(
    `select set_config('request.jwt.claim.sub', '${authId}', false);
     select set_config('app.store_id', '${store}', false);
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

let store = "";
const who: Record<string, string> = {};

beforeAll(async () => {
  const ownerAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  store = (await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'RPC Shop') returning id`, [ownerAuth]))[0].id;

  const owner = (
    await rows<{ id: string }>(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role)
       values ($1, $2, 'Owner', '1', 'owner') returning id`,
      [ownerAuth, store],
    )
  )[0].id;
  who.ownerAuth = ownerAuth;
  who.owner = owner;

  // A supervisor and a cashier who also have auth accounts, so they can call the functions.
  for (const [name, code, role] of [
    ["Sup", "2", "supervisor"],
    ["Cash", "3", "cashier"],
  ] as const) {
    const auth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role)
       values ($1, $2, $3, $4, $5)`,
      [auth, store, name, code, role],
    );
    who[role] = auth;
  }
});

const rpc = <T>(name: string, args: unknown[]) =>
  rows<{ r: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then(
    (x) => x[0].r,
  );

describe("staff management is owner only", () => {
  it("lets the owner add a cashier", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string; staff_code: string; role: string }>("create_staff", ["Nimal", "10", "cashier", "1234"]),
      store,
    );
    expect(out.staff_code).toBe("10");
    expect(out.role).toBe("cashier");

    // The PIN is hashed, never stored or returned in clear.
    const r = await rows<{ pin_hash: string }>(`select pin_hash from profiles where id = $1`, [out.id]);
    expect(r[0].pin_hash).not.toBe("1234");
    expect(r[0].pin_hash.startsWith("$2")).toBe(true); // bcrypt
  });

  it("lets that cashier sign in with the new PIN", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ ok: boolean; staff: { name: string; role: string } }>("verify_staff_pin", ["10", "1234"]),
      store,
    );
    expect(out.ok).toBe(true);
    expect(out.staff.name).toBe("Nimal");
    expect(out.staff.role).toBe("cashier");
  });

  it("refuses a supervisor the right to add staff", async () => {
    await expect(
      asUser(who.supervisor, () => rpc("create_staff", ["Sneaky", "11", "cashier", "1234"]), store),
    ).rejects.toThrow(/only the owner can manage staff/i);
  });

  it("refuses a cashier the right to add staff", async () => {
    await expect(
      asUser(who.cashier, () => rpc("create_staff", ["Sneaky", "12", "supervisor", "1234"]), store),
    ).rejects.toThrow(/only the owner can manage staff/i);
  });

  it("rejects a duplicate staff code in the same shop", async () => {
    await expect(
      asUser(who.ownerAuth, () => rpc("create_staff", ["Copy", "10", "cashier", "1234"]), store),
    ).rejects.toThrow(/already used/i);
  });

  it("rejects a PIN that is not 4 to 8 digits", async () => {
    for (const bad of ["123", "123456789", "abcd", "12 34"]) {
      await expect(
        asUser(who.ownerAuth, () => rpc("create_staff", ["Bad Pin", "20", "cashier", bad]), store),
      ).rejects.toThrow(/pin must be 4 to 8 digits/i);
    }
  });

  it("does not allow a second owner", async () => {
    await expect(
      asUser(who.ownerAuth, () => rpc("create_staff", ["Second Owner", "30", "owner", "1234"]), store),
    ).rejects.toThrow(/only be one owner/i);
  });

  it("resets a PIN and unlocks a locked account", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string }>("create_staff", ["Locked", "31", "cashier", "1111"]),
      store,
    );
    // Simulate a lockout.
    await db.query(`update profiles set failed_attempts = 3, locked_until = now() + interval '5 min' where id = $1`, [
      out.id,
    ]);

    await asUser(who.ownerAuth, () => rpc("set_staff_pin", [out.id, "9999"]), store);

    const r = await rows<{ failed_attempts: number; locked_until: string | null }>(
      `select failed_attempts, locked_until from profiles where id = $1`,
      [out.id],
    );
    expect(r[0].failed_attempts).toBe(0);
    expect(r[0].locked_until).toBeNull();

    const login = await asUser(
      who.ownerAuth,
      () => rpc<{ ok: boolean }>("verify_staff_pin", ["31", "9999"]),
      store,
    );
    expect(login.ok).toBe(true);
  });

  it("deactivates a staff member but not the owner's own account", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string }>("create_staff", ["Leaver", "32", "cashier", "1234"]),
      store,
    );
    await asUser(who.ownerAuth, () => rpc("set_staff_active", [out.id, false]), store);

    const denied = await asUser(
      who.ownerAuth,
      () => rpc<{ ok: boolean; reason: string }>("verify_staff_pin", ["32", "1234"]),
      store,
    );
    expect(denied.ok).toBe(false);

    await expect(
      asUser(who.ownerAuth, () => rpc("set_staff_active", [who.owner, false]), store),
    ).rejects.toThrow(/cannot deactivate your own/i);
  });
});

describe("product management: owner and supervisor, not cashier", () => {
  it("lets the owner add a product", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string }>("save_product", [{ name: "Chilli Powder", price_cents: 45000, color: "red" }]),
      store,
    );
    const r = await rows<{ name: string; price_cents: string; store_id: string }>(
      `select name, price_cents, store_id from products where id = $1`,
      [out.id],
    );
    expect(r[0].name).toBe("Chilli Powder");
    expect(Number(r[0].price_cents)).toBe(45000);
    expect(r[0].store_id).toBe(store);
  });

  it("lets a supervisor add a product", async () => {
    const out = await asUser(
      who.supervisor,
      () => rpc<{ id: string }>("save_product", [{ name: "Turmeric", price_cents: 30000 }]),
      store,
    );
    const r = await rows<{ n: number }>(`select count(*)::int as n from products where id = $1`, [out.id]);
    expect(r[0].n).toBe(1);
  });

  it("refuses a cashier adding a product", async () => {
    await expect(
      asUser(who.cashier, () => rpc("save_product", [{ name: "Rogue", price_cents: 100 }]), store),
    ).rejects.toThrow(/owner or a supervisor/i);
  });

  it("marks a bottle product as returnable", async () => {
    const out = await asUser(
      who.ownerAuth,
      () =>
        rpc<{ id: string }>("save_product", [
          { name: "Fresh Milk (glass bottle)", price_cents: 25000, is_returnable_bottle: true },
        ]),
      store,
    );
    const r = await rows<{ is_returnable_bottle: boolean }>(
      `select is_returnable_bottle from products where id = $1`,
      [out.id],
    );
    expect(r[0].is_returnable_bottle).toBe(true);
  });

  it("updates an existing product without creating a second one", async () => {
    const created = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string }>("save_product", [{ name: "Pepper", price_cents: 100000 }]),
      store,
    );
    await asUser(
      who.ownerAuth,
      () => rpc("save_product", [{ id: created.id, name: "Black Pepper", price_cents: 120000 }]),
      store,
    );

    const r = await rows<{ name: string; price_cents: string; n: number }>(
      `select name, price_cents, (select count(*)::int from products where name in ('Pepper','Black Pepper')) as n
         from products where id = $1`,
      [created.id],
    );
    expect(r[0].name).toBe("Black Pepper");
    expect(Number(r[0].price_cents)).toBe(120000);
    expect(r[0].n).toBe(1);
  });

  it("registers a barcode for scanning", async () => {
    const out = await asUser(
      who.ownerAuth,
      () => rpc<{ id: string }>("save_product", [{ name: "Cardamom", price_cents: 500000, barcode: "4790001" }]),
      store,
    );
    const r = await rows<{ product_id: string }>(
      `select product_id from product_barcodes where barcode = '4790001'`,
    );
    expect(r[0].product_id).toBe(out.id);
  });

  it("rejects a product with no name", async () => {
    await expect(
      asUser(who.ownerAuth, () => rpc("save_product", [{ price_cents: 100 }]), store),
    ).rejects.toThrow(/product name is required/i);
  });

  it("rejects a negative price", async () => {
    await expect(
      asUser(who.ownerAuth, () => rpc("save_product", [{ name: "Negative", price_cents: -5 }]), store),
    ).rejects.toThrow(/price cannot be negative/i);
  });

  it("cannot edit a product belonging to another shop", async () => {
    const otherOwner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const otherStore = (
      await rows<{ id: string }>(
        `insert into stores (owner_id, name) values ($1, 'Foreign') returning id`,
        [otherOwner],
      )
    )[0].id;
    const foreignProduct = (
      await rows<{ id: string }>(
        `insert into products (store_id, name, price_cents) values ($1, 'Their Product', 999) returning id`,
        [otherStore],
      )
    )[0].id;

    await expect(
      asUser(
        who.ownerAuth,
        () => rpc("save_product", [{ id: foreignProduct, name: "Hijacked", price_cents: 1 }]),
        store,
      ),
    ).rejects.toThrow(/unknown product/i);

    const r = await rows<{ name: string }>(`select name from products where id = $1`, [foreignProduct]);
    expect(r[0].name).toBe("Their Product");
  });
});
