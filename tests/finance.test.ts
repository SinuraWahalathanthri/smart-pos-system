import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The finance module against a real Postgres engine.
 *
 * These are accounting tests, not UI tests: they assert the numbers a shopkeeper would act on.
 * Each scenario exists because getting it wrong is a known way to double-count or to mislead:
 *
 *   - a bill with a discount, so revenue is not the sum of the price tags
 *   - a refund, which must reverse in its own period and not rewrite last month
 *   - a cost change after a sale, which must NOT alter the COGS of a sale already made
 *   - an unpaid supplier bill, which is a payable and must not appear as an expense
 *   - stock bought and left unsold, which must not reduce profit
 *   - a production run, where raw material leaves, finished goods arrive, and a cost per unit is derived
 *
 * Where a number comes from a fixture, the arithmetic is written out in the assertion so a reader can
 * check it without running anything.
 */

const ROOT = join(__dirname, "..", "supabase");

const SUPABASE_STUBS = `
  create schema if not exists extensions;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema if not exists auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
`;

let db: PGlite;
const ids: Record<string, string> = {};

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

async function asUser<T>(authId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  }
}

/** A function returning jsonb: one value. */
const rpc = (name: string, args: unknown[]) =>
  q<{ r: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then((r) => r[0].r);

/** A function returning TABLE: one row per result. */
const rpcRows = <T = Record<string, unknown>>(name: string, args: unknown[]): Promise<T[]> =>
  q<T>(`select * from public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")})`, args);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  for (const f of readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  }
  await db.exec(readFileSync(join(ROOT, "seed.sql"), "utf8"));

  for (const [role, code] of [["owner", "1"], ["supervisor", "2"], ["cashier", "3"]] as const) {
    const [u] = await q<{ id: string }>("insert into auth.users default values returning id");
    ids[role] = u.id;
    await q("update profiles set auth_user_id = $1 where staff_code = $2", [u.id, code]);
  }
  const [store] = await q<{ id: string }>("select id from stores");
  ids.store = store.id;
  for (const p of await q<{ id: string; name: string }>("select id, name from products")) ids[p.name] = p.id;
  const [curry250] = await q<{ id: string }>(
    `select ps.id from pack_sizes ps join products p on p.id = ps.product_id
      where p.name = 'Curry Powder' and ps.weight_g = 250`,
  );
  ids.curry250 = curry250.id;
  const [supplier] = await q<{ id: string }>(
    "insert into suppliers (store_id, name) values ($1, 'Kandy Spice Traders') returning id",
    [store.id],
  );
  ids.supplier = supplier.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

/**
 * Products created by the finance tests themselves, so every arithmetic assertion starts from a
 * known cost instead of from whatever the demo seed happened to bring in.
 */
async function makeProduct(name: string, price: number, taxPct = 0) {
  const [row] = await q<{ id: string }>(
    `insert into products (store_id, name, kind, sale_mode, price_cents, tax_rate_pct)
     values ($1, $2, 'trade', 'unit', $3, $4) returning id`,
    [ids.store, name, price, taxPct],
  );
  return row.id;
}

/** A sale through the real RPC, the same path the till uses. */
async function sell(opts: {
  lines: { product_id?: string; pack_size_id?: string; name: string; qty: number; price: number; tax?: number }[];
  discount?: number;
  method?: string;
  at?: string;
  customer?: string;
}) {
  const lines = opts.lines.map((l) => ({
    product_id: l.product_id ?? null,
    pack_size_id: l.pack_size_id ?? null,
    kind: "item",
    name: l.name,
    qty: l.qty,
    unit_price_cents: l.price,
    tax_rate_pct: l.tax ?? 0,
    tax_cents: 0,
    line_total_cents: Math.round(l.price * l.qty),
  }));
  const subtotal = lines.reduce((n, l) => n + l.line_total_cents, 0);
  const total = subtotal - (opts.discount ?? 0);
  const payload = {
    id: randomUUID(),
    created_at: opts.at ?? new Date().toISOString(),
    customer_id: opts.customer ?? null,
    subtotal_cents: subtotal,
    discount_cents: opts.discount ?? 0,
    total_cents: total,
    tax_included_cents: 0,
    bottles_returned: 0,
    bottle_fee_cents: 0,
    lines,
    voided: [],
    payments: [{ method: opts.method ?? "cash", amount_cents: total }],
  };
  const result = await rpc("complete_sale", [payload]);
  return { id: payload.id, total, ...(result as object) };
}

/** Receive stock the way the Products screen does, which is what establishes a cost. */
async function receive(product: string, qty: number, unitCost: number, packSize?: string) {
  return rpc("receive_stock", [product, packSize ?? null, qty, unitCost, "Kandy Spice Traders", "Test delivery"]);
}

describe("cost capture", () => {
  it("stores the cost of stock coming in, and freezes it on the sale line", async () => {
    const id = await makeProduct("Test Biscuit", 12000);
    ids.biscuit = id;

    await asUser(ids.owner, () => receive(id, 100, 8000));
    const [cost] = await q<{ c: string }>("select cost_cents c from product_costs where product_id = $1", [id]);
    expect(Number(cost.c)).toBe(8000);

    const sale = await asUser(ids.owner, () =>
      sell({ lines: [{ product_id: id, name: "Test Biscuit", qty: 10, price: 12000, tax: 18 }] }),
    );

    const [line] = await q<{ cost_cents: string; cogs_cents: string }>(
      "select cost_cents, cogs_cents from sale_items where sale_id = $1",
      [sale.id],
    );
    expect(Number(line.cost_cents)).toBe(8000);
    // 10 x 80.00
    expect(Number(line.cogs_cents)).toBe(80000);
  });

  it("weights the average when more stock arrives at a different price", async () => {
    const id = ids.biscuit;
    // on hand: 100 - 10 = 90 at 80.00. Add 100 at 120.00.
    // (90 x 80.00 + 100 x 120.00) / 190 = 19200 / 190 = 101.05
    await asUser(ids.owner, () => receive(id, 100, 12000));

    const [cost] = await q<{ c: string }>("select cost_cents c from product_costs where product_id = $1", [id]);
    expect(Number(cost.c)).toBe(10105);

    const history = await q<{ n: number }>(
      "select count(*)::int n from product_cost_history where product_id = $1",
      [id],
    );
    expect(history[0].n).toBeGreaterThanOrEqual(2);
  });

  it("never rewrites the COGS of a sale already made when the cost later changes", async () => {
    const id = await makeProduct("Test Frozen", 30000);
    await asUser(ids.owner, () => receive(id, 10, 20000));

    const sale = await asUser(ids.owner, () =>
      sell({
        at: "2026-01-15T10:00:00.000Z",
        lines: [{ product_id: id, name: "Test Frozen", qty: 5, price: 30000 }],
      }),
    );
    const [before] = await q<{ cogs_cents: string }>("select cogs_cents from sale_items where sale_id = $1", [sale.id]);
    // 5 x 200.00
    expect(Number(before.cogs_cents)).toBe(100000);

    // the shop later pays much more for the same goods: 5 left at 200.00, plus 100 at 400.00
    await asUser(ids.owner, () => receive(id, 100, 40000));

    const [after] = await q<{ cogs_cents: string }>("select cogs_cents from sale_items where sale_id = $1", [sale.id]);
    expect(Number(after.cogs_cents)).toBe(100000);

    // (5 x 200 + 100 x 400) / 105 = 39047.6
    const [now] = await q<{ c: string }>("select cost_cents c from product_costs where product_id = $1", [id]);
    expect(Number(now.c)).toBe(39048);
  });

  it("leaves cost unknown, rather than zero, for a product nobody has priced", async () => {
    const id = await makeProduct("Never Costed", 5000);
    await q("insert into stock_movements (store_id, product_id, qty_change, type) values ($1, $2, 10, 'opening')", [
      ids.store,
      id,
    ]);
    const sale = await asUser(ids.owner, () =>
      sell({
        at: "2026-11-05T10:00:00.000Z",
        lines: [{ product_id: id, name: "Never Costed", qty: 1, price: 5000 }],
      }),
    );
    const [line] = await q<{ cost_cents: string | null; cogs_cents: string }>(
      "select cost_cents, cogs_cents from sale_items where sale_id = $1",
      [sale.id],
    );
    expect(line.cost_cents).toBeNull();
    expect(Number(line.cogs_cents)).toBe(0);

    // and the summary says so, instead of quoting a profit it cannot know
    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-11-01", "2026-11-30"]))) as Record<
      string,
      unknown
    >;
    expect(Number(summary.unknown_cost_lines)).toBe(1);
    expect(summary.is_estimate).toBe(true);
  });
});

describe("sales, discounts and profit", () => {
  it("reports revenue net of a bill discount, and COGS at cost", async () => {
    const id = await makeProduct("Margin Item", 10000);
    await asUser(ids.owner, () => receive(id, 100, 6000));
    ids.margin = id;

    await asUser(ids.owner, () =>
      sell({
        at: "2026-02-10T09:00:00.000Z",
        discount: 10000,
        lines: [{ product_id: id, name: "Margin Item", qty: 10, price: 10000 }],
      }),
    );

    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-02-01", "2026-02-28"]))) as Record<
      string,
      number
    >;
    expect(summary.gross_sales_cents).toBe(100000);
    expect(summary.discounts_cents).toBe(10000);
    expect(summary.net_sales_cents).toBe(90000);
    // 10 x 60.00
    expect(summary.cogs_cents).toBe(60000);
    expect(summary.gross_profit_cents).toBe(30000);
    expect(summary.bill_count).toBe(1);
    // the cash came in at the till: revenue and collection agree here, but are reported apart
    expect(summary.collected_cents).toBe(90000);
  });

  it("allocates the discount to the line, so per-product revenue is honest", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{
        product_id: string;
        revenue_cents: number;
        cogs_cents: number;
        gross_profit_cents: number;
        margin_pct: number | string;
        markup_pct: number | string;
        gross_profit_per_unit_cents: number;
      }>("product_profitability", ["2026-02-01", "2026-02-28"]),
    );

    const row = rows.find((r) => r.product_id === ids.margin);
    expect(row).toBeDefined();
    // tagged 100.00, less the 10.00 bill discount
    expect(Number(row!.revenue_cents)).toBe(90000);
    expect(Number(row!.cogs_cents)).toBe(60000);
    expect(Number(row!.gross_profit_cents)).toBe(30000);
    // margin = 30000 / 90000 x 100 = 33.3 ; markup = 30000 / 60000 x 100 = 50.0
    expect(Number(row!.margin_pct)).toBeCloseTo(33.3, 1);
    expect(Number(row!.markup_pct)).toBeCloseTo(50, 1);
    // 9.00 per unit net
    expect(Number(row!.gross_profit_per_unit_cents)).toBe(3000);
  });

  it("reports a loss as negative, not as zero", async () => {
    const id = await makeProduct("Loss Leader", 10000);
    await asUser(ids.owner, () => receive(id, 100, 20000)); // costs more than it sells for

    await asUser(ids.owner, () =>
      sell({ at: "2026-02-20T09:00:00.000Z", lines: [{ product_id: id, name: "Loss Leader", qty: 5, price: 10000 }] }),
    );

    const rows = await asUser(ids.owner, () =>
      rpcRows<{ product_id: string; gross_profit_cents: number; margin_pct: number | string; is_below_cost: boolean }>(
        "product_profitability",
        ["2026-02-01", "2026-02-28"],
      ),
    );
    const row = rows.find((r) => r.product_id === id);
    expect(Number(row!.gross_profit_cents)).toBe(50000 - 100000);
    expect(Number(row!.margin_pct)).toBeCloseTo(-100, 1);
    expect(row!.is_below_cost).toBe(true);
  });
});

