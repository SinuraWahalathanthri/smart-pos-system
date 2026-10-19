import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0011: bottles coming back.
 *
 * The shop's actual rule, in its own money: milk 250, deposit 100, deposit NOT taken up front. The
 * customer owes a bottle, and the 100 only appears when a later visit takes another bottle without
 * returning the first.
 *
 * The expensive bug this file exists to catch: crediting a return the customer never made, which
 * hands out a free bottle, or charging a fee for a bottle already accounted for, which charges twice.
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

let owner = "";
let cashierAuth = "";
let store = "";
let customer = "";
let milk = "";
let chilli = "";

beforeAll(async () => {
  owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  store = (
    await rows<{ id: string }>(
      `insert into stores (owner_id, name, bottle_fee_cents) values ($1, 'Milk Bar', 10000) returning id`,
      [owner],
    )
  )[0].id;

  for (const [auth, code, role] of [
    [owner, "1", "owner"],
    [null, "3", "cashier"],
  ] as const) {
    const a =
      auth ?? (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, $3, $4, $5)`,
      [a, store, role, code, role],
    );
    if (role === "cashier") cashierAuth = a;
  }

  customer = (
    await rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, 'Milk Regular', '0771234567') returning id`,
      [store],
    )
  )[0].id;

  milk = (
    await rows<{ id: string }>(
      `insert into products (store_id, name, price_cents, is_returnable_bottle)
       values ($1, 'Fresh Milk', 25000, true) returning id`,
      [store],
    )
  )[0].id;
  chilli = (
    await rows<{ id: string }>(
      `insert into products (store_id, name, price_cents) values ($1, 'Chilli Powder', 45000) returning id`,
      [store],
    )
  )[0].id;
});

const outstanding = () =>
  asUser(owner, async () => (await rows<{ n: number }>(`select public.customer_bottles_outstanding($1) as n`, [customer]))[0].n, store);

const lend = (qty: number) =>
  db.query(
    `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
     values ($1, $2, $3, 'sold', $4, 0)`,
    [store, milk, customer, qty],
  );

describe("returning a bottle", () => {
  it("starts with nothing owed", async () => {
    expect(await outstanding()).toBe(0);
  });

  it("can lend a bottle without taking a deposit", async () => {
    await lend(1);
    expect(await outstanding()).toBe(1);

    const fees = await rows<{ n: number }>(
      `select count(*)::int as n from bottle_ledger where customer_id = $1 and event = 'fee_charged'`,
      [customer],
    );
    expect(fees[0].n).toBe(0);
  });

  it("clears the debt when the bottle comes back", async () => {
    const out = await asUser(
      owner,
      () => rpc<{ returned: number; outstanding: number }>("return_bottles", [customer, milk, 1, true]),
      store,
    );
    expect(out).toEqual({ returned: 1, outstanding: 0 });
    expect(await outstanding()).toBe(0);
  });

  it("refuses a return the customer did not make", async () => {
    // The free-bottle bug: crediting a return when nothing is out.
    await expect(
      asUser(owner, () => rpc("return_bottles", [customer, milk, 1, false]), store),
    ).rejects.toThrow(/only has 0 bottle/i);
  });

  it("refuses to return more bottles than are out", async () => {
    await lend(1);
    await expect(
      asUser(owner, () => rpc("return_bottles", [customer, milk, 2, false]), store),
    ).rejects.toThrow(/only has 1 bottle/i);
    expect(await outstanding()).toBe(1); // nothing was partially applied
  });

  it("charges the 100 instead of taking the bottle back", async () => {
    const out = await asUser(
      owner,
      () => rpc<{ charged_cents: number; outstanding: number }>("charge_bottle_fee", [customer, milk, 1]),
      store,
    );
    expect(Number(out.charged_cents)).toBe(10000);
    expect(out.outstanding).toBe(0);
    expect(await outstanding()).toBe(0);
  });

  it("does not charge a second time for the same bottle", async () => {
    // The double-charge bug: the loan was already settled by the fee.
    await expect(
      asUser(owner, () => rpc("charge_bottle_fee", [customer, milk, 1]), store),
    ).rejects.toThrow(/only has 0 bottle/i);
  });

  it("handles several bottles at once", async () => {
    await lend(3);
    expect(await outstanding()).toBe(3);

    await asUser(owner, () => rpc("return_bottles", [customer, milk, 2, false]), store);
    expect(await outstanding()).toBe(1);

    await asUser(owner, () => rpc("charge_bottle_fee", [customer, milk, 1]), store);
    expect(await outstanding()).toBe(0);
  });

  it("refuses zero or negative quantities", async () => {
    for (const bad of [0, -1]) {
      await expect(
        asUser(owner, () => rpc("return_bottles", [customer, milk, bad, false]), store),
      ).rejects.toThrow(/must be positive/i);
    }
  });
});

