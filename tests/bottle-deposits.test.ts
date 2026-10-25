import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 0027: a bottle deposit is money, so it goes through a bill; and a bill that is refunded or
 * cancelled takes its bottles with it.
 *
 * Each case here is a way the bottle book and the cash used to disagree: a waiver invented for
 * every milk sale, a payload wiping a debt, a direct ledger insert skipping the guards, a refund
 * that left the customer owing a bottle for milk the shop took back, and a refund short by the
 * deposit.
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

const FEE = 10000;
const MILK = 25000;

let owner = "";
let cashier = "";
let store = "";
let milk = "";
let chilli = "";

beforeAll(async () => {
  owner = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  store = (
    await rows<{ id: string }>(
      `insert into stores (owner_id, name, bottle_fee_cents) values ($1, 'Dairy Corner', $2) returning id`,
      [owner, FEE],
    )
  )[0].id;
  await db.query(
    `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, 'Owner', '1', 'owner')`,
    [owner, store],
  );
  cashier = (await rows<{ id: string }>(`insert into auth.users default values returning id`))[0].id;
  await db.query(
    `insert into profiles (auth_user_id, store_id, full_name, staff_code, role) values ($1, $2, 'Till', '3', 'cashier')`,
    [cashier, store],
  );
  milk = (
    await rows<{ id: string }>(
      `insert into products (store_id, name, price_cents, is_returnable_bottle) values ($1, 'Fresh Milk', $2, true) returning id`,
      [store, MILK],
    )
  )[0].id;
  chilli = (
    await rows<{ id: string }>(
      `insert into products (store_id, name, price_cents) values ($1, 'Chilli Powder', 45000) returning id`,
      [store],
    )
  )[0].id;
});

let phoneSeq = 0;
const newCustomer = async () =>
  (
    await rows<{ id: string }>(
      `insert into customers (store_id, name, phone) values ($1, $2, $3) returning id`,
      [store, `Customer ${++phoneSeq}`, `07700000${String(phoneSeq).padStart(2, "0")}`],
    )
  )[0].id;

interface Line {
  kind?: "item" | "bottle_fee";
  product_id: string | null;
  qty: number;
  price: number;
}

/** A bill as the till sends it. Money is recomputed by the server, so the totals must add up. */
function bill(customer: string | null, lines: Line[], extra: Record<string, unknown> = {}) {
  const total = lines.reduce((n, l) => n + l.qty * l.price, 0);
  return {
    id: crypto.randomUUID(),
    customer_id: customer,
    subtotal_cents: total,
    discount_cents: 0,
    total_cents: total,
    lines: lines.map((l) => ({
      kind: l.kind ?? "item",
      product_id: l.product_id,
      name: l.kind === "bottle_fee" ? "Bottle deposit" : "Line",
      qty: l.qty,
      unit_price_cents: l.price,
      tax_rate_pct: 0,
      tax_cents: 0,
      line_total_cents: l.qty * l.price,
    })),
    payments: [{ method: "cash", amount_cents: total }],
    ...extra,
  };
}

const sell = (payload: ReturnType<typeof bill>, who = cashier) =>
  asUser(who, () => rpc<{ status: string; sale_id: string }>("complete_sale", [JSON.stringify(payload)]));

const owed = (customer: string) => asUser(owner, () => rpc<number>("customer_bottles_outstanding", [customer]));

const ledgerOf = (sale: string) =>
  rows<{ event: string; qty: number; amount_cents: string; product_id: string | null }>(
    `select event, qty, amount_cents, product_id from bottle_ledger where sale_id = $1 order by created_at, qty desc`,
    [sale],
  );

describe("a current till's sale", () => {
  it("lends the bottle and writes no waiver - on a database that already had 0019", async () => {
    // The 0026 change was first written into 0019. A deployed shop never re-runs 0019, so it kept
    // writing fee_waived plus an audit entry for every bottle a current till sold.
    const amara = await newCustomer();
    const sale = await sell(bill(amara, [{ product_id: milk, qty: 2, price: MILK }]));
    expect(sale.status).toBe("created");

    expect((await ledgerOf(sale.sale_id)).map((l) => l.event)).toEqual(["sold"]);
    expect(await rows(`select 1 from audit_logs where entity_id = $1 and action = 'bottle_fee_waived'`, [sale.sale_id])).toEqual([]);
    expect(await owed(amara)).toBe(2);
  });

  it("caps empties handed back at what the customer actually owes", async () => {
    // bottles_returned used to be taken as-is, so one payload could wipe any customer's debt.
    const kamal = await newCustomer();
    await sell(bill(kamal, [{ product_id: milk, qty: 1, price: MILK }]));
    const sale = await sell(bill(kamal, [{ product_id: chilli, qty: 1, price: 45000 }], { bottles_returned: 50 }));

    const [returned] = (await ledgerOf(sale.sale_id)).filter((l) => l.event === "returned_with_purchase");
    expect(returned.qty).toBe(1);
    expect(await owed(kamal)).toBe(0);
    const [row] = await rows<{ bottles_returned: number }>(`select bottles_returned from sales where id = $1`, [sale.sale_id]);
    expect(row.bottles_returned).toBe(1);
  });

  it("caps a walk-in's empties at the bottles on the same bill", async () => {
    const sale = await sell(bill(null, [{ product_id: milk, qty: 1, price: MILK }], { bottles_returned: 9 }));
    const [returned] = (await ledgerOf(sale.sale_id)).filter((l) => l.event === "returned_with_purchase");
    expect(returned.qty).toBe(1);
  });
});