describe("purchases are payables, not expenses", () => {
  it("shows an unpaid supplier bill as money owed, and leaves profit alone", async () => {
    await asUser(ids.owner, () =>
      rpc("save_purchase", [
        {
          supplier_id: ids.supplier,
          supplier_invoice_no: "INV-9001",
          received_on: "2026-03-05",
          total_cents: 500000,
          subtotal_cents: 500000,
          paid_cents: 0,
        },
      ]),
    );

    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-03-01", "2026-03-31"]))) as Record<
      string,
      number
    >;
    // the bill is visible as a purchase and as a payable...
    expect(summary.purchases_cents).toBe(500000);
    expect(summary.payables_cents).toBe(500000);
    // ...but no goods were sold, so it has not touched profit
    expect(summary.operating_expenses_cents).toBe(0);
    expect(summary.net_profit_cents).toBe(0);
  });

  it("reduces the payable when the supplier is paid, without changing profit", async () => {
    const [purchase] = await q<{ id: string }>("select id from goods_receipts where supplier_invoice_no = 'INV-9001'");
    await asUser(ids.owner, () => rpc("pay_purchase", [purchase.id, 200000, "cash", "2026-03-20", null]));

    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-03-01", "2026-03-31"]))) as Record<
      string,
      number
    >;
    expect(summary.payables_cents).toBe(300000);
    expect(summary.net_profit_cents).toBe(0);
  });

  it("refuses to overpay a supplier bill", async () => {
    const [purchase] = await q<{ id: string }>("select id from goods_receipts where supplier_invoice_no = 'INV-9001'");
    await expect(
      asUser(ids.owner, () => rpc("pay_purchase", [purchase.id, 999999, "cash", "2026-03-21", null])),
    ).rejects.toThrow(/more than the .* still owed/);
  });
});

