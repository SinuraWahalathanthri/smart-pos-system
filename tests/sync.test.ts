import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import { PosDB } from "../lib/data/db";
import type { SbClient, SbError } from "../lib/supabase/client";
import { _resetSyncForTests, pullCatalogue, pushPendingSales, runSync, useSync } from "../lib/sync/engine";
import { applyUnsyncedSales, CATALOGUE_SELECT, mapProduct, toSalePayload, type ServerProductRow } from "../lib/sync/mappers";
import type { Product, SaleRecord } from "../lib/types";

const P1 = "11111111-1111-4111-8111-111111111111";
const PACK = "22222222-2222-4222-8222-222222222222";

let db: PosDB;
let n = 0;
beforeEach(() => {
  db = new PosDB(`sync-test-${n++}`);
  _resetSyncForTests();
});

function sale(id: string, over: Partial<SaleRecord> = {}): SaleRecord {
  return {
    id,
    receiptNo: 10001,
    createdAt: Date.UTC(2026, 9, 14, 10, 0, 0),
    cashierId: "33333333-3333-4333-8333-333333333333",
    cashierName: "Nimal",
    lines: [
      { productId: P1, name: "Marie Biscuit", qty: 2, unitPrice: 12000, taxRate: 18, lineTotal: 24000, taxAmount: 3661, kind: "item" },
    ],
    voidedLines: [],
    subtotal: 24000,
    discount: 0,
    total: 24000,
    taxIncluded: 3661,
    bottlesReturned: 0,
    bottleFeeCharged: 0,
    payments: [{ method: "cash", amount: 24000, tendered: 25000, change: 1000 }],
    syncStatus: "pending",
    ...over,
  };
}

type RpcReply = { data: unknown; error: SbError | null };

function client(opts: {
  rpc?: (fn: string, args: Record<string, unknown>) => RpcReply | Promise<RpcReply>;
  rows?: unknown[];
}): SbClient & { calls: { fn: string; args: Record<string, unknown> }[] } {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    rpc: async (fn, args = {}) => {
      calls.push({ fn, args });
      return opts.rpc ? opts.rpc(fn, args) : { data: null, error: null };
    },
    from: () => ({
      select: () => ({
        range: async (a: number, b: number) => ({ data: (opts.rows ?? []).slice(a, b + 1), error: null }),
      }),
    }),
  };
}

const ok = (receipt: number, status = "created"): RpcReply => ({ data: { status, receipt_no: receipt }, error: null });
const fail = (message: string, extra: Partial<SbError> = {}): RpcReply => ({ data: null, error: { message, ...extra } });

describe("mapping server rows to till products", () => {
  const row: ServerProductRow = {
    id: P1,
    name: "Curry Powder",
    sku: null,
    kind: "finished",
    sale_mode: "weighted",
    price_cents: "0",
    tax_rate_pct: "0.00",
    stock_on_hand: "0.000",
    reorder_level: "0",
    is_favourite: true,
    is_returnable_bottle: false,
    color: "#b45309",
    image_path: null,
    is_active: true,
    categories: { name: "Spices" },
    pack_sizes: [
      { id: "b", label: "250 g", weight_g: 250, price_cents: "43000", packets_on_hand: "3.000", sort_order: 3, is_active: true },
      { id: "a", label: "50 g", weight_g: 50, price_cents: 9500, packets_on_hand: 24, sort_order: 1, is_active: true },
      { id: "c", label: "old", weight_g: 75, price_cents: 1, packets_on_hand: 0, sort_order: 2, is_active: false },
    ],
    product_barcodes: [{ barcode: "4790000000013", pack_size_id: "b", is_primary: true }],
  };

  it("turns strings into numbers, sorts sizes, drops inactive sizes, attaches pack barcodes", () => {
    const p = mapProduct(row);
    expect(p.category).toBe("Spices");
    expect(p.packSizes.map((s) => s.label)).toEqual(["50 g", "250 g"]);
    expect(p.packSizes[1]).toMatchObject({ price: 43000, stock: 3, barcode: "4790000000013" });
    expect(p.packSizes[0].barcode).toBeUndefined();
    expect(p.barcode).toBeUndefined();
  });

  it("maps unit items with their own barcode and ignores storage paths for images", () => {
    const p = mapProduct({
      ...row, sale_mode: "unit", price_cents: 12000, stock_on_hand: "60.000", pack_sizes: [], image_path: "products/marie.webp",
      product_barcodes: [{ barcode: "4790000000044", pack_size_id: null, is_primary: true }], categories: null,
    });
    expect(p).toMatchObject({ barcode: "4790000000044", price: 12000, stock: 60, category: "Other", imageUrl: undefined });
  });
});