describe("a deposit is a line on a bill", () => {
  it("puts the money in the sale and settles exactly that bottle", async () => {
    const nimal = await newCustomer();
    await sell(bill(nimal, [{ product_id: milk, qty: 1, price: MILK }]));
    const sale = await sell(bill(nimal, [{ kind: "bottle_fee", product_id: milk, qty: 1, price: FEE }]));

    const [row] = await rows<{ total_cents: string; bottle_fee_cents: string }>(
      `select total_cents, bottle_fee_cents from sales where id = $1`, [sale.sale_id]);
    expect(Number(row.total_cents)).toBe(FEE);
    expect(Number(row.bottle_fee_cents)).toBe(FEE);
    const payments = await rows<{ amount_cents: string }>(`select amount_cents from payments where sale_id = $1`, [sale.sale_id]);
    expect(payments.map((p) => Number(p.amount_cents))).toEqual([FEE]);

    const [fee] = await ledgerOf(sale.sale_id);
    expect(fee).toMatchObject({ event: "fee_charged", qty: 1, product_id: milk });
    expect(Number(fee.amount_cents)).toBe(FEE);
    expect(await owed(nimal)).toBe(0);
  });

  it("records what was actually paid, not today's fee", async () => {
    // An offline till may still carry an older deposit. The ledger must agree with the payment.
    const sunil = await newCustomer();
    await sell(bill(sunil, [{ product_id: milk, qty: 1, price: MILK }]));
    const sale = await sell(bill(sunil, [{ kind: "bottle_fee", product_id: milk, qty: 1, price: 8000 }]));
    expect(Number((await ledgerOf(sale.sale_id))[0].amount_cents)).toBe(8000);
  });

  it("accepts a bill whose goods are fully discounted but whose deposit is paid", async () => {
    // The till caps a discount at the goods so it never eats a deposit (tests/bottles.test.ts).
    // This pins the server half: such a bill is valid and still settles the bottle.
    const ruwan = await newCustomer();
    await sell(bill(ruwan, [{ product_id: milk, qty: 1, price: MILK }]));
    const payload = bill(ruwan, [
      { product_id: chilli, qty: 1, price: 45000 },
      { kind: "bottle_fee", product_id: milk, qty: 1, price: FEE },
    ]);
    payload.discount_cents = 45000;
    payload.total_cents = FEE;
    payload.payments = [{ method: "cash", amount_cents: FEE }];
    const sale = await sell(payload);
    expect(sale.status).toBe("created");
    expect(await owed(ruwan)).toBe(0);
  });
});

describe("nobody writes the ledger directly", () => {
  it("refuses an INSERT from a signed-in till, which would skip every guard", async () => {
    const victim = await newCustomer();
    await expect(
      asUser(cashier, () =>
        db.query(
          `insert into bottle_ledger (store_id, product_id, customer_id, event, qty) values ($1, $2, $3, 'returned_later', 99)`,
          [store, milk, victim],
        ),
      ),
    ).rejects.toThrow(/permission denied/i);
  });
});