describe("operating expenses", () => {
  it("counts an expense in the period it belongs to, paid or not", async () => {
    await asUser(ids.owner, () =>
      rpc("save_expense", [
        {
          category: "Rent",
          description: "April shop rent",
          amount_cents: 4000000,
          expense_on: "2026-04-01",
          payment_method: "cash",
          paid_cents: 0,
        },
      ]),
    );

    let summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-04-01", "2026-04-30"]))) as Record<
      string,
      number
    >;
    expect(summary.operating_expenses_cents).toBe(4000000);
    expect(summary.net_profit_cents).toBe(-4000000);
    expect(summary.unpaid_expenses_cents).toBe(4000000);

    const [expense] = await q<{ id: string }>("select id from expenses where description = 'April shop rent'");
    ids.rent = expense.id;
    await asUser(ids.owner, () => rpc("pay_expense", [expense.id, 4000000, "cash", "2026-04-02", null]));

    summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-04-01", "2026-04-30"]))) as Record<
      string,
      number
    >;
    // paying it settles the debt; it does not double the expense
    expect(summary.operating_expenses_cents).toBe(4000000);
    expect(summary.unpaid_expenses_cents).toBe(0);
  });

  it("keeps capital expenditure out of operating profit", async () => {
    await asUser(ids.owner, () =>
      rpc("save_expense", [
        {
          kind: "capital",
          category: "Equipment",
          description: "Chest freezer",
          amount_cents: 12000000,
          expense_on: "2026-04-10",
          paid_cents: 12000000,
          payment_method: "cash",
        },
      ]),
    );

    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-04-01", "2026-04-30"]))) as Record<
      string,
      number
    >;
    expect(summary.capital_expenses_cents).toBe(12000000);
    // still just the rent: buying a freezer did not make April look loss-making
    expect(summary.operating_expenses_cents).toBe(4000000);
  });

  it("includes tax-exclusive amounts, so VAT is not counted as an expense", async () => {
    await asUser(ids.owner, () =>
      rpc("save_expense", [
        {
          category: "Electricity",
          description: "May electricity",
          amount_cents: 118000,
          tax_cents: 18000,
          expense_on: "2026-05-05",
          paid_cents: 118000,
          payment_method: "bank",
        },
      ]),
    );
    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-05-01", "2026-05-31"]))) as Record<
      string,
      number
    >;
    expect(summary.operating_expenses_cents).toBe(100000);
    expect(summary.input_vat_expenses_cents).toBe(18000);
  });
});

