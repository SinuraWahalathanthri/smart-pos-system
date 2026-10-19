import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseDesignDoc } from "../tools/design-doc";
import { generatePostgres } from "../tools/ddl";

/**
 * The generated schema must actually run on Postgres, not merely look plausible.
 *
 * PGlite is a real Postgres engine compiled to WASM, so this catches syntax that tsc cannot: enum
 * ordering, FK cycles, composite-key mistakes, and reserved-word collisions in 484 generated columns.
 * It also pins the design document to the committed migration: if pos_db.html gains a table and the
 * migration is not regenerated, this fails.
 */

const ROOT = join(__dirname, "..");
// The design-document schema. It is NOT applied by the app: 0001_core.sql is the live schema.
const MIGRATION = join(ROOT, "supabase", "design", "0005_core_schema.sql");

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(`create extension if not exists pgcrypto;`);
  await db.exec(readFileSync(MIGRATION, "utf8"));
});

afterAll(async () => {
  await db.close();
});

describe("core schema", () => {
  it("creates every table from the design document", async () => {
    const model = parseDesignDoc(join(ROOT, "pos_db.html"));
    const rows = await db.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'`,
    );
    const created = new Set(rows.rows.map((r) => r.table_name));
    const missing = model.tables.map((t) => t.name).filter((n) => !created.has(n));
    expect(missing).toEqual([]);
    expect(model.tables).toHaveLength(50);
    expect(created.size).toBeGreaterThanOrEqual(50);
  });

  it("creates every column from the design document", async () => {
    const model = parseDesignDoc(join(ROOT, "pos_db.html"));
    for (const table of model.tables) {
      const rows = await db.query<{ column_name: string }>(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = $1`,
        [table.name],
      );
      const actual = rows.rows.map((r) => r.column_name);
      const missing = table.columns.map((c) => c.name).filter((n) => !actual.includes(n));
      expect(missing, `${table.name} missing columns`).toEqual([]);
    }
    const total = model.tables.reduce((n, t) => n + t.columns.length, 0);
    expect(total).toBe(484);
  });

  it("ports BINARY(16) to uuid and DATETIME(3) to timestamptz", async () => {
    const rows = await db.query<{ column_name: string; data_type: string }>(
      `select column_name, data_type from information_schema.columns
        where table_name = 'products' and column_name in ('product_id', 'created_at')`,
    );
    const byName = Object.fromEntries(rows.rows.map((r) => [r.column_name, r.data_type]));
    expect(byName.product_id).toBe("uuid");
    expect(byName.created_at).toBe("timestamp with time zone");
  });

  it("enforces enum values instead of accepting any string", async () => {
    const store = await db.query<{ store_id: string }>(
      `insert into stores (code, name) values ('T1', 'Test') returning store_id`,
    );
    const storeId = store.rows[0].store_id;
    await expect(
      db.query(
        `insert into products (store_id, sku, name, kind) values ($1, 'SKU1', 'Chilli', 'nonsense')`,
        [storeId],
      ),
    ).rejects.toThrow(/invalid input value for enum/i);
  });

  it("rejects a child row whose parent does not exist", async () => {
    await expect(
      db.query(`insert into store_settings (store_id, max_cashier_discount_bp) values (gen_random_uuid(), 500)`),
    ).rejects.toThrow(/violates foreign key constraint/i);
  });

  it("allows a parent and its 1:1 settings row", async () => {
    const store = await db.query<{ store_id: string }>(
      `insert into stores (code, name) values ('T2', 'Second') returning store_id`,
    );
    const storeId = store.rows[0].store_id;
    await db.query(`insert into store_settings (store_id, bottle_fee_cents) values ($1, 2500)`, [storeId]);
    const rows = await db.query<{ n: number }>(
      `select count(*)::int as n from store_settings where store_id = $1`,
      [storeId],
    );
    expect(rows.rows[0].n).toBe(1);
  });

  it("applies the unsigned CHECK to counters", async () => {
    const store = await db.query<{ store_id: string }>(
      `insert into stores (code, name) values ('T3', 'Third') returning store_id`,
    );
    await expect(
      db.query(`insert into roles (role_id, code, name, rank) values (-1, 'bad', 'Bad', 1)`),
    ).rejects.toThrow(/check constraint|violates/i);
    expect(store.rows[0].store_id).toBeTruthy();
  });

  it("matches the committed migration byte for byte with a fresh generation", () => {
    const generated = generatePostgres(parseDesignDoc(join(ROOT, "pos_db.html")));
    expect(readFileSync(MIGRATION, "utf8")).toBe(generated.sql);
  });

  it("resolves every declared foreign key", () => {
    const generated = generatePostgres(parseDesignDoc(join(ROOT, "pos_db.html")));
    expect(generated.warnings).toEqual([]);
  });
});
