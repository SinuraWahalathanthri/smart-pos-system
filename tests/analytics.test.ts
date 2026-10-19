import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0010: dashboard analytics.
 *
 * The commercial rule worth testing: a supervisor sees what sold and for how much, but never what
 * the shop paid. Cost is returned as null for them rather than hidden by the UI, so the number is
 * not sitting in the browser waiting to be read in devtools.
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
const prod: Record<string, string> = {};
let customer = "";

beforeAll(async () => {
  const ownerAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  store = (
    await rows<{ id: string }>(
      `insert into stores (owner_id, name, bottle_fee_cents) values ($1, 'Analytics Shop', 10000) returning id`,
      [ownerAuth],
    )
  )[0].id;
  who.owner = ownerAuth;

  for (const [key, code, role] of [
    ["owner", "1", "owner"],
    ["supervisor", "2", "supervisor"],
    ["cashier", "3", "cashier"],
  ] as const) {
    const auth =
      key === "owner"
        ? ownerAuth
        : (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role)
       values ($1, $2, $3, $4, $5)`,
      [auth, store, key, code, role],
    );
    if (key !== "owner") who[key] = auth;
  }

  // Two products with a known cost, so margin can be checked by hand.
  for (const [key, name, price, cost, stock] of [
    ["chilli", "Chilli Powder", 45000, 30000, 10],
    ["milk", "Fresh Milk", 25000, 20000, 2],
  ] as const) {
    // stock_on_hand cannot be written directly (guard_stock_columns); opening stock is a movement.
    prod[key] = (
      await rows<{ id: string }>(
        `insert into products (store_id, name, price_cents, reorder_level, is_returnable_bottle)
         values ($1, $2, $3, 5, $4) returning id`,
        [store, name, price, key === "milk"],
      )
    )[0].id;
    await db.query(
      `insert into stock_movements (store_id, product_id, qty_change, type, created_by)
       values ($1, $2, $3, 'opening', (select id from profiles where store_id = $1 and role = 'owner' limit 1))`,
      [store, prod[key], stock],
    );
    await db.query(`insert into product_costs (product_id, store_id, cost_cents) values ($1, $2, $3)`, [
      prod[key],
      store,
      cost,
    ]);
  }

  customer = (
    await rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, 'Regular', '0771234567') returning id`,
      [store],
    )
  )[0].id;

  // One sale: 2 chilli (90,000) + 1 milk (25,000), attached to a customer.
  const sale = (
    await rows<{ id: string }>(
      `insert into sales (id, store_id, subtotal_cents, total_cents, customer_id, created_at)
       values (gen_random_uuid(), $1, 115000, 115000, $2, now()) returning id`,
      [store, customer],
    )
  )[0].id;
  for (const [pid, name, qty, price] of [
    [prod.chilli, "Chilli Powder", 2, 45000],
    [prod.milk, "Fresh Milk", 1, 25000],
  ] as const) {
    await db.query(
      `insert into sale_items (sale_id, product_id, kind, name_snapshot, qty, unit_price_cents, line_total_cents)
       values ($1, $2, 'item', $3, $4, $5, $6)`,
      [sale, pid, name, qty, price, qty * price],
    );
  }

  // Two bottles sold, one returned: one still out.
  await db.query(
    `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
     values ($1, $2, $3, 'sold', 2, 0), ($1, $2, $3, 'returned_with_purchase', 1, 0)`,
    [store, prod.milk, customer],
  );
});

const analytics = (auth: string) =>
  asUser(auth, async () => rows<Record<string, unknown>>(`select * from public.product_analytics(30)`), store);

describe("analytics permissions", () => {
  it("lets the owner see cost and margin", async () => {
    const r = await analytics(who.owner);
    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(Number(chilli.units_sold)).toBe(2);
    expect(Number(chilli.revenue_cents)).toBe(90000);
    expect(Number(chilli.cost_cents)).toBe(60000); // 2 x 30,000
    expect(Number(chilli.margin_cents)).toBe(30000);
  });

  it("hides cost and margin from a supervisor", async () => {
    const r = await analytics(who.supervisor);
    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(Number(chilli.units_sold)).toBe(2);
    expect(Number(chilli.revenue_cents)).toBe(90000);
    // Null, not zero: there is nothing to infer from.
    expect(chilli.cost_cents).toBeNull();
    expect(chilli.margin_cents).toBeNull();
  });

  it("refuses analytics to a cashier", async () => {
    await expect(analytics(who.cashier)).rejects.toThrow(/owner and supervisors/i);
  });
});