describe("refunds", () => {
  it("reverses revenue and COGS in the refund's period, without rewriting the sale's month", async () => {
    const id = await makeProduct("Refundable", 20000);
    await asUser(ids.owner, () => receive(id, 50, 12000));

    const sold = await asUser(ids.owner, () =>
      sell({ at: "2026-06-10T10:00:00.000Z", lines: [{ product_id: id, name: "Refundable", qty: 10, price: 20000 }] }),
    );

    const juneBefore = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-06-01", "2026-06-30"]))) as Record<
      string,
      number
    >;
    expect(juneBefore.net_sales_cents).toBe(200000);
    expect(juneBefore.cogs_cents).toBe(120000);

    await asUser(ids.owner, () =>
      q("select public.refund_sale($1, $2, $3, $4)", [sold.id, "customer changed mind", "cash", true]),
    );

    // The refund happened in July, so that is the month it belongs to. Moving the document's date is
    // how this test states the month explicitly; refund_sale stamps it with now() in real use.
    await q("update refunds set created_at = '2026-07-03T09:00:00.000Z' where sale_id = $1", [sold.id]);

    // June still holds the sale at full value: a refund must never rewrite a closed month.
    const juneAfter = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-06-01", "2026-06-30"]))) as Record<
      string,
      number
    >;
    expect(juneAfter.net_sales_cents).toBe(200000);
    expect(juneAfter.refunds_cents).toBe(0);
    expect(juneAfter.cogs_cents).toBe(120000);

    // July carries the reversal: a negative sale, and COGS given back at the original cost.
    const july = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-07-01", "2026-07-31"]))) as Record<
      string,
      number
    >;
    expect(july.refunds_cents).toBe(200000);
    expect(july.net_sales_cents).toBe(-200000);
    expect(july.cogs_cents).toBe(-120000);

    const [stock] = await q<{ s: string }>("select stock_on_hand s from products where id = $1", [id]);
    // 50 received, 10 sold, 10 returned
    expect(Number(stock.s)).toBe(50);
  });

  it("refuses a second refund of the same bill", async () => {
    const [refunded] = await q<{ sale_id: string }>("select sale_id from refunds limit 1");
    await expect(
      asUser(ids.owner, () => q("select public.refund_sale($1, $2, $3, $4)", [refunded.sale_id, "again", "cash", true])),
    ).rejects.toThrow(/already .*refunded/);
  });

  it("cancels a bill completely, so it stops counting anywhere", async () => {
    const before = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-09-01", "2026-09-30"]))) as Record<
      string,
      number
    >;
    expect(before.net_sales_cents).toBe(0);

    const sold = await asUser(ids.owner, () =>
      sell({ at: "2026-09-05T10:00:00.000Z", lines: [{ product_id: ids.margin, name: "Margin Item", qty: 2, price: 10000 }] }),
    );
    const mid = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-09-01", "2026-09-30"]))) as Record<
      string,
      number
    >;
    expect(mid.net_sales_cents).toBe(20000);

    await asUser(ids.owner, () => rpc("void_sale", [sold.id, "entered twice by mistake"]));

    const after = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-09-01", "2026-09-30"]))) as Record<
      string,
      number
    >;
    // a cancellation is a corrected error, not a business event: it removes the bill entirely
    expect(after.net_sales_cents).toBe(0);
    expect(after.cogs_cents).toBe(0);
    expect(after.cancelled_bills).toBe(1);

    const [row] = await q<{ status: string }>("select status from sales where id = $1", [sold.id]);
    expect(row.status).toBe("cancelled");
  });
});

