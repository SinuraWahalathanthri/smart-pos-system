import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0026: bottles per customer, visible to every role.
 *
 * The shop's rule is a loan, not a fee: a bottle goes out, the customer owes it, handing it back
 * costs nothing and keeping it means paying the deposit. This file pins the numbers the owner and
 * the cashier read off that rule - given out, came back, deposit taken instead, still owing, and
 * what the outstanding bottles are worth - because a wrong sign here either invents a debt or
 * forgives one.
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

const rpc = <T>(name: string, args: unknown[] = []) =>
  rows<{ r: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then(
    (x) => x[0].r,
  );

let owner = "";
let supervisor = "";
let cashier = "";
let store = "";
let otherStore = "";
let amara = "";
let nimal = "";
let milk = "";
let curd = "";

const FEE = 10000;

beforeAll(async () => {
  owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  store = (
    await rows<{ id: string }>(
      `insert into stores (owner_id, name, bottle_fee_cents) values ($1, 'Spice & Milk', $2) returning id`,
      [owner, FEE],
    )
  )[0].id;

  for (const [role, code] of [
    ["owner", "1"],
    ["supervisor", "2"],
    ["cashier", "3"],
  ] as const) {
    const auth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, $3, $4, $5)`,
      [auth, store, role, code, role],
    );
    if (role === "owner") owner = auth;
    if (role === "supervisor") supervisor = auth;
    if (role === "cashier") cashier = auth;
  }

  const otherAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  otherStore = (
    await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Elsewhere') returning id`, [
      otherAuth,
    ])
  )[0].id;

  amara = (
    await rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, 'Amara Perera', '0771234567') returning id`,
      [store],
    )
  )[0].id;
  nimal = (
    await rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, 'Nimal Silva', '0712223344') returning id`,
      [store],
    )
  )[0].id;
});

const product = (name: string, storeId = store, bottled = true) =>
  rows<{ id: string }>(
    `insert into products (store_id, name, price_cents, is_returnable_bottle) values ($1, $2, 25000, $3) returning id`,
    [storeId, name, bottled],
  ).then((r) => r[0].id);

const ledger = (customer: string | null, productId: string | null, event: string, qty: number, amount = 0) =>
  db.query(
    `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
     values ($1, $2, $3, $4::public.bottle_event, $5, $6)`,
    [store, productId, customer, event, qty, amount],
  );

const summary = (onlyOutstanding = true) =>
  asUser(owner, () => rows<{
    customer_id: string;
    name: string;
    sent_out: number;
    returned: number;
    charged: number;
    waived: number;
    outstanding: number;
    worth_cents: number;
    last_out_at: string | null;
    last_return_at: string | null;
  }>(`select * from public.customer_bottle_summary($1, 100)`, [onlyOutstanding]), store);

describe("the numbers per customer", () => {
  beforeAll(async () => {
    milk = await product("Fresh Milk");
    curd = await product("Curd Pot");
    // Amara: 3 milk out, 1 back, 1 deposit kept -> 1 still owing.
    await ledger(amara, milk, "sold", 3);
    await ledger(amara, milk, "returned_later", 1);
    await ledger(amara, milk, "fee_charged", 1, FEE);
    // Nimal: 1 curd out, nothing back.
    await ledger(nimal, curd, "sold", 1);
  });

  it("reports out, back, charged and owing for each customer", async () => {
    const list = await summary();
    const a = list.find((r) => r.customer_id === amara)!;
    const n = list.find((r) => r.customer_id === nimal)!;

    expect(a).toMatchObject({ sent_out: 3, returned: 1, charged: 1, outstanding: 1 });
    expect(Number(a.worth_cents)).toBe(FEE);
    expect(n).toMatchObject({ sent_out: 1, returned: 0, charged: 0, outstanding: 1 });
    expect(Number(n.worth_cents)).toBe(FEE);
  });

  it("agrees with customer_bottles_outstanding, which is the number the till shows", async () => {
    for (const id of [amara, nimal]) {
      const single = await asUser(
        owner,
        () => rpc<number>("customer_bottles_outstanding", [id]),
        store,
      );
      const row = (await summary()).find((r) => r.customer_id === id);
      expect(Number(single)).toBe(Number(row?.outstanding));
    }
  });

  it("orders the biggest debtor first, because that is who to chase", async () => {
    await ledger(amara, milk, "sold", 2);
    const list = await summary();
    expect(list[0].customer_id).toBe(amara);
    expect(list[0].outstanding).toBe(3);
  });

  it("treats a waived fee as money forgiven, never as a bottle returned", async () => {
    // The supervisor waived the deposit at the till: the money is gone, the bottle is not.
    await ledger(nimal, await product("Ghee Jar"), "fee_waived", 1);
    const n = (await summary()).find((r) => r.customer_id === nimal)!;
    expect(n.waived).toBe(1);
    expect(n.outstanding).toBe(1);
  });

  it("drops a customer from the default list once nothing is owing", async () => {
    await asUser(owner, () => rpc("return_bottles", [nimal, curd, 1, false]), store);
    const outstandingOnly = await summary(true);
    expect(outstandingOnly.some((r) => r.customer_id === nimal)).toBe(false);

    // ...but the history is still there when the owner asks for it.
    const everything = await summary(false);
    const n = everything.find((r) => r.customer_id === nimal)!;
    expect(n.outstanding).toBe(0);
    expect(n.sent_out).toBe(1);
    expect(n.returned).toBe(1);
  });
});