describe("pending sales and stock", () => {
  it("takes unsynced quantities off pulled stock (packets and pieces)", () => {
    const products = [
      { id: P1, saleMode: "unit", stock: 60, packSizes: [] },
      { id: "curry", saleMode: "weighted", stock: 0, packSizes: [{ id: PACK, stock: 3 }] },
    ] as unknown as Product[];
    const out = applyUnsyncedSales(products, [
      sale("s1"),
      sale("s2", { lines: [{ productId: "curry", packSizeId: PACK, name: "Curry", qty: 2, unitPrice: 1, taxRate: 0, lineTotal: 2, taxAmount: 0, kind: "item" }] }),
    ]);
    expect(out.find((p) => p.id === P1)!.stock).toBe(58);
    expect(out.find((p) => p.id === "curry")!.packSizes[0].stock).toBe(1);
    expect(products[0].stock).toBe(60); // input untouched
  });
});

describe("toSalePayload", () => {
  it("uses cents, ISO time and snake_case, and nulls ids that are not uuids", () => {
    const payload = toSalePayload(
      sale("44444444-4444-4444-8444-444444444444", {
        cashierId: "nimal",
        lines: [
          { productId: P1, name: "Marie", qty: 2, unitPrice: 12000, taxRate: 18, lineTotal: 24000, taxAmount: 3661, kind: "item" },
          { productId: "bottle-fee", name: "Bottle not returned", qty: 1, unitPrice: 10000, taxRate: 0, lineTotal: 10000, taxAmount: 0, kind: "bottle_fee" },
        ],
      }),
    ) as { cashier_id: unknown; created_at: string; lines: { product_id: unknown; kind: string }[]; payments: { amount_cents: number }[] };
    expect(payload.cashier_id).toBeNull();
    expect(payload.created_at).toBe("2026-10-14T10:00:00.000Z");
    expect(payload.lines[0]).toMatchObject({ product_id: P1, kind: "item" });
    expect(payload.lines[1]).toMatchObject({ product_id: null, kind: "bottle_fee" });
    expect(payload.payments[0].amount_cents).toBe(24000);
  });
});

describe("pushPendingSales", () => {
  it("uploads queued sales oldest first and records the server receipt number", async () => {
    await db.sales.bulkAdd([sale("b", { createdAt: 2000 }), sale("a", { createdAt: 1000 }), sale("done", { syncStatus: "synced" })]);
    let receipt = 5000;
    const c = client({ rpc: () => ok(++receipt) });
    const res = await pushPendingSales(c, db);

    expect(res).toEqual({ synced: 2, failed: 0, stopped: null });
    // attach_invoice also sends p_sale, so filter to the sale uploads themselves
    expect(c.calls.filter((x) => x.fn === "complete_sale").map((x) => (x.args.p_sale as { id: string }).id)).toEqual(["a", "b"]);
    expect(await db.sales.get("a")).toMatchObject({ syncStatus: "synced", serverReceiptNo: 5001 });
  });

  it("treats a duplicate as success, so retries after a dropped reply are safe", async () => {
    await db.sales.add(sale("a"));
    const res = await pushPendingSales(client({ rpc: () => ok(10001, "duplicate") }), db);
    expect(res.synced).toBe(1);
    expect((await db.sales.get("a"))!.syncStatus).toBe("synced");
  });

  it("stops at the first dropped connection and keeps everything queued", async () => {
    await db.sales.bulkAdd([sale("a", { createdAt: 1 }), sale("b", { createdAt: 2 })]);
    const c = client({ rpc: () => fail("TypeError: Failed to fetch") });
    const res = await pushPendingSales(c, db);
    expect(res).toEqual({ synced: 0, failed: 0, stopped: "offline" });
    expect(c.calls).toHaveLength(1); // did not hammer the rest
    expect((await db.sales.where("syncStatus").equals("pending").count())).toBe(2);
  });

  it("stops on an expired till sign-in without marking sales failed", async () => {
    await db.sales.add(sale("a"));
    const res = await pushPendingSales(client({ rpc: () => fail("JWT expired", { status: 401 }) }), db);
    expect(res.stopped).toBe("auth");
    expect((await db.sales.get("a"))!.syncStatus).toBe("pending");
  });

  it("parks a refused sale as failed and carries on with the next", async () => {
    await db.sales.bulkAdd([sale("bad", { createdAt: 1 }), sale("good", { createdAt: 2 })]);
    const c = client({
      rpc: (_fn, args) =>
        (args.p_sale as { id: string }).id === "bad" ? fail("sale total 1 does not match its lines", { code: "P0001" }) : ok(7),
    });
    const res = await pushPendingSales(c, db);
    expect(res).toEqual({ synced: 1, failed: 1, stopped: null });
    expect(await db.sales.get("bad")).toMatchObject({ syncStatus: "failed", syncError: expect.stringContaining("does not match") });
    expect((await db.sales.get("good"))!.syncStatus).toBe("synced");
  });

  it("does not retry a failed sale on the next cycle", async () => {
    await db.sales.add(sale("bad", { syncStatus: "failed", syncError: "x" }));
    const c = client({});
    await pushPendingSales(c, db);
    expect(c.calls).toHaveLength(0);
  });
});