describe("who may register a return", () => {
  it("lets a cashier do it, since the cashier meets the customer", async () => {
    await lend(1);
    const out = await asUser(
      cashierAuth,
      () => rpc<{ outstanding: number }>("return_bottles", [customer, milk, 1, true]),
      store,
    );
    expect(out.outstanding).toBe(0);
  });

  it("refuses a customer from another shop", async () => {
    const otherAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const otherStore = (
      await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Elsewhere') returning id`, [
        otherAuth,
      ])
    )[0].id;
    const foreign = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Their Customer', '0779999999') returning id`,
        [otherStore],
      )
    )[0].id;

    await expect(
      asUser(owner, () => rpc("return_bottles", [foreign, milk, 1, false]), store),
    ).rejects.toThrow(/unknown customer/i);
  });

  it("refuses a product that is not bottled", async () => {
    await lend(1);
    await expect(
      asUser(owner, () => rpc("return_bottles", [customer, chilli, 1, false]), store),
    ).rejects.toThrow(/unknown product/i);
  });
});

describe("the dashboard list of who has bottles", () => {
  it("lists only customers who still owe a bottle", async () => {
    // Whatever the earlier tests left out, start from a known state: settle everything, lend one.
    const before = await outstanding();
    if (before > 0) {
      await asUser(owner, () => rpc("return_bottles", [customer, milk, before, false]), store);
    }
    expect(await outstanding()).toBe(0);
    await lend(1);
    expect(await outstanding()).toBe(1);

    const other = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Settled Customer', '0778888888') returning id`,
        [store],
      )
    )[0].id;
    expect(other).toBeTruthy(); // never lent anything, so must not appear

    const list = await asUser(
      owner,
      async () => rows<{ name: string; bottles_out: number; phone: string }>(`select * from public.customers_with_bottles(50)`),
      store,
    );
    expect(list.map((x) => x.name)).toEqual(["Milk Regular"]);
    expect(Number(list[0].bottles_out)).toBe(1);
    expect(list[0].phone).toBe("0771234567");
  });

  it("drops a customer from the list once everything is settled", async () => {
    await asUser(owner, () => rpc("return_bottles", [customer, milk, 1, false]), store);

    const list = await asUser(
      owner,
      async () => rows<{ name: string }>(`select * from public.customers_with_bottles(50)`),
      store,
    );
    expect(list).toEqual([]);
  });

  it("does not leak another shop's bottle debtors", async () => {
    const otherAuth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const otherStore = (
      await rows<{ id: string }>(`insert into stores (owner_id, name) values ($1, 'Other Milk Bar') returning id`, [
        otherAuth,
      ])
    )[0].id;
    const theirCustomer = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Their Debtor', '0777777777') returning id`,
        [otherStore],
      )
    )[0].id;
    const theirMilk = (
      await rows<{ id: string }>(
        `insert into products (store_id, name, price_cents, is_returnable_bottle)
         values ($1, 'Their Milk', 25000, true) returning id`,
        [otherStore],
      )
    )[0].id;
    await db.query(
      `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
       values ($1, $2, $3, 'sold', 1, 0)`,
      [otherStore, theirMilk, theirCustomer],
    );

    const list = await asUser(
      owner,
      async () => rows<{ name: string }>(`select * from public.customers_with_bottles(50)`),
      store,
    );
    expect(list.some((x) => x.name === "Their Debtor")).toBe(false);
  });
});