describe("production costing", () => {
  it("consumes raw material, adds finished goods, and derives a cost per unit", async () => {
    const raw = await makeProduct("Test Raw Turmeric", 0);
    const made = await makeProduct("Test Curry Powder", 50000, 0);

    // a packet size to produce into
    const [pack] = await q<{ id: string }>(
      `insert into pack_sizes (store_id, product_id, label, weight_g, price_cents)
       values ($1, $2, '250 g', 250, 50000) returning id`,
      [ids.store, made],
    );
    ids.testPack = pack.id;

    await asUser(ids.owner, () => receive(raw, 50, 2000));

    const result = (await asUser(ids.owner, () =>
      rpc("save_production_run", [
        {
          product_id: made,
          run_no: "PR-TEST-1",
          status: "closed",
          started_on: "2026-07-01",
          outputs: [{ pack_size_id: pack.id, qty_units: 100 }],
          inputs: [{ product_id: raw, qty: 5, stage: "raw" }],
          cost_entries: [
            { category: "labour", description: "Two workers, half a day", amount_cents: 300000 },
            { category: "utilities", description: "Gas and electricity", amount_cents: 50000 },
          ],
        },
      ]),
    )) as Record<string, number>;

    // material 5 x 20.00 = 100.00, plus 3000.00 labour and 500.00 utilities = 3600.00 for 100 units
    expect(result.material_cost_cents).toBe(10000);
    expect(result.extra_cost_cents).toBe(350000);
    expect(result.total_cost_cents).toBe(360000);
    expect(result.units).toBe(100);
    expect(result.cost_per_unit_cents).toBe(3600);

    // raw material left the shelf, finished packets arrived
    const [rawRow] = await q<{ s: string }>("select stock_on_hand s from products where id = $1", [raw]);
    expect(Number(rawRow.s)).toBe(45);
    const [packRow] = await q<{ s: string }>("select packets_on_hand s from pack_sizes where id = $1", [pack.id]);
    expect(Number(packRow.s)).toBe(100);

    const [cost] = await q<{ c: string }>("select cost_cents c from pack_sizes where id = $1", [pack.id]);
    expect(Number(cost.c)).toBe(3600);
  });

  it("refuses to post the same run twice", async () => {
    const [run] = await q<{ id: string; product_id: string }>(
      "select id, product_id from production_runs where run_no = 'PR-TEST-1'",
    );
    await expect(
      asUser(ids.owner, () =>
        rpc("save_production_run", [
          { id: run.id, product_id: run.product_id, outputs: [{ pack_size_id: ids.testPack, qty_units: 10 }] },
        ]),
      ),
    ).rejects.toThrow(/already been posted/);
  });

  it("rolls the whole batch back when an input is invalid", async () => {
    const [made] = await q<{ id: string }>("select product_id id from production_runs where run_no = 'PR-TEST-1'");
    const before = await q<{ n: number }>("select count(*)::int n from production_runs");
    const movesBefore = await q<{ n: number }>("select count(*)::int n from stock_movements");

    await expect(
      asUser(ids.owner, () =>
        rpc("save_production_run", [
          {
            product_id: made.id,
            run_no: "PR-BAD",
            outputs: [{ pack_size_id: ids.testPack, qty_units: 10 }],
            inputs: [{ product_id: ids["Test Raw Turmeric"], qty: 0 }],
          },
        ]),
      ),
    ).rejects.toThrow(/positive/);

    const after = await q<{ n: number }>("select count(*)::int n from production_runs");
    const movesAfter = await q<{ n: number }>("select count(*)::int n from stock_movements");
    // no half-posted run, and no stock moved out of the shelf for a batch that failed
    expect(after[0].n).toBe(before[0].n);
    expect(movesAfter[0].n).toBe(movesBefore[0].n);
  });
});

