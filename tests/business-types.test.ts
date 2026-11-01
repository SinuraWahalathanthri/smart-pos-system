import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0030: any kind of business.
 *
 *   variants         a shirt in sizes and colours, each its own stock, price and barcode
 *   measured         sold in a decimal of its unit (2.5 m of cable)
 *   services         track_stock = false never writes the stock ledger
 *   batches          receiving records batch + expiry; sales use the first to expire
 *   shop profile     owner-only business type, features and colours, validated
 *   barcodes         a code already used by another product is refused, not silently moved
 */

const ROOT = join(__dirname, "..", "supabase");

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create role anon nologin;
  create role authenticated nologin;
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key default gen_random_uuid(), email text,
    email_confirmed_at timestamptz, raw_user_meta_data jsonb);
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
const who: Record<string, string> = {};

beforeAll(async () => {
  for (const role of ["owner", "supervisor", "cashier"] as const) {
    who[role] = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  }
  store = (await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Threads') returning id`, [who.owner]))[0].id;
  let code = 1;
  for (const role of ["owner", "supervisor", "cashier"] as const) {
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, $3, $4, $5)`,
      [who[role], store, role, String(code++), role],
    );
  }
});

const sell = (lines: { product_id: string; pack_size_id?: string; qty: number; unit_price_cents: number }[]) => {
  const total = lines.reduce((s, l) => s + Math.round(l.qty * l.unit_price_cents), 0);
  return asUser(who.owner, () =>
    rpc("complete_sale", [
      JSON.stringify({
        id: crypto.randomUUID(),
        created_at: new Date().toISOString(),
        subtotal_cents: total,
        discount_cents: 0,
        total_cents: total,
        lines: lines.map((l) => ({
          kind: "item", name: "x", tax_rate_pct: 0, tax_cents: 0,
          line_total_cents: Math.round(l.qty * l.unit_price_cents), ...l,
        })),
        payments: [{ method: "cash", amount_cents: total }],
      }),
    ]),
  );
};

const packOnHand = async (id: string) =>
  Number((await rows<{ n: string }>(`select packets_on_hand as n from pack_sizes where id = $1`, [id]))[0].n);
const onHand = async (id: string) =>
  Number((await rows<{ n: string }>(`select stock_on_hand as n from products where id = $1`, [id]))[0].n);

describe("variants", () => {
  let shirt = "";
  let options: { id: string; label: string; attributes: Record<string, string> }[] = [];

  it("creates a product with size and colour options, each with its own stock and barcode", async () => {
    shirt = (await asUser(who.supervisor, () =>
      rpc<{ id: string }>("save_product", [{ name: "Linen shirt", sale_mode: "variant", price_cents: 450000 }]),
    )).id;
    await asUser(who.supervisor, () =>
      rpc("save_pack_sizes", [shirt, JSON.stringify([
        { attributes: { Size: "M", Colour: "Black" }, price_cents: 450000, opening_stock: 4, barcode: "SHIRT-M-BLK" },
        { attributes: { Size: "L", Colour: "Black" }, price_cents: 470000, opening_stock: 2 },
      ])]),
    );
    options = await rows(`select id, label, attributes from pack_sizes where product_id = $1 order by label`, [shirt]);
    expect(options.map((o) => o.label)).toEqual(["L / Black", "M / Black"]);
    expect(await packOnHand(options[1].id)).toBe(4);
    expect(await packOnHand(options[0].id)).toBe(2);
    const bc = await rows<{ pack_size_id: string }>(`select pack_size_id from product_barcodes where barcode = 'SHIRT-M-BLK'`);
    expect(bc[0].pack_size_id).toBe(options[1].id);
  });

  it("sells one option and takes stock off that option only", async () => {
    await sell([{ product_id: shirt, pack_size_id: options[1].id, qty: 1, unit_price_cents: 450000 }]);
    expect(await packOnHand(options[1].id)).toBe(3);
    expect(await packOnHand(options[0].id)).toBe(2);
  });

  it("receives and corrects stock per option", async () => {
    await asUser(who.owner, () => rpc("receive_stock", [shirt, options[0].id, 5, 200000, null, null]));
    expect(await packOnHand(options[0].id)).toBe(7);
    await expect(asUser(who.owner, () => rpc("receive_stock", [shirt, null, 5, null, null, null]))).rejects.toThrow(
      /size or variant/,
    );
    await asUser(who.owner, () => rpc("adjust_stock", [shirt, options[0].id, -1, "Damaged", null]));
    expect(await packOnHand(options[0].id)).toBe(6);
  });

  it("refuses the same option twice and half a shirt", async () => {
    await expect(asUser(who.owner, () =>
      rpc("save_pack_sizes", [shirt, JSON.stringify([
        { attributes: { Size: "M", Colour: "Black" }, price_cents: 1 },
        { label: "m / black", price_cents: 1 },
      ])]),
    )).rejects.toThrow(/listed twice/);
    await expect(asUser(who.owner, () => rpc("receive_stock", [shirt, options[0].id, 1.5, null, null, null]))).rejects.toThrow(
      /whole number/,
    );
  });
});

describe("measured items", () => {
  it("sells 2.5 m and keeps the fraction", async () => {
    const cable = (await asUser(who.owner, () =>
      rpc<{ id: string }>("save_product", [{ name: "Cable 2.5mm", sale_mode: "measured", unit: "m", price_cents: 12000, opening_stock: 100 }]),
    )).id;
    await sell([{ product_id: cable, qty: 2.5, unit_price_cents: 12000 }]);
    expect(await onHand(cable)).toBe(97.5);
  });

  it("refuses an invented unit and a fractional count on a unit item", async () => {
    await expect(asUser(who.owner, () => rpc("save_product", [{ name: "X", unit: "kilos" }]))).rejects.toThrow(/unknown unit/);
    await expect(asUser(who.owner, () => rpc("save_product", [{ name: "Y", opening_stock: 1.5 }]))).rejects.toThrow(/whole number/);
  });
});

describe("services", () => {
  it("never write the stock ledger, whatever sells them", async () => {
    const cut = (await asUser(who.owner, () =>
      rpc<{ id: string }>("save_product", [{ name: "Haircut", unit: "session", price_cents: 150000, track_stock: false, opening_stock: 5 }]),
    )).id;
    await sell([{ product_id: cut, qty: 1, unit_price_cents: 150000 }]);
    expect(await onHand(cut)).toBe(0);
    expect((await rows(`select 1 from stock_movements where product_id = $1`, [cut])).length).toBe(0);
    await expect(asUser(who.owner, () => rpc("receive_stock", [cut, null, 1, null, null, null]))).rejects.toThrow(/does not keep stock/);
  });
});

describe("batches and expiry", () => {
  it("uses the batch that expires first and reports what is close to expiry", async () => {
    const syrup = (await asUser(who.owner, () => rpc<{ id: string }>("save_product", [{ name: "Cough syrup", price_cents: 90000 }]))).id;
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 200 * 86400_000).toISOString().slice(0, 10);
    await asUser(who.owner, () => rpc("receive_stock_batch", [syrup, null, 5, 50000, null, null, "B-LATE", later]));
    await asUser(who.owner, () => rpc("receive_stock_batch", [syrup, null, 3, 50000, null, null, "B-SOON", soon]));
    expect(await onHand(syrup)).toBe(8);

    await sell([{ product_id: syrup, qty: 4, unit_price_cents: 90000 }]);
    const left = await rows<{ batch_no: string; qty_remaining: string }>(
      `select batch_no, qty_remaining from product_batches where product_id = $1 order by batch_no`, [syrup]);
    expect(left.map((b) => [b.batch_no, Number(b.qty_remaining)])).toEqual([["B-LATE", 4], ["B-SOON", 0]]);

    const expiring = await asUser(who.cashier, () =>
      rows<{ batch_no: string }>(`select batch_no from public.expiring_batches(300) where product_name = 'Cough syrup'`));
    expect(expiring.map((b) => b.batch_no)).toEqual(["B-LATE"]);
    expect((await rows<{ has_expiry: boolean }>(`select has_expiry from products where id = $1`, [syrup]))[0].has_expiry).toBe(true);
  });

  it("refuses a batch that has already expired", async () => {
    const p = (await asUser(who.owner, () => rpc<{ id: string }>("save_product", [{ name: "Old stock" }]))).id;
    await expect(asUser(who.owner, () => rpc("receive_stock_batch", [p, null, 1, null, null, null, "X", "2020-01-01"]))).rejects.toThrow(
      /already expired/,
    );
  });
});

describe("shop profile", () => {
  it("lets the owner set business type, features and colours, and shows them to the till", async () => {
    await asUser(who.owner, () =>
      rpc("save_shop_profile", [{ business_type: "fashion", features: { variants: true, bottles: false }, theme: { accent: "#BE185D", tone: "rose" } }]),
    );
    const shop = await asUser(who.owner, () => rpc<{ store: { business_type: string; features: object; theme: object } }>("my_shop", []));
    expect(shop.store.business_type).toBe("fashion");
    expect(shop.store.features).toEqual({ variants: true, bottles: false });
    expect(shop.store.theme).toEqual({ accent: "#be185d", tone: "rose" });
    const till = await asUser(who.cashier, () => rpc<{ store: { theme: object } }>("get_till_context", []));
    expect(till.store.theme).toEqual({ accent: "#be185d", tone: "rose" });
  });

  it("refuses a supervisor, an unknown feature, a bad colour and an unknown business type", async () => {
    await expect(asUser(who.supervisor, () => rpc("save_shop_profile", [{ theme: { tone: "cool" } }]))).rejects.toThrow(/only the owner/);
    await expect(asUser(who.owner, () => rpc("save_shop_profile", [{ features: { teleport: true } }]))).rejects.toThrow(/unknown feature/);
    await expect(asUser(who.owner, () => rpc("save_shop_profile", [{ theme: { accent: "red; background:url(x)" } }]))).rejects.toThrow(
      /accent must be/,
    );
    await expect(asUser(who.owner, () => rpc("save_shop_profile", [{ business_type: "casino" }]))).rejects.toThrow(/kind of business/);
  });
});

describe("barcodes", () => {
  it("refuses a code that belongs to another product instead of moving it", async () => {
    const a = (await asUser(who.owner, () => rpc<{ id: string }>("save_product", [{ name: "Soap", barcode: "4790001" }]))).id;
    await expect(asUser(who.owner, () => rpc("save_product", [{ name: "Shampoo", barcode: "4790001" }]))).rejects.toThrow(
      /already used by Soap/,
    );
    const owner = await rows<{ product_id: string }>(`select product_id from product_barcodes where barcode = '4790001'`);
    expect(owner[0].product_id).toBe(a);
    // Saving the same product again with its own code is fine.
    await asUser(who.owner, () => rpc("save_product", [{ id: a, name: "Soap", barcode: "4790001" }]));
  });
});