describe("pullCatalogue", () => {
  const rows = (count: number): ServerProductRow[] =>
    Array.from({ length: count }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, name: `P${i}`, sku: null, kind: "trade", sale_mode: "unit",
      price_cents: 1000, tax_rate_pct: 0, stock_on_hand: 10, reorder_level: 0, is_favourite: false, is_returnable_bottle: false,
      color: null, image_path: null, is_active: true, categories: null, pack_sizes: [], product_barcodes: [],
    }));

  it("pages through large catalogues and replaces what was there", async () => {
    await db.products.put({ id: "stale" } as Product);
    const count = await pullCatalogue(client({ rows: rows(1203) }), db);
    expect(count).toBe(1203);
    expect(await db.products.count()).toBe(1203);
    expect(await db.products.get("stale")).toBeUndefined();
  });

  it("keeps the stock effect of sales the server has not received yet", async () => {
    const r = rows(1);
    r[0].id = P1;
    await db.sales.add(sale("pending-1")); // sold 2 of P1 while offline
    await pullCatalogue(client({ rows: r }), db);
    expect((await db.products.get(P1))!.stock).toBe(8);
  });
});

describe("runSync", () => {
  it("uploads, refreshes, and reports idle", async () => {
    await db.sales.add(sale("a"));
    const c = client({ rpc: (fn) => (fn === "complete_sale" ? ok(9) : { data: { store: { name: "Shop" } }, error: null }), rows: [] });
    await runSync(c, db, { force: true });
    expect(useSync.getState()).toMatchObject({ state: "idle", message: null });
    expect(useSync.getState().lastSyncAt).not.toBeNull();
    expect(await db.meta.get("till")).toMatchObject({ value: { store: { name: "Shop" } } });
    expect((await db.sales.get("a"))!.syncStatus).toBe("synced");
  });

  it("reports offline when the server is unreachable, and keeps the queue", async () => {
    await db.sales.add(sale("a"));
    await runSync(client({ rpc: () => fail("Failed to fetch") }), db, { force: true });
    expect(useSync.getState().state).toBe("offline");
    expect((await db.sales.get("a"))!.syncStatus).toBe("pending");
  });

  it("asks for a till sign-in when the session has expired", async () => {
    await db.sales.add(sale("a"));
    await runSync(client({ rpc: () => fail("not_authenticated", { code: "28000" }) }), db, { force: true });
    expect(useSync.getState()).toMatchObject({ state: "auth" });
  });

  it("surfaces refused sales in the message but still finishes", async () => {
    await db.sales.add(sale("a"));
    const c = client({ rpc: (fn) => (fn === "complete_sale" ? fail("bad sale", { code: "P0001" }) : { data: {}, error: null }), rows: [] });
    await runSync(c, db, { force: true });
    expect(useSync.getState().state).toBe("idle");
    expect(useSync.getState().message).toMatch(/refused/);
  });
});

describe("catalogue query", () => {
  it("names the pack_sizes constraint so PostgREST can resolve the embed", () => {
    // pack_sizes has two foreign keys to products (product_id and packaging_product_id). Without the
    // constraint name PostgREST rejects the whole request with PGRST201 and the till gets no products
    // at all, so the till showed "Sync problem" and an empty screen.
    expect(CATALOGUE_SELECT).toContain("pack_sizes!pack_sizes_product_id_fkey(");
    expect(CATALOGUE_SELECT).not.toMatch(/categories\(name\),pack_sizes\(/);
  });
});