describe("audit trail and reversals", () => {
  it("records who created an expense", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{ action: string; actor: string }>("audit_trail", [null, null, "expense_created", null, 10]),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].actor).toBe("Shop Owner");
  });

  it("cannot delete an expense, so voiding is the only way out", async () => {
    await expect(q("delete from expenses where id = $1", [ids.rent])).rejects.toThrow(/Archive or void instead/);

    await asUser(ids.owner, () => rpc("void_expense", [ids.rent, "entered against the wrong month"]));
    const [row] = await q<{ status: string; void_reason: string }>(
      "select status, void_reason from expenses where id = $1",
      [ids.rent],
    );
    expect(row.status).toBe("void");
    expect(row.void_reason).toMatch(/wrong month/);

    // and it no longer counts
    const summary = (await asUser(ids.owner, () => rpc("finance_summary", ["2026-04-01", "2026-04-30"]))) as Record<
      string,
      number
    >;
    expect(summary.expense_count).toBe(1);
  });

  it("refuses to change the amount of an expense that has money against it", async () => {
    const [expense] = await q<{ id: string }>("select id from expenses where description = 'Chest freezer'");
    await expect(
      asUser(ids.owner, () =>
        rpc("save_expense", [{ id: expense.id, category: "Equipment", description: "Chest freezer", amount_cents: 999 }]),
      ),
    ).rejects.toThrow(/cannot be changed/);
  });

  it("reverses a paid expense without deleting its history", async () => {
    const [expense] = await q<{ id: string }>("select id from expenses where description = 'May electricity'");
    const paymentsBefore = await q<{ n: number }>(
      "select count(*)::int n from expense_payments where expense_id = $1",
      [expense.id],
    );
    expect(paymentsBefore[0].n).toBe(1);

    await asUser(ids.owner, () => rpc("void_expense", [expense.id, "meter read was wrong"]));

    const paymentsAfter = await q<{ n: number }>(
      "select count(*)::int n from expense_payments where expense_id = $1",
      [expense.id],
    );
    // the payment record survives: money did leave the bank, and that must stay auditable
    expect(paymentsAfter[0].n).toBe(1);
  });
});

describe("permissions", () => {
  it("refuses finance reports to a cashier", async () => {
    await expect(asUser(ids.cashier, () => rpc("finance_summary", ["2026-01-01", "2026-12-31"]))).rejects.toThrow(
      /owner and supervisors/,
    );
  });

  it("refuses expense entry to a cashier", async () => {
    await expect(
      asUser(ids.cashier, () => rpc("save_expense", [{ category: "Rent", description: "nope", amount_cents: 100 }])),
    ).rejects.toThrow(/owner and supervisors/);
  });

  it("refuses to read the audit trail as a supervisor", async () => {
    await expect(
      asUser(ids.supervisor, () => rpcRows("audit_trail", [null, null, null, null, 5])),
    ).rejects.toThrow(/audit trail is for the shop owner/);
  });

  it("hides cost from a supervisor, the same rule 0010 already applies", async () => {
    const rows = await asUser(ids.supervisor, () =>
      rpcRows<{ cogs_cents: number | null; margin_pct: number | null; revenue_cents: number }>("product_profitability", [
        "2026-02-01",
        "2026-02-28",
      ]),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].cogs_cents).toBeNull();
    expect(rows[0].margin_pct).toBeNull();
    // revenue is not secret; cost is
    expect(rows[0].revenue_cents).not.toBeNull();
  });

  it("refuses a cost change to a supervisor", async () => {
    await expect(
      asUser(ids.supervisor, () => rpc("set_product_cost", [ids.margin, null, 5000, "test"])),
    ).rejects.toThrow(/only the shop owner/);
  });
});