describe("what one customer has, per product", () => {
  it("splits one customer's bottles across the products they took", async () => {
    const ghee = await product("Ghee Jar");
    await ledger(amara, ghee, "sold", 2);

    const list = await asUser(
      owner,
      () => rows<{ name: string; sent_out: number; returned: number; charged: number; outstanding: number }>(
        `select * from public.customer_bottles_by_product($1)`, [amara],
      ),
      store,
    );
    expect(list.map((r) => r.name)).toEqual(["Fresh Milk", "Ghee Jar"]);
    const milkRow = list.find((r) => r.name === "Fresh Milk")!;
    expect(Number(milkRow.sent_out)).toBe(5);
    expect(Number(milkRow.returned)).toBe(1);
    expect(Number(milkRow.charged)).toBe(1);
    expect(Number(milkRow.outstanding)).toBe(3);

    const gheeRow = list.find((r) => r.name === "Ghee Jar")!;
    expect(Number(gheeRow.outstanding)).toBe(2);
  });

  it("never invents a row for a customer with no bottles", async () => {
    const stranger = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'New Face', '0770000001') returning id`,
        [store],
      )
    )[0].id;
    const list = await asUser(
      owner,
      () => rows(`select * from public.customer_bottles_by_product($1)`, [stranger]),
      store,
    );
    expect(list).toEqual([]);
  });

  it("refuses a customer from another shop rather than returning an empty list", async () => {
    const foreign = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Theirs', '0779999999') returning id`,
        [otherStore],
      )
    )[0].id;
    await expect(
      asUser(owner, () => rows(`select * from public.customer_bottles_by_product($1)`, [foreign]), store),
    ).rejects.toThrow(/unknown customer/i);
  });
});

describe("who changed what", () => {
  let milk = "";

  beforeAll(async () => {
    milk = await product("Butter Bottle");
    await ledger(nimal, milk, "sold", 3);
  });

  it("records the person who registered a return, so it can be attributed", async () => {
    await asUser(cashier, () => rpc("return_bottles", [nimal, milk, 1, false]), store);
    const marked = await rows<{ created_by: string | null }>(
      `select created_by from bottle_ledger
        where customer_id = $1 and event = 'returned_later'
        order by created_at desc limit 1`,
      [nimal],
    );
    const cashierProfile = (
      await rows<{ id: string }>(`select id from profiles where role = 'cashier' and store_id = $1`, [store])
    )[0].id;
    expect(marked[0].created_by).toBe(cashierProfile);
  });

  it("names the customer on every movement, and says Walk-in only when there is none", async () => {
    const walkInProduct = await product("Walk-in Yoghurt");
    await ledger(null, walkInProduct, "sold", 1);

    const feed = await asUser(
      owner,
      () => rows<{ customer_name: string | null; product_name: string | null; event: string; qty: number }>(
        `select * from public.bottle_events(null, 50)`,
      ),
      store,
    );
    const walkIn = feed.find((e) => e.product_name === "Walk-in Yoghurt")!;
    expect(walkIn.customer_name).toBeNull();
    expect(feed.some((e) => e.customer_name === "Nimal Silva")).toBe(true);
  });

  it("filters the feed to one customer", async () => {
    const feed = await asUser(
      owner,
      () => rows<{ customer_id: string }>(`select * from public.bottle_events($1, 50)`, [amara]),
      store,
    );
    expect(feed.length).toBeGreaterThan(0);
    expect(feed.every((e) => e.customer_id === amara)).toBe(true);
  });
});

