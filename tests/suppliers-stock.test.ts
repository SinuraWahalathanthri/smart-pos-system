import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0028: the write paths that existed in the schema but could not be reached.
 *
 *   save_supplier    without it a new shop could never record a supplier bill
 *   adjust_stock     owner or supervisor directly, cashier only with a token; never below zero
 *   archive_product  owner only, with a reason, resolved to the shop being looked at
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

const rpc = <T>(name: string, args: unknown[]) =>
  rows<{ r: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then(
    (x) => x[0].r,
  );

let store = "";
let unitProduct = "";
let spice = "";
let packet = "";
const who: Record<string, string> = {};

beforeAll(async () => {
  const ownerAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  who.owner = ownerAuth;
  store = (await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Main') returning id`, [ownerAuth]))[0].id;
  await db.query(
    `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, 'Owner', '1', 'owner')`,
    [ownerAuth, store],
  );
  for (const [name, code, role] of [
    ["Sup", "2", "supervisor"],
    ["Cash", "3", "cashier"],
  ] as const) {
    const auth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, $3, $4, $5)`,
      [auth, store, name, code, role],
    );
    who[role] = auth;
  }

  unitProduct = (await rows<{ id: string }>(`insert into products (store_id, name, price_cents) values ($1, 'Biscuit', 10000) returning id`, [store]))[0].id;
  spice = (
    await rows<{ id: string }>(
      `insert into products (store_id, name, sale_mode) values ($1, 'Chilli', 'weighted') returning id`,
      [store],
    )
  )[0].id;
  packet = (
    await rows<{ id: string }>(
      `insert into pack_sizes (store_id, product_id, label, weight_g, price_cents) values ($1, $2, '250 g', 250, 50000) returning id`,
      [store, spice],
    )
  )[0].id;
  await db.query(
    `insert into stock_movements (store_id, product_id, qty_change, type) values ($1, $2, 10, 'opening')`,
    [store, unitProduct],
  );
});

const onHand = async (id: string) =>
  Number((await rows<{ n: string }>(`select stock_on_hand as n from products where id = $1`, [id]))[0].n);

describe("suppliers", () => {
  it("lets a supervisor add a supplier and the owner rename it", async () => {
    const out = await asUser(who.supervisor, () => rpc<{ id: string }>("save_supplier", [{ name: " Lanka Spices ", phone: "0771234567", payment_terms_days: 30 }]), store);
    const s = (await rows<{ name: string; phone: string; payment_terms_days: number; store_id: string }>(
      `select name, phone, payment_terms_days, store_id from suppliers where id = $1`, [out.id]))[0];
    expect(s).toMatchObject({ name: "Lanka Spices", phone: "0771234567", payment_terms_days: 30, store_id: store });

    await asUser(who.owner, () => rpc("save_supplier", [{ id: out.id, name: "Lanka Spice Co" }]), store);
    expect((await rows<{ name: string }>(`select name from suppliers where id = $1`, [out.id]))[0].name).toBe("Lanka Spice Co");

    const audit = await rows<{ action: string }>(`select action from audit_logs where entity_id = $1 order by created_at`, [out.id]);
    expect(audit.map((a) => a.action)).toEqual(["supplier_created", "supplier_updated"]);
  });

  it("makes a supplier bill possible for a brand-new shop", async () => {
    const sup = await asUser(who.owner, () => rpc<{ id: string }>("save_supplier", [{ name: "Milk Board" }]), store);
    const bill = await asUser(
      who.owner,
      () => rpc<{ id: string }>("save_purchase", [{ supplier_id: sup.id, received_on: "2026-10-01", total_cents: 50000 }]),
      store,
    );
    expect(bill.id).toBeTruthy();
  });

  it("refuses a duplicate name, a blank name and a cashier", async () => {
    await expect(asUser(who.owner, () => rpc("save_supplier", [{ name: "lanka spice co" }]), store)).rejects.toThrow(/already exists/);
    await expect(asUser(who.owner, () => rpc("save_supplier", [{ name: "  " }]), store)).rejects.toThrow(/needs a name/);
    await expect(asUser(who.cashier, () => rpc("save_supplier", [{ name: "Sneaky" }]), store)).rejects.toThrow(/owner and supervisors/);
  });
});

describe("stock corrections", () => {
  it("lets the owner write off damaged stock", async () => {
    await asUser(who.owner, () => rpc("adjust_stock", [unitProduct, null, -3, "Crushed in delivery", null]), store);
    expect(await onHand(unitProduct)).toBe(7);
    const m = await rows<{ type: string; reason: string }>(
      `select type, reason from stock_movements where product_id = $1 and type = 'adjustment'`, [unitProduct]);
    expect(m).toEqual([{ type: "adjustment", reason: "Crushed in delivery" }]);
  });

  it("lets a supervisor correct a count without an approval token", async () => {
    await asUser(who.supervisor, () => rpc("adjust_stock", [unitProduct, null, 2, "Recount", null]), store);
    expect(await onHand(unitProduct)).toBe(9);
  });

  it("still requires an approval token from a cashier", async () => {
    await expect(asUser(who.cashier, () => rpc("adjust_stock", [unitProduct, null, -1, "Broke one", null]), store)).rejects.toThrow();
    expect(await onHand(unitProduct)).toBe(9);
  });

  it("refuses to take stock below zero", async () => {
    await expect(asUser(who.owner, () => rpc("adjust_stock", [unitProduct, null, -50, "Typo", null]), store)).rejects.toThrow(/only 9 on hand/);
  });

  it("corrects a weighted product on its packet, and refuses one without a packet", async () => {
    await asUser(who.owner, () => rpc("adjust_stock", [spice, packet, 4, "Found a box", null]), store);
    const p = await rows<{ n: string }>(`select packets_on_hand as n from pack_sizes where id = $1`, [packet]);
    expect(Number(p[0].n)).toBe(4);
    await expect(asUser(who.owner, () => rpc("adjust_stock", [spice, null, 1, "x", null]), store)).rejects.toThrow(/packet size/);
    await expect(asUser(who.owner, () => rpc("adjust_stock", [unitProduct, packet, 1, "x", null]), store)).rejects.toThrow(/sold by unit/);
  });

  it("requires a reason", async () => {
    await expect(asUser(who.owner, () => rpc("adjust_stock", [unitProduct, null, 1, " ", null]), store)).rejects.toThrow(/reason/);
  });
});

describe("archiving a product", () => {
  it("is refused to a supervisor and without a reason", async () => {
    await expect(asUser(who.supervisor, () => rpc("archive_product", [unitProduct, "Discontinued"]), store)).rejects.toThrow(/only the owner/);
    await expect(asUser(who.owner, () => rpc("archive_product", [unitProduct, ""]), store)).rejects.toThrow(/reason/);
  });

  it("hides the product and records why", async () => {
    await asUser(who.owner, () => rpc("archive_product", [unitProduct, "Discontinued"]), store);
    const p = (await rows<{ is_active: boolean; archived_at: string | null }>(`select is_active, archived_at from products where id = $1`, [unitProduct]))[0];
    expect(p.is_active).toBe(false);
    expect(p.archived_at).not.toBeNull();
    const a = await rows<{ reason: string }>(`select reason from audit_logs where action = 'product_archived' and entity_id = $1`, [unitProduct]);
    expect(a[0].reason).toBe("Discontinued");
    // Archiving twice is not a second event.
    await expect(asUser(who.owner, () => rpc("archive_product", [unitProduct, "Again"]), store)).rejects.toThrow(/not found/);
  });
});