describe("tax records", () => {
  it("reports a difference, not a liability, and warns about what is missing", async () => {
    const t = (await asUser(ids.owner, () => rpc("tax_summary", ["2026-01-01", "2026-12-31"]))) as {
      vat_difference_cents: number;
      warnings: string[];
      disclaimer: string;
      shop: { vat_rate_pct: number };
    };
    expect(typeof t.vat_difference_cents).toBe("number");
    expect(t.disclaimer).toMatch(/not a tax return/i);
    // nothing is hardcoded: the seeded shop has no rate, so the warning must be there
    expect(Number(t.shop.vat_rate_pct)).toBe(0);
    expect(t.warnings.join(" ")).toMatch(/No shop VAT rate is set/);
  });

  it("takes the rate from shop settings rather than a constant", async () => {
    await asUser(ids.owner, () =>
      rpc("save_finance_settings", [true, 18, "123456789", "VAT-001", "moving_average", 4]),
    );
    const t = (await asUser(ids.owner, () => rpc("tax_summary", ["2026-01-01", "2026-12-31"]))) as {
      shop: { vat_rate_pct: number; tin: string };
      warnings: string[];
    };
    expect(Number(t.shop.vat_rate_pct)).toBe(18);
    expect(t.shop.tin).toBe("123456789");
    // the missing-rate warning is gone now that a rate exists
    expect(t.warnings.join(" ")).not.toMatch(/No shop VAT rate is set/);
  });

  it("separates output tax on sales from input tax on purchases and expenses", async () => {
    // A fresh expense in its own month, so this test does not depend on what earlier tests voided.
    await asUser(ids.owner, () =>
      rpc("save_expense", [
        {
          category: "Electricity",
          description: "October electricity",
          amount_cents: 118000,
          tax_cents: 18000,
          expense_on: "2026-10-05",
          paid_cents: 118000,
          payment_method: "cash",
        },
      ]),
    );
    const t = (await asUser(ids.owner, () => rpc("tax_summary", ["2026-10-01", "2026-10-31"]))) as Record<
      string,
      number
    >;
    expect(t.input_vat_expenses_cents).toBe(18000);
    expect(t.output_vat_cents).toBe(0);
    expect(t.vat_difference_cents).toBe(-18000);
    expect(t.input_vat_total_cents).toBe(18000);
  });
});

describe("review alerts", () => {
  it("flags a below-cost product without accusing anyone", async () => {
    const alerts = await asUser(ids.owner, () =>
      rpcRows<{ code: string; severity: string; detail: string; headline: string }>("finance_alerts", [
        "2026-02-01",
        "2026-02-28",
      ]),
    );
    expect(alerts.some((a) => a.code === "below_cost")).toBe(true);
    // every alert is a review prompt, never a fraud claim
    expect(alerts.every((a) => a.severity === "review")).toBe(true);
    expect(alerts.every((a) => !/fraud|stole|theft|guilty/i.test(`${a.headline} ${a.detail}`))).toBe(true);
  });

  it("spots an expense entered twice", async () => {
    await asUser(ids.owner, async () => {
      await rpc("save_expense", [
        {
          category: "Fuel",
          description: "Van diesel",
          amount_cents: 150000,
          expense_on: "2026-08-03",
          payee: "Ceypetco",
          paid_cents: 150000,
          payment_method: "cash",
        },
      ]);
      await rpc("save_expense", [
        {
          category: "Fuel",
          description: "Van diesel",
          amount_cents: 150000,
          expense_on: "2026-08-04",
          payee: "Ceypetco",
          paid_cents: 150000,
          payment_method: "cash",
        },
      ]);
    });
    const alerts = await asUser(ids.owner, () =>
      rpcRows<{ code: string }>("finance_alerts", ["2026-08-01", "2026-08-31"]),
    );
    expect(alerts.some((a) => a.code === "possible_duplicate_expense")).toBe(true);
  });

  it("flags an expense that was backdated by more than a month", async () => {
    await asUser(ids.owner, () =>
      rpc("save_expense", [
        {
          category: "Repairs",
          description: "Old repair bill",
          amount_cents: 50000,
          expense_on: "2026-07-01",
          paid_cents: 50000,
          payment_method: "cash",
        },
      ]),
    );
    const alerts = await asUser(ids.owner, () =>
      rpcRows<{ code: string }>("finance_alerts", ["2026-07-01", "2026-07-31"]),
    );
    expect(alerts.some((a) => a.code === "backdated_expense")).toBe(true);
  });
});