describe("analytics content", () => {
  it("reports the per-product numbers", async () => {
    const r = await analytics(who.owner);
    const milk = r.find((x) => x.name === "Fresh Milk")!;
    expect(Number(milk.units_sold)).toBe(1);
    expect(Number(milk.revenue_cents)).toBe(25000);
    expect(Number(milk.margin_cents)).toBe(5000); // 25,000 - 20,000
  });

  it("flags low stock from the reorder level", async () => {
    const r = await analytics(who.owner);
    const milk = r.find((x) => x.name === "Fresh Milk")!;
    expect(Number(milk.stock_on_hand)).toBe(2);
    expect(milk.is_low_stock).toBe(true);

    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(chilli.is_low_stock).toBe(false); // 10 on hand, reorder at 5
  });

  it("counts bottles still out per product", async () => {
    const r = await analytics(who.owner);
    const milk = r.find((x) => x.name === "Fresh Milk")!;
    expect(Number(milk.bottles_out)).toBe(1); // 2 sold, 1 returned
    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(Number(chilli.bottles_out)).toBe(0);
  });

  it("summarises the shop for the overview", async () => {
    const ov = await asUser(
      who.owner,
      async () => (await rows<{ ov: Record<string, number> }>(`select public.store_overview(30) as ov`))[0].ov,
      store,
    );
    expect(ov.sales).toBe(1);
    expect(Number(ov.revenue_cents)).toBe(115000);
    expect(ov.customers).toBe(1);
    expect(ov.bottles_out).toBe(1);
    expect(ov.low_stock).toBe(1); // milk only
    expect(ov.staff).toBe(3);
  });

  it("ignores sales outside the window", async () => {
    const old = (
      await rows<{ id: string }>(
        `insert into sales (id, store_id, subtotal_cents, total_cents, created_at)
         values (gen_random_uuid(), $1, 99900, 99900, now() - interval '40 days') returning id`,
        [store],
      )
    )[0].id;
    await db.query(
      `insert into sale_items (sale_id, product_id, kind, name_snapshot, qty, unit_price_cents, line_total_cents)
       values ($1, $2, 'item', 'Chilli Powder', 10, 45000, 450000)`,
      [old, prod.chilli],
    );

    const r = await analytics(who.owner);
    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(Number(chilli.units_sold)).toBe(2); // the 40-day-old sale is not counted

    const ov = await asUser(
      who.owner,
      async () => (await rows<{ ov: Record<string, number> }>(`select public.store_overview(30) as ov`))[0].ov,
      store,
    );
    expect(ov.sales).toBe(1);
  });

  it("excludes voided lines from revenue", async () => {
    const sale = (
      await rows<{ id: string }>(
        `insert into sales (id, store_id, subtotal_cents, total_cents, created_at)
         values (gen_random_uuid(), $1, 45000, 45000, now()) returning id`,
        [store],
      )
    )[0].id;
    await db.query(
      `insert into sale_items (sale_id, product_id, kind, name_snapshot, qty, unit_price_cents, line_total_cents, status)
       values ($1, $2, 'item', 'Chilli Powder', 1, 45000, 45000, 'voided')`,
      [sale, prod.chilli],
    );

    const r = await analytics(who.owner);
    const chilli = r.find((x) => x.name === "Chilli Powder")!;
    expect(Number(chilli.units_sold)).toBe(2); // still 2: the voided line is ignored
  });

  it("keeps another shop's numbers out", async () => {
    const otherAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const otherStore = (
      await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Other Shop') returning id`, [
        otherAuth,
      ])
    )[0].id;
    await db.query(
      `insert into products (store_id, name, price_cents, stock_on_hand) values ($1, 'Their Spice', 100, 1)`,
      [otherStore],
    );

    const r = await analytics(who.owner);
    expect(r.some((x) => x.name === "Their Spice")).toBe(false);
  });
});
