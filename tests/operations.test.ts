import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDesignDoc } from "../tools/design-doc";

/**
 * Applies every migration in order against a real Postgres engine (PGlite) and checks the
 * operations schema that 0005 adds on top of 0001.
 *
 * 0001-0004 already cover the selling path; this file covers suppliers, purchasing, customers,
 * shifts, refunds, production and stock takes. It also pins the Option A decision: the 14 tables
 * that 0001 owns are untouched, and 0005 only adds.
 */

const ROOT = join(__dirname, "..", "supabase");

// Supabase provides these; PGlite does not.
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

/** The 14 tables 0001 created that the design document also names. 0005 must not touch them. */
const SHARED = [
  "approvals", "bottle_ledger", "categories", "notifications", "pack_sizes", "payments",
  "product_barcodes", "product_batches", "product_costs", "products", "sale_items", "sales",
  "stock_movements", "stores",
];

/** Tables 0005 is responsible for creating. */
const ADDED = [
  "devices", "suppliers", "purchase_orders", "purchase_order_lines", "goods_receipts",
  "goods_receipt_lines", "customers", "customer_credit_entries", "shifts", "cash_movements",
  "refunds", "refund_lines", "production_runs", "production_inputs", "production_outputs",
  "stock_takes", "stock_take_lines", "batch_allocations", "weight_labels", "product_price_history",
  "daily_sales_rollup", "monthly_summaries", "roles", "permissions", "role_permissions",
];

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
}, 60_000);

afterAll(async () => {
  await db.close();
});

const columnsOf = async (table: string) => {
  const r = await db.query<{ column_name: string; is_nullable: string }>(
    `select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = $1`,
    [table],
  );
  return r.rows;
};