describe("a refund or a cancellation takes its bottles with it", () => {
  it("cancels the loan when the milk is refunded, and refunds the goods in full", async () => {
    const dilani = await newCustomer();
    const sale = await sell(bill(dilani, [{ product_id: milk, qty: 2, price: MILK }]));
    expect(await owed(dilani)).toBe(2);

    const out = await asUser(owner, () =>
      rpc<{ amount_cents: number }>("refund_sale", [sale.sale_id, "Spoiled", "cash", false]),
    );
    expect(Number(out.amount_cents)).toBe(2 * MILK);
    expect(await owed(dilani)).toBe(0);
    // Append-only: the original row stays, and a negative one cancels it.
    expect((await ledgerOf(sale.sale_id)).map((l) => [l.event, l.qty])).toEqual([["sold", 2], ["sold", -2]]);
  });

  it("refunds the goods without taking the deposit off (0022 subtracted it)", async () => {
    const mala = await newCustomer();
    await sell(bill(mala, [{ product_id: milk, qty: 1, price: MILK }]));
    const sale = await sell(bill(mala, [
      { product_id: chilli, qty: 1, price: 45000 },
      { kind: "bottle_fee", product_id: milk, qty: 1, price: FEE },
    ]));
    const out = await asUser(owner, () =>
      rpc<{ amount_cents: number }>("refund_sale", [sale.sale_id, "Wrong pack", "cash", true]),
    );
    expect(Number(out.amount_cents)).toBe(45000);
    // The deposit was a separate settlement; the bottle stays paid for.
    expect(await owed(mala)).toBe(0);
  });

  it("never leaves the shop owing a bottle to a customer who already brought it back", async () => {
    const priya = await newCustomer();
    const sale = await sell(bill(priya, [{ product_id: milk, qty: 1, price: MILK }]));
    await asUser(owner, () => rpc("return_bottles", [priya, milk, 1, false]));
    await asUser(owner, () => rpc("refund_sale", [sale.sale_id, "Complaint", "cash", false]));
    expect(await owed(priya)).toBe(0);
  });

  it("reverses loans, empties and deposits when a bill is cancelled", async () => {
    const chamara = await newCustomer();
    await sell(bill(chamara, [{ product_id: milk, qty: 1, price: MILK }]));
    expect(await owed(chamara)).toBe(1);

    // One bill: two more milks out, and a deposit for the earlier bottle.
    const sale = await sell(bill(chamara, [
      { product_id: milk, qty: 2, price: MILK },
      { kind: "bottle_fee", product_id: milk, qty: 1, price: FEE },
    ]));
    expect(await owed(chamara)).toBe(2);

    await asUser(owner, () => rpc("void_sale", [sale.sale_id, "Rang up the wrong customer"]));
    // Back to before the bill: the first bottle is owed again, the two new ones never left.
    expect(await owed(chamara)).toBe(1);
  });
});

describe("shop-wide totals", () => {
  it("count every customer, including those who brought everything back", async () => {
    const t = (await asUser(owner, () => rows<Record<string, number>>(`select * from public.bottle_totals()`)))[0];
    const everyone = await asUser(owner, () =>
      rows<{ sent_out: number; returned: number; charged: number; outstanding: number }>(
        `select * from public.customer_bottle_summary(false, 1000)`,
      ),
    );
    const sum = (k: "sent_out" | "returned" | "charged" | "outstanding") => everyone.reduce((n, r) => n + Number(r[k]), 0);
    expect(Number(t.sent_out)).toBe(sum("sent_out"));
    expect(Number(t.returned)).toBe(sum("returned"));
    expect(Number(t.charged)).toBe(sum("charged"));
    expect(Number(t.outstanding)).toBe(sum("outstanding"));
    expect(Number(t.customers_owing)).toBe(everyone.filter((r) => Number(r.outstanding) > 0).length);

    // The default list leaves out settled customers - which is why the screen must not add it up.
    const owingOnly = await asUser(owner, () => rows(`select * from public.customer_bottle_summary(true, 1000)`));
    expect(owingOnly.length).toBeLessThan(everyone.length);
  });

  it("report walk-in bottles apart, because no one can be chased for them", async () => {
    const before = (await asUser(owner, () => rows<{ walk_in_out: number }>(`select * from public.bottle_totals()`)))[0];
    await sell(bill(null, [{ product_id: milk, qty: 3, price: MILK }]));
    const after = (await asUser(owner, () => rows<{ walk_in_out: number }>(`select * from public.bottle_totals()`)))[0];
    expect(Number(after.walk_in_out) - Number(before.walk_in_out)).toBe(3);
  });

  it("date a customer's last bottle by the sale, not by a later refund", async () => {
    const ishara = await newCustomer();
    await sell(bill(ishara, [{ product_id: milk, qty: 1, price: MILK }]));
    const back = await sell(bill(ishara, [{ product_id: milk, qty: 1, price: MILK }]));
    const [{ created_at: soldAt }] = await rows<{ created_at: string }>(
      `select created_at from bottle_ledger where sale_id = $1 and qty > 0`, [back.sale_id]);
    await asUser(owner, () => rpc("refund_sale", [back.sale_id, "Spoiled", "cash", false]));

    const row = (await asUser(owner, () =>
      rows<{ customer_id: string; last_out_at: string; outstanding: number }>(`select * from public.customer_bottle_summary(false, 1000)`),
    )).find((r) => r.customer_id === ishara)!;
    expect(row.outstanding).toBe(1);
    expect(new Date(row.last_out_at).getTime()).toBeLessThanOrEqual(new Date(soldAt).getTime());
  });
});