describe("every role can see the bottle book", () => {
  it("lets a cashier read the summary, the per-product rows and the feed", async () => {
    for (const auth of [cashier, supervisor, owner]) {
      const list = await asUser(
        auth,
        () => rows<{ outstanding: number }>(`select * from public.customer_bottle_summary(true, 50)`),
        store,
      );
      expect(list.length).toBeGreaterThan(0);

      const byProduct = await asUser(
        auth,
        () => rows(`select * from public.customer_bottles_by_product($1)`, [amara]),
        store,
      );
      expect(byProduct.length).toBeGreaterThan(0);

      const feed = await asUser(auth, () => rows(`select * from public.bottle_events(null, 10)`), store);
      expect(feed.length).toBeGreaterThan(0);
    }
  });
});

describe("the deposit is still only taken for our own bottles", () => {
  // Since 0027 a deposit is a line on a bill, so the guards live in complete_sale.
  const depositBill = (customerId: string, productId: string) =>
    asUser(
      owner,
      () =>
        rpc("complete_sale", [
          JSON.stringify({
            id: crypto.randomUUID(),
            customer_id: customerId,
            subtotal_cents: FEE,
            discount_cents: 0,
            total_cents: FEE,
            lines: [{ kind: "bottle_fee", product_id: productId, name: "Bottle deposit", qty: 1,
                      unit_price_cents: FEE, tax_rate_pct: 0, tax_cents: 0, line_total_cents: FEE }],
            payments: [{ method: "cash", amount_cents: FEE }],
          }),
        ]),
      store,
    );

  it("refuses a product from another shop, which would credit a bottle to the wrong tenant", async () => {
    const theirBottle = await product("Their Milk", otherStore);
    await ledger(nimal, await product("Cream Bottle"), "sold", 1);
    await expect(depositBill(nimal, theirBottle)).rejects.toThrow(/unknown product/i);
  });

  it("refuses a product that does not come in a returnable bottle", async () => {
    const loose = await product("Loose Chilli", store, false);
    await expect(depositBill(nimal, loose)).rejects.toThrow(/returnable bottle/i);
  });

  it("refuses a customer from another shop", async () => {
    const foreignCustomer = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Theirs 2', '0771112222') returning id`,
        [otherStore],
      )
    )[0].id;
    await expect(depositBill(foreignCustomer, await product("Our Curd"))).rejects.toThrow(/unknown customer/i);
  });
});

describe("one shop never sees another's bottles", () => {
  it("excludes another shop's customers from the summary and the feed", async () => {
    const theirCustomer = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Their Debtor', '0773334444') returning id`,
        [otherStore],
      )
    )[0].id;
    const theirBottle = await product("Their Ghee", otherStore);
    await db.query(
      `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
       values ($1, $2, $3, 'sold', 5, 0)`,
      [otherStore, theirBottle, theirCustomer],
    );

    const list = await summary();
    expect(list.some((r) => r.name === "Their Debtor")).toBe(false);

    const feed = await asUser(
      owner,
      () => rows<{ product_name: string | null }>(`select * from public.bottle_events(null, 100)`),
      store,
    );
    expect(feed.some((e) => e.product_name === "Their Ghee")).toBe(false);
  });

  it("values the outstanding bottles at the deposit the shop charges now", async () => {
    const before = (await summary()).find((r) => r.customer_id === amara)!;
    await db.query(`update stores set bottle_fee_cents = $1 where id = $2`, [15000, store]);
    const after = (await summary()).find((r) => r.customer_id === amara)!;
    expect(Number(after.worth_cents)).toBe(Number(before.outstanding) * 15000);
    await db.query(`update stores set bottle_fee_cents = $1 where id = $2`, [FEE, store]);
  });
});