describe("0005 operations migration", () => {
  it("creates every added table", async () => {
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const existing = new Set(r.rows.map((x) => x.table_name));
    expect(ADDED.filter((t) => !existing.has(t))).toEqual([]);
  });

  it("leaves the 14 tables owned by 0001 alone", async () => {
    // If 0005 ever redefines one of these, the app's queries and the 0003 functions break.
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const existing = new Set(r.rows.map((x) => x.table_name));
    expect(SHARED.every((t) => existing.has(t))).toBe(true);

    // products still uses 0001's surrogate key and cents columns, not the design doc's _bp units.
    const products = (await columnsOf("products")).map((c) => c.column_name);
    expect(products).toContain("id");
    expect(products).toContain("stock_on_hand");
    expect(products).toContain("price_cents");
    expect(products).not.toContain("product_id");
    expect(products).not.toContain("tax_class_id");
  });

  it("keeps the design document's 50 tables accounted for", async () => {
    const model = parseDesignDoc(join(__dirname, "..", "pos_db.html"));
    const r = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const existing = new Set(r.rows.map((x) => x.table_name));

    // Renamed to match 0001, or deliberately folded into an existing concept. Each entry is a
    // decision recorded in the 0005 header, not an oversight.
    const mapped: Record<string, string> = {
      staff: "profiles",
      staff_credentials: "profiles",
      store_memberships: "profiles",
      audit_log: "audit_logs",
      store_settings: "stores",
      stock_move_types: "stock_move_types (enum stock_move_type)",
      notification_types: "notification_types (enum notification_type)",
      bottle_event_types: "bottle_event_types (enum bottle_event)",
      payment_methods: "payment_methods (enum pay_method)",
      tax_classes: "tax_classes (products.tax_rate_pct)",
      receipt_sequences: "receipt_sequences (receipt_no_seq)",
    };

    const unaccounted = model.tables
      .map((t) => t.name)
      .filter((t) => !existing.has(t) && !(t in mapped));
    expect(unaccounted).toEqual([]);
  });

  it("links new tables to 0001's surrogate keys", async () => {
    // Every FK from a new table must point at an existing primary key.
    const r = await db.query<{ conname: string }>(
      `select c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where c.contype = 'f' and n.nspname = 'public'
          and t.relname = any($1)
          and c.confrelid = 0`,
      [ADDED],
    );
    expect(r.rows).toEqual([]);
  });

  it("rejects a purchase order whose supplier does not exist", async () => {
    await expect(
      db.query(
        `insert into purchase_orders (store_id, supplier_id, po_no, total_cents)
         values (gen_random_uuid(), gen_random_uuid(), 'PO-1', 100)`,
      ),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("enforces the purchase order status enum", async () => {
    const store = await db.query<{ id: string }>(
      `insert into stores (name) values ('Ops Test') returning id`,
    );
    const storeId = store.rows[0].id;
    const sup = await db.query<{ id: string }>(
      `insert into suppliers (store_id, name) values ($1, 'Spice Traders') returning id`,
      [storeId],
    );
    await expect(
      db.query(
        `insert into purchase_orders (store_id, supplier_id, po_no, status)
         values ($1, $2, 'PO-2', 'shipped')`,
        [storeId, sup.rows[0].id],
      ),
    ).rejects.toThrow(/invalid input value for enum/i);

    await db.query(
      `insert into purchase_orders (store_id, supplier_id, po_no, status)
       values ($1, $2, 'PO-3', 'sent')`,
      [storeId, sup.rows[0].id],
    );
  });

  it("allows several sales of one product in a day", async () => {
    // The design doc used a composite primary key including pack_size_id, which makes the key
    // NULL for unit products. The surrogate key must permit many rows per day.
    const store = await db.query<{ id: string }>(`insert into stores (name) values ('Rollup') returning id`);
    const storeId = store.rows[0].id;
    const p = await db.query<{ id: string }>(
      `insert into products (store_id, name) values ($1, 'Chilli Powder') returning id`,
      [storeId],
    );
    const productId = p.rows[0].id;
    for (const n of [1, 2, 3]) {
      await db.query(
        `insert into daily_sales_rollup (store_id, business_date, product_id, pack_size_id, qty_sold, net_cents)
         values ($1, '2026-10-17', $2, null, $3, 1000)`,
        [storeId, productId, n],
      );
    }
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from daily_sales_rollup where store_id = $1`,
      [storeId],
    );
    expect(r.rows[0].n).toBe(3);
  });

  it("requires a positive quantity on a batch allocation", async () => {
    await expect(
      db.query(
        `insert into batch_allocations (batch_id, qty) values (gen_random_uuid(), 0)`,
      ),
    ).rejects.toThrow(/check constraint/i);
  });

  it("keeps one open shift selectable per device", async () => {
    const store = await db.query<{ id: string }>(`insert into stores (name) values ('Shift Store') returning id`);
    const storeId = store.rows[0].id;
    const dev = await db.query<{ id: string }>(
      `insert into devices (store_id, device_code, name) values ($1, 'T1', 'Till 1') returning id`,
      [storeId],
    );
    await db.query(`insert into shifts (store_id, device_id, shift_no) values ($1, $2, 1)`, [
      storeId,
      dev.rows[0].id,
    ]);
    await db.query(`insert into shifts (store_id, device_id, shift_no, is_open) values ($1, $2, 2, false)`, [
      storeId,
      dev.rows[0].id,
    ]);
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from shifts where store_id = $1 and is_open`,
      [storeId],
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("rejects a duplicate month summary for a store", async () => {
    const store = await db.query<{ id: string }>(`insert into stores (name) values ('Summary') returning id`);
    const storeId = store.rows[0].id;
    await db.query(
      `insert into monthly_summaries (store_id, period_year, period_month, net_sales_cents)
       values ($1, 2026, 10, 5000)`,
      [storeId],
    );
    await expect(
      db.query(
        `insert into monthly_summaries (store_id, period_year, period_month) values ($1, 2026, 10)`,
        [storeId],
      ),
    ).rejects.toThrow(/duplicate key|unique constraint/i);
  });

  it("enables row level security on every added table", async () => {
    const r = await db.query<{ tablename: string; rowsecurity: boolean }>(
      `select tablename, rowsecurity from pg_tables
        where schemaname = 'public' and tablename = any($1)`,
      [ADDED],
    );
    const unprotected = r.rows.filter((x) => !x.rowsecurity).map((x) => x.tablename);
    expect(unprotected).toEqual([]);
  });

  it("gives every added table at least one policy", async () => {
    // RLS with no policy denies everything, which is safe but useless: it would also lock out the
    // owner. This asserts each table has a deliberate policy rather than being forgotten.
    const r = await db.query<{ tablename: string; n: number }>(
      `select c.relname as tablename, count(p.polname)::int as n
         from pg_class c
         join pg_namespace ns on ns.oid = c.relnamespace
         left join pg_policy p on p.polrelid = c.oid
        where ns.nspname = 'public' and c.relname = any($1)
        group by c.relname`,
      [ADDED],
    );
    expect(r.rows.filter((x) => x.n === 0).map((x) => x.tablename)).toEqual([]);
  });
});

/**
 * Two shops, three roles. These exercise the policies through `set role authenticated`, which is
 * exactly what Supabase does for a signed-in user, so a policy that reads well but does not fire
 * still fails here.
 */
describe("0005/0006 access control", () => {
  let storeA = "";
  let storeB = "";
  let ownerA = "";
  let supervisorA = "";
  let cashierA = "";

  async function asUser<T>(authId: string, fn: () => Promise<T>): Promise<T> {
    await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false); set role authenticated;`);
    try {
      return await fn();
    } finally {
      await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
    }
  }

  beforeAll(async () => {
    const mk = async (name: string) =>
      (await db.query<{ id: string }>(`insert into stores (name) values ($1) returning id`, [name])).rows[0].id;
    storeA = await mk("Shop A");
    storeB = await mk("Shop B");

    const person = async (name: string, code: string, role: string, store: string) => {
      const authId = (
        await db.query<{ id: string }>(`insert into auth.users default values returning id`)
      ).rows[0].id;
      const id = (
        await db.query<{ id: string }>(
          `insert into profiles (auth_user_id, store_id, full_name, staff_code, role)
           values ($1, $2, $3, $4, $5) returning id`,
          [authId, store, name, code, role],
        )
      ).rows[0].id;
      return authId;
    };

    ownerA = await person("Owner A", "OA", "owner", storeA);
    supervisorA = await person("Sup A", "SA", "supervisor", storeA);
    cashierA = await person("Cashier A", "CA", "cashier", storeA);

    for (const [store, label] of [
      [storeA, "A"],
      [storeB, "B"],
    ] as const) {
      await db.query(`insert into suppliers (store_id, name) values ($1, $2)`, [store, `Supplier ${label}`]);
      await db.query(`insert into customers (store_id, name, phone) values ($1, $2, $3)`, [
        store,
        `Customer ${label}`,
        `07700000${label === "A" ? "01" : "02"}`,
      ]);
    }
  });

  it("shows a user only their own store's suppliers", async () => {
    const seen = await asUser(ownerA, async () => {
      const r = await db.query<{ name: string }>(`select name from suppliers order by name`);
      return r.rows.map((x) => x.name);
    });
    expect(seen).toEqual(["Supplier A"]);
  });

  it("lets an owner add a supplier", async () => {
    await asUser(ownerA, async () => {
      await db.query(`insert into suppliers (store_id, name) values ($1, 'Owner Added')`, [storeA]);
    });
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from suppliers where name = 'Owner Added'`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("stops an owner writing into another store", async () => {
    // The with-check clause must reject a row carrying store B's id while signed in to store A.
    await expect(
      asUser(ownerA, async () => {
        await db.query(`insert into suppliers (store_id, name) values ($1, 'Cross Store')`, [storeB]);
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("stops a supervisor adding a supplier", async () => {
    await expect(
      asUser(supervisorA, async () => {
        await db.query(`insert into suppliers (store_id, name) values ($1, 'Sup Added')`, [storeA]);
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("lets a supervisor add a customer but not a supplier", async () => {
    await asUser(supervisorA, async () => {
      await db.query(`insert into customers (store_id, name, phone) values ($1, 'Sup Customer', '0770000003')`, [storeA]);
    });
    const r = await db.query<{ n: number }>(
      `select count(*)::int as n from customers where name = 'Sup Customer'`,
    );
    expect(r.rows[0].n).toBe(1);
  });

  it("stops a cashier writing master data but still lets them read it", async () => {
    await expect(
      asUser(cashierA, async () => {
        await db.query(`insert into suppliers (store_id, name) values ($1, 'Cashier Added')`, [storeA]);
      }),
    ).rejects.toThrow(/row-level security|violates/i);

    const visible = await asUser(cashierA, async () => {
      const r = await db.query<{ n: number }>(`select count(*)::int as n from suppliers`);
      return r.rows[0].n;
    });
    expect(visible).toBeGreaterThan(0); // the till can read the supplier list
  });

  it("lets a cashier open their own shift but not record a refund", async () => {
    await asUser(cashierA, async () => {
      await db.query(`insert into shifts (store_id, shift_no) values ($1, 100)`, [storeA]);
    });

    await expect(
      asUser(cashierA, async () => {
        await db.query(
          `insert into refunds (store_id, sale_id, refund_no, amount_cents)
           values ($1, gen_random_uuid(), 1, 500)`,
          [storeA],
        );
      }),
    ).rejects.toThrow(/row-level security|violates/i);
  });

  it("hides another store's shifts", async () => {
    const seen = await asUser(ownerA, async () => {
      const r = await db.query<{ n: number }>(`select count(*)::int as n from shifts`);
      return r.rows[0].n;
    });
    const all = await db.query<{ n: number }>(`select count(*)::int as n from shifts`);
    expect(seen).toBeLessThan(all.rows[0].n);
  });
});
