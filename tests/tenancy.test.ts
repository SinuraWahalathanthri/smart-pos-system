import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0007: store ownership, customers identified by mobile number, and bottles tracked as loans.
 *
 * The bottle rule under test is the shop's own: milk sells for 250 and the 100 bottle deposit is
 * NOT charged on the first purchase. The customer owes a bottle; the 100 is charged only when a
 * later visit still has no bottle. That deferral is what makes "who has our bottles" answerable.
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

/** Create a shop the way onboarding will: owner_id set by the person creating it. */
async function newShop(ownerAuth: string, name: string) {
  const r = await rows<{ id: string }>(
    `insert into stores (owner_id, name) values ($1, $2) returning id`,
    [ownerAuth, name],
  );
  return r[0].id;
}

describe("0007 tenancy", () => {
  it("links a store to the owner who created it", async () => {
    const owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const store = await newShop(owner, "Owned Shop");

    const r = await rows<{ owner_id: string }>(`select owner_id from stores where id = $1`, [store]);
    expect(r[0].owner_id).toBe(owner);
  });

  it("lets an owner create a store but not someone else's", async () => {
    const owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;

    await asUser(owner, async () => {
      await db.query(`insert into stores (owner_id, name) values ($1, 'Mine')`, [owner]);
    });

    await expect(
      asUser(owner, async () => {
        await db.query(`insert into stores (owner_id, name) values (gen_random_uuid(), 'Not Mine')`);
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("shows an owner their own stores before any staff row exists", async () => {
    // Onboarding happens before profiles exist, so the read policy cannot depend on them.
    const owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await newShop(owner, "Alpha");
    await newShop(owner, "Beta");

    const seen = await asUser(owner, async () =>
      (await rows<{ name: string }>(`select name from stores order by name`)).map((x) => x.name),
    );
    expect(seen).toEqual(["Alpha", "Beta"]);
  });

  it("lets an owner list and switch between their stores", async () => {
    const owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const a = await newShop(owner, "Branch A");
    const b = await newShop(owner, "Branch B");

    const listed = await asUser(owner, async () =>
      rows<{ id: string }>(`select id from my_stores()`),
    );
    expect(new Set(listed.map((x) => x.id))).toEqual(new Set([a, b]));

    // The claimed store is only honoured for a store this person may reach.
    const other = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const foreign = await newShop(other, "Someone Else");

    const resolved = await asUser(
      owner,
      async () => (await rows<{ id: string }>(`select public.app_store_id() as id`))[0].id,
      foreign,
    );
    expect(resolved).not.toBe(foreign); // silently falls back, does not leak another shop
  });
});

describe("0007 customers by mobile number", () => {
  let store = "";
  let owner = "";

  beforeAll(async () => {
    owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    store = await newShop(owner, "Customer Shop");
  });

  const addCustomer = (name: string, phone: string) =>
    rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, $2, $3) returning id`,
      [store, name, phone],
    );

  it("requires a mobile number", async () => {
    await expect(
      db.query(`insert into customers (store_id, name) values ($1, 'No Phone')`, [store]),
    ).rejects.toThrow(/null value in column "phone"/i);
  });

  it("refuses two customers on the same number in one shop", async () => {
    await addCustomer("Husband", "0771234567");
    // Same household, deliberately a different number in the shop's model.
    await expect(addCustomer("Wife", "0771234567")).rejects.toThrow(/duplicate key|unique/i);
  });

  it("allows the same number in a different shop", async () => {
    const otherOwner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    const otherStore = await newShop(otherOwner, "Other Shop");
    await db.query(`insert into customers (store_id, name, phone) values ($1, 'Neighbour', '0771234567')`, [
      otherStore,
    ]);
  });

  it("finds a customer by full number or by the last digits", async () => {
    await asUser(owner, async () => {
      const exact = await rows<{ r: { name: string } }>(
        `select public.find_customer_by_phone('0771234567') as r`,
      );
      expect(exact[0].r.name).toBe("Husband");

      const suffix = await rows<{ r: { name: string } }>(
        `select public.find_customer_by_phone('34567') as r`,
      );
      expect(suffix[0].r.name).toBe("Husband");

      const none = await rows<{ r: unknown }>(`select public.find_customer_by_phone('0999999999') as r`);
      expect(none[0].r).toBeNull();
    }, store);
  });

  it("ignores spaces and dashes when matching", async () => {
    await asUser(owner, async () => {
      const r = await rows<{ r: { name: string } }>(
        `select public.find_customer_by_phone('077-123 4567') as r`,
      );
      expect(r[0].r.name).toBe("Husband");
    }, store);
  });

  it("lets a cashier add a customer at the counter", async () => {
    const auth = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    await db.query(
      `insert into profiles (auth_user_id, store_id, full_name, staff_code, role)
       values ($1, $2, 'Till Cashier', 'C1', 'cashier')`,
      [auth, store],
    );

    await asUser(
      auth,
      async () => {
        await db.query(
          `insert into customers (store_id, name, phone) values ($1, 'Walk In', '0779999999')`,
          [store],
        );
      },
      store,
    );
    const r = await rows<{ n: number }>(
      `select count(*)::int as n from customers where phone = '0779999999'`,
    );
    expect(r[0].n).toBe(1);
  });
});

describe("0007 bottles as loans", () => {
  let store = "";
  let owner = "";
  let customer = "";
  let product = "";

  beforeAll(async () => {
    owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
    store = await newShop(owner, "Milk Shop");
    customer = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Milk Regular', '0771111111') returning id`,
        [store],
      )
    )[0].id;
    product = (
      await rows<{ id: string }>(
        `insert into products (store_id, name, price_cents, is_returnable_bottle)
         values ($1, 'Fresh Milk (glass bottle)', 25000, true) returning id`,
        [store],
      )
    )[0].id;
  });

  // Runs as the signed-in owner with this shop selected, the way the dashboard will call it.
  const outstanding = () =>
    asUser(
      owner,
      async () =>
        (await rows<{ n: number }>(`select public.customer_bottles_outstanding($1) as n`, [customer]))[0].n,
      store,
    );

  const ledger = (event: string, qty: number, amount = 0) =>
    db.query(
      `insert into bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
       values ($1, $2, $3, $4, $5, $6)`,
      [store, product, customer, event, qty, amount],
    );

  it("owes nothing before buying", async () => {
    expect(await outstanding()).toBe(0);
  });

  it("owes one bottle after the first purchase, with no deposit charged", async () => {
    // Visit 1: pays 250 only. The bottle is a loan, so no fee is taken up front.
    await ledger("sold", 1);
    expect(await outstanding()).toBe(1);

    const fees = await rows<{ n: number }>(
      `select count(*)::int as n from bottle_ledger
        where customer_id = $1 and event = 'fee_charged'`,
      [customer],
    );
    expect(fees[0].n).toBe(0);
  });

  it("owes nothing when the bottle comes back with the next purchase", async () => {
    await ledger("returned_with_purchase", 1);
    expect(await outstanding()).toBe(0);
  });

  it("owes the 100 fee when a second bottle is taken and not returned", async () => {
    await ledger("sold", 1);
    expect(await outstanding()).toBe(1);

    // No bottle on the next visit: the 100 is charged now, and the loan is settled by that payment.
    await ledger("fee_charged", 1, 10000);
    expect(await outstanding()).toBe(0);

    const charged = await rows<{ amount_cents: number }>(
      `select amount_cents from bottle_ledger
        where customer_id = $1 and event = 'fee_charged'`,
      [customer],
    );
    expect(charged[0].amount_cents).toBe(10000);
  });

  it("refuses to guess when nobody is signed in", async () => {
    // Returning 0 here would tell the dashboard a customer owes nothing while they hold bottles.
    await expect(
      db.query(`select public.customer_bottles_outstanding($1) as n`, [customer]),
    ).rejects.toThrow(/not_authenticated/i);
  });
  it("counts several bottles at once", async () => {
    await ledger("sold", 3);
    expect(await outstanding()).toBe(3);
    await ledger("returned_later", 2);
    expect(await outstanding()).toBe(1);
  });

  it("keeps one customer's bottles out of another's count", async () => {
    const other = (
      await rows<{ id: string }>(
        `insert into customers (store_id, name, phone) values ($1, 'Other Person', '0772222222') returning id`,
        [store],
      )
    )[0].id;
    const n = await asUser(
      owner,
      async () =>
        (await rows<{ n: number }>(`select public.customer_bottles_outstanding($1) as n`, [other]))[0].n,
      store,
    );
    expect(n).toBe(0);
  });

  it("attaches a sale to a customer", async () => {
    const sale = await rows<{ id: string }>(
      `insert into sales (id, store_id, subtotal_cents, total_cents, created_at, customer_id)
       values (gen_random_uuid(), $1, 25000, 25000, now(), $2) returning id`,
      [store, customer],
    );
    expect(sale.length).toBe(1);
  });
});