describe("expense reporting", () => {
  it("breaks down by category with shares that add to 100", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{ category: string; total_cents: number; share_pct: number }>("expense_breakdown", [
        "2026-08-01",
        "2026-08-31",
      ]),
    );
    const total = rows.reduce((n, r) => n + Number(r.total_cents), 0);
    const shares = rows.reduce((n, r) => n + Number(r.share_pct), 0);
    expect(total).toBe(300000);
    expect(Math.round(shares)).toBe(100);
  });

  it("compares a period with the one before it, of the same length", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{ category: string; current_cents: number; previous_cents: number; change_cents: number; change_pct: number }>(
        "expense_category_change",
        ["2026-08-01", "2026-08-31"],
      ),
    );
    const fuel = rows.find((r) => r.category === "Fuel");
    expect(fuel).toBeDefined();
    expect(Number(fuel!.current_cents)).toBe(300000);
    expect(Number(fuel!.previous_cents)).toBe(0);
    // no previous spend means no percentage: undefined, not infinity
    expect(fuel!.change_pct).toBeNull();
  });

  it("groups the trend by the granularity asked for", async () => {
    const daily = await asUser(ids.owner, () =>
      rpcRows<{ bucket: string; operating_cents: number }>("expense_trend", ["2026-08-01", "2026-08-31", "day"]),
    );
    expect(daily.length).toBe(31);
    expect(daily.reduce((n, r) => n + Number(r.operating_cents), 0)).toBe(300000);
  });
});

describe("exports", () => {
  it("exports the sales behind a period with their cost and profit", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{ receipt_no: number; total_cents: number; cogs_cents: number; gross_profit_cents: number }>(
        "sales_export",
        ["2026-02-01", "2026-02-28"],
      ),
    );
    expect(rows.length).toBe(2);
    const margin = rows.find((r) => Number(r.total_cents) === 90000);
    expect(margin).toBeDefined();
    expect(Number(margin!.cogs_cents)).toBe(60000);
    expect(Number(margin!.gross_profit_cents)).toBe(30000);
  });

  it("exports purchases with their outstanding balance", async () => {
    const rows = await asUser(ids.owner, () =>
      rpcRows<{ supplier: string; total_cents: number; outstanding_cents: number }>("purchases_export", [
        "2026-03-01",
        "2026-03-31",
      ]),
    );
    expect(rows.length).toBe(1);
    expect(rows[0].supplier).toBe("Kandy Spice Traders");
    expect(Number(rows[0].outstanding_cents)).toBe(300000);
  });
});

describe("expense categories", () => {
  /**
   * The category list is what the expense form offers as suggestions. Seeding it on first use meant
   * it was empty the first time a shopkeeper opened the form — exactly when a suggestion is useful.
   */
  it("gives a brand new shop its default categories", async () => {
    const [account] = await q<{ id: string }>("insert into auth.users default values returning id");
    const [store] = await q<{ id: string }>(
      "insert into stores (name, owner_id) values ('Second Shop', $1) returning id",
      [account.id],
    );
    const rows = await q<{ name: string; is_operating: boolean }>(
      "select name, is_operating from expense_categories where store_id = $1 order by sort_order",
      [store.id],
    );
    expect(rows.length).toBe(20);
    expect(rows[0].name).toBe("Rent");
    // Equipment and a vehicle are capital, so they must not be treated as running costs.
    expect(rows.filter((r) => !r.is_operating).map((r) => r.name)).toEqual(["Equipment", "Vehicle"]);
  });

  it("does not duplicate them when seeded again", async () => {
    const [store] = await q<{ id: string }>("select id from stores where name = 'Second Shop'");
    const before = await q<{ n: number }>(
      "select count(*)::int as n from expense_categories where store_id = $1",
      [store.id],
    );
    await q("select public.seed_expense_categories_for($1)", [store.id]);
    const after = await q<{ n: number }>(
      "select count(*)::int as n from expense_categories where store_id = $1",
      [store.id],
    );
    expect(after[0].n).toBe(before[0].n);
  });
});
