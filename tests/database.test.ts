import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addLine, voidQty } from "../lib/bill";
import { buildSale } from "../lib/checkout";
import { toSalePayload } from "../lib/sync/mappers";
import type { SaleRecord } from "../lib/types";

/**
 * Runs the real Supabase migrations + seed against an in-process Postgres (PGlite) and checks the
 * rules that protect the shop: stock can't be edited by hand, sales are idempotent and validated,
 * supervisor approval needs badge + PIN with lockout, and cashiers can't read or change what they shouldn't.
 */

const ROOT = join(__dirname, "..", "supabase");
let db: PGlite;

// Supabase provides these; PGlite doesn't, so stub the minimum.
const SUPABASE_STUBS = `
  create schema extensions;
  create role anon nologin; create role authenticated nologin; create role service_role nologin;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid(), email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  grant usage on schema auth, extensions to anon, authenticated;
`;

const ids: Record<string, string> = {};

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** Run as a signed-in Supabase user (role `authenticated`, auth.uid() = that user). */
async function asUser<T>(authId: string, fn: () => Promise<T>): Promise<T> {
  await db.exec(`select set_config('request.jwt.claim.sub', '${authId}', false); set role authenticated;`);
  try {
    return await fn();
  } finally {
    await db.exec("reset role; select set_config('request.jwt.claim.sub', '', false);");
  }
}

const rpc = (name: string, args: unknown[]) =>
  q<{ r: unknown }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(", ")}) as r`, args).then((r) => r[0].r);

beforeAll(async () => {
  db = new PGlite({ extensions: { pgcrypto } });
  await db.exec(SUPABASE_STUBS);
  const files = readdirSync(join(ROOT, "migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) await db.exec(readFileSync(join(ROOT, "migrations", f), "utf8"));
  await db.exec(readFileSync(join(ROOT, "seed.sql"), "utf8"));

  // link the seeded staff to sign-in users: owner, supervisor, and a cashier till
  for (const [role, code] of [["owner", "1"], ["supervisor", "2"], ["cashier", "3"]] as const) {
    const [u] = await q<{ id: string }>("insert into auth.users (email) values ($1) returning id", [`${role}@shop.test`]);
    ids[role] = u.id;
    await q("update profiles set auth_user_id = $1 where staff_code = $2", [u.id, code]);
  }
  const [store] = await q<{ id: string }>("select id from stores");
  ids.store = store.id;
  for (const p of await q<{ id: string; name: string }>("select id, name from products")) ids[p.name] = p.id;
  const [curry250] = await q<{ id: string }>(
    "select ps.id from pack_sizes ps join products p on p.id = ps.product_id where p.name = 'Curry Powder' and ps.weight_g = 250",
  );
  ids.curry250 = curry250.id;
}, 60_000);

afterAll(async () => {
  await db.close();
});

const stockOf = async (name: string) => Number((await q<{ s: string }>("select stock_on_hand s from products where name = $1", [name]))[0].s);
const packsOf = async () => Number((await q<{ s: string }>("select packets_on_hand s from pack_sizes where id = $1", [ids.curry250]))[0].s);

function salePayload(over: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    created_at: new Date().toISOString(),
    local_receipt_no: 1,
    subtotal_cents: 59000,
    discount_cents: 0,
    total_cents: 59000,
    tax_included_cents: 3661,
    bottles_returned: 0,
    bottle_fee_cents: 10000,
    lines: [
      { product_id: ids["Marie Biscuit"], kind: "item", name: "Marie Biscuit", qty: 2, unit_price_cents: 12000, tax_rate_pct: 18, tax_cents: 3661, line_total_cents: 24000 },
      { product_id: ids["Fresh Milk (glass bottle)"], kind: "item", name: "Fresh Milk (glass bottle)", qty: 1, unit_price_cents: 25000, tax_rate_pct: 0, tax_cents: 0, line_total_cents: 25000 },
      { kind: "bottle_fee", name: "Bottle not returned", qty: 1, unit_price_cents: 10000, tax_rate_pct: 0, tax_cents: 0, line_total_cents: 10000 },
    ],
    voided: [],
    payments: [{ method: "cash", amount_cents: 59000, tendered_cents: 60000, change_cents: 1000 }],
    ...over,
  };
}

describe("seed and stock ledger", () => {
  it("loads the demo shop", async () => {
    expect((await q("select 1 from products")).length).toBe(12);
    expect((await q("select 1 from pack_sizes")).length).toBe(20);
    expect((await q("select 1 from product_barcodes")).length).toBe(11);
  });

  it("maintains on-hand stock from the ledger", async () => {
    expect(await stockOf("Marie Biscuit")).toBe(60);
    expect(await packsOf()).toBe(3);
  });

  it("rejects direct edits to stock", async () => {
    await expect(q("update products set stock_on_hand = 999 where name = 'Marie Biscuit'")).rejects.toThrow(/maintained by stock_movements/);
    await expect(q("update pack_sizes set packets_on_hand = 999 where id = $1", [ids.curry250])).rejects.toThrow(/maintained by stock_movements/);
  });

  it("keeps the ledger append-only", async () => {
    await expect(q("delete from stock_movements")).rejects.toThrow(/append-only/);
    await expect(q("update stock_movements set qty_change = 0")).rejects.toThrow(/append-only/);
  });

  it("raises one low-stock alert per item", async () => {
    const open = await q<{ title: string; type: string }>("select title, type from notifications where resolved_at is null order by title");
    const titles = open.map((n) => n.title);
    expect(titles).toContain("Curry Powder 250 g is running low");
    expect(titles).toContain("Cream Cracker is running low");
    expect(new Set(titles).size).toBe(titles.length);
  });
});

describe("complete_sale", () => {
  it("records a sale, takes stock and writes the bottle ledger", async () => {
    const payload = salePayload();
    const res = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]))) as { receipt_no: number; status: string };
    expect(res.status).toBe("created");
    expect(Number(res.receipt_no)).toBeGreaterThanOrEqual(10001);

    expect(await stockOf("Marie Biscuit")).toBe(58);
    expect(await stockOf("Fresh Milk (glass bottle)")).toBe(35);

    const ledger = await q<{ event: string; qty: number; amount_cents: string }>(
      "select event, qty, amount_cents from bottle_ledger order by event",
    );
    expect(ledger.map((l) => l.event).sort()).toEqual(["fee_charged", "sold"]);
    expect(Number(ledger.find((l) => l.event === "fee_charged")!.amount_cents)).toBe(10000);

    const items = await q("select 1 from sale_items where sale_id = $1", [payload.id]);
    expect(items.length).toBe(3);
  });

  it("accepts exactly what the till's own code produces (till -> sync mapper -> complete_sale)", async () => {
    const [nimal] = await q<{ id: string }>("select id from profiles where staff_code = '3'");
    let lines = addLine([], { productId: ids["Marie Biscuit"], name: "Marie Biscuit", qty: 3, unitPrice: 12000, taxRate: 18 }).lines;
    lines = voidQty(lines, lines[0].id, 1, "Double scan", "Kamal (Supervisor)", Date.now());
    lines = addLine(lines, { productId: ids["Curry Powder"], packSizeId: ids.curry250, name: "Curry Powder", label: "250 g", qty: 1, unitPrice: 43000, taxRate: 0 }).lines;
    lines = addLine(lines, { productId: ids["Fresh Milk (glass bottle)"], name: "Fresh Milk (glass bottle)", qty: 1, unitPrice: 25000, taxRate: 0, returnableBottle: true }).lines;

    const { sale } = buildSale({ lines, bottlesReturned: 0, feeWaived: 0, discount: 1000 }, { id: nimal.id, name: "Nimal" }, { method: "cash", tendered: 100000 });
    const record: SaleRecord = { ...sale, receiptNo: 77, syncStatus: "pending" };
    const marieBefore = await stockOf("Marie Biscuit");
    const packsBefore = await packsOf();

    const res = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(toSalePayload(record))]))) as { status: string };
    expect(res.status).toBe("created");

    // 24,000 + 43,000 + 25,000 + 10,000 fee = 102,000 - 1,000 discount
    const [row] = await q(
      "select total_cents, discount_cents, local_receipt_no, cashier_id, bottle_fee_cents from sales where id = $1", [record.id]);
    expect(row).toMatchObject({ total_cents: 101000, discount_cents: 1000, local_receipt_no: 77, cashier_id: nimal.id, bottle_fee_cents: 10000 });
    expect(await stockOf("Marie Biscuit")).toBe(marieBefore - 2); // 3 scanned, 1 voided
    expect(await packsOf()).toBe(packsBefore - 1);
    expect((await q("select 1 from sale_items where sale_id = $1 and status = 'voided' and void_reason = 'Double scan'", [record.id])).length).toBe(1);
    expect((await q("select 1 from bottle_ledger where sale_id = $1 and event = 'fee_charged'", [record.id])).length).toBe(1);
  });

  it("is idempotent: a retried sync neither duplicates nor takes stock twice", async () => {
    const payload = salePayload();
    const first = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]))) as { receipt_no: number };
    const before = await stockOf("Marie Biscuit");
    const again = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]))) as { status: string; receipt_no: number };
    expect(again.status).toBe("duplicate");
    expect(again.receipt_no).toBe(first.receipt_no);
    expect(await stockOf("Marie Biscuit")).toBe(before);
  });

  it("rejects a tampered total, bad payments and an anonymous tab", async () => {
    const call = (p: unknown) => asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(p)]));
    await expect(call(salePayload({ total_cents: 100 }))).rejects.toThrow(/does not match its lines/);
    await expect(call(salePayload({ payments: [{ method: "cash", amount_cents: 1000 }] }))).rejects.toThrow(/do not add up/);
    // Credit is now a real method, but it still needs a customer to collect from.
    await expect(call(salePayload({ payments: [{ method: "credit", amount_cents: 59000 }] }))).rejects.toThrow(/needs a customer/);
    await expect(
      call(salePayload({ lines: [{ product_id: ids["Marie Biscuit"], kind: "item", name: "x", qty: 2, unit_price_cents: 12000, line_total_cents: 5 }] })),
    ).rejects.toThrow(/does not match quantity/);
  });

  it("keeps voided lines for audit without touching stock", async () => {
    const before = await stockOf("Milk Packet 1 L");
    const payload = salePayload({
      subtotal_cents: 12000, total_cents: 12000, tax_included_cents: 1831, bottle_fee_cents: 0,
      lines: [{ product_id: ids["Marie Biscuit"], kind: "item", name: "Marie Biscuit", qty: 1, unit_price_cents: 12000, tax_rate_pct: 18, tax_cents: 1831, line_total_cents: 12000 }],
      voided: [{ product_id: ids["Milk Packet 1 L"], name: "Milk Packet 1 L", qty: 1, unit_price_cents: 29000, reason: "Wrong item", by: "Kamal" }],
      payments: [{ method: "cash", amount_cents: 12000, tendered_cents: 12000 }],
    });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    expect(await stockOf("Milk Packet 1 L")).toBe(before);
    const voided = await q<{ status: string; void_reason: string; voided_by_name: string }>(
      "select status, void_reason, voided_by_name from sale_items where sale_id = $1 and status = 'voided'", [payload.id]);
    expect(voided).toEqual([{ status: "voided", void_reason: "Wrong item", voided_by_name: "Kamal" }]);
    expect((await q("select 1 from audit_logs where action = 'line_voided'")).length).toBeGreaterThan(0);
  });

  it("sells a spice pack size and records a waived bottle fee", async () => {
    const before = await packsOf();
    const payload = salePayload({
      subtotal_cents: 68000, total_cents: 68000, tax_included_cents: 0, bottle_fee_cents: 0,
      lines: [
        { product_id: ids["Curry Powder"], pack_size_id: ids.curry250, kind: "item", name: "Curry Powder", label: "250 g", qty: 1, unit_price_cents: 43000, line_total_cents: 43000 },
        { product_id: ids["Fresh Milk (glass bottle)"], kind: "item", name: "Fresh Milk (glass bottle)", qty: 1, unit_price_cents: 25000, line_total_cents: 25000 },
      ],
      payments: [{ method: "card", amount_cents: 68000, reference: "4242" }],
    });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    expect(await packsOf()).toBe(before - 1);
    expect((await q("select 1 from bottle_ledger where event = 'fee_waived'")).length).toBe(1);
    expect((await q("select 1 from audit_logs where action = 'bottle_fee_waived'")).length).toBe(1);
  });

  it("moves the alert from low to out of stock, and clears it on restock", async () => {
    const sell = (n: number) =>
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(salePayload({
        subtotal_cents: 43000 * n, total_cents: 43000 * n, tax_included_cents: 0, bottle_fee_cents: 0,
        lines: [{ product_id: ids["Curry Powder"], pack_size_id: ids.curry250, kind: "item", name: "Curry Powder", label: "250 g", qty: n, unit_price_cents: 43000, line_total_cents: 43000 * n }],
        payments: [{ method: "cash", amount_cents: 43000 * n, tendered_cents: 43000 * n }],
      }))]));
    const remaining = await packsOf();
    await sell(remaining);
    expect(await packsOf()).toBe(0);
    const open = () => q<{ type: string }>("select type from notifications where resolved_at is null and title like 'Curry Powder 250 g%'");
    expect((await open()).map((n) => n.type)).toEqual(["out_of_stock"]);

    await asUser(ids.owner, () => rpc("adjust_stock", [ids["Curry Powder"], ids.curry250, 20, "Restock after packing", null]));
    expect(await packsOf()).toBe(20);
    expect(await open()).toEqual([]);
  });
});

describe("supervisor approval (badge + PIN)", () => {
  const verify = (badge: string | null, pin: string, action: string) =>
    asUser(ids.cashier, () => rpc("verify_supervisor", [badge, pin, action])) as Promise<Record<string, unknown>>;

  it("rejects an unknown badge", async () => {
    expect(await verify("NOT-A-BADGE", "2222", "void")).toMatchObject({ ok: false, reason: "invalid_badge" });
  });

  it("needs the PIN as well as the badge", async () => {
    expect(await verify("SUP-0002", "", "void")).toMatchObject({ ok: false, reason: "pin_required" });
    expect(await verify("SUP-0002", "0000", "void")).toMatchObject({ ok: false, reason: "wrong_pin", tries_left: 2 });
  });

  it("locks after three wrong PINs, even for the right PIN", async () => {
    expect(await verify("SUP-0002", "0001", "void")).toMatchObject({ ok: false, reason: "wrong_pin", tries_left: 1 });
    expect(await verify("SUP-0002", "0002", "void")).toMatchObject({ ok: false, reason: "locked" });
    expect(await verify("SUP-0002", "2222", "void")).toMatchObject({ ok: false, reason: "locked" });
  });

  it("approves once the lock has expired, with a single-use token for one action", async () => {
    await q("update profiles set locked_until = now() - interval '1 minute' where staff_code = '2'");
    const ok = await verify("SUP-0002", "2222", "stock_adjustment");
    expect(ok).toMatchObject({ ok: true, approver_name: "Kamal (Supervisor)" });
    const token = ok.token as string;

    // a token for a different action is refused
    const other = await verify("SUP-0002", "2222", "void");
    await expect(
      asUser(ids.cashier, () => rpc("adjust_stock", [ids["Marie Biscuit"], null, -2, "Damaged", other.token])),
    ).rejects.toThrow(/invalid_approval/);

    // the right token works once
    await asUser(ids.cashier, () => rpc("adjust_stock", [ids["Marie Biscuit"], null, -2, "Damaged in store", token]));
    await expect(
      asUser(ids.cashier, () => rpc("adjust_stock", [ids["Marie Biscuit"], null, -2, "Again", token])),
    ).rejects.toThrow(/invalid_approval/);

    const log = await q<{ approved_by: string }>("select approved_by from audit_logs where action = 'stock_adjusted' order by created_at desc limit 1");
    const [kamal] = await q<{ id: string }>("select id from profiles where staff_code = '2'");
    expect(log[0].approved_by).toBe(kamal.id);
  });

  it("a cashier cannot adjust stock without approval", async () => {
    await expect(
      asUser(ids.cashier, () => rpc("adjust_stock", [ids["Marie Biscuit"], null, -1, "Sneaky", null])),
    ).rejects.toThrow(/invalid_approval/);
  });

  it("lets the signed-in owner approve with the PIN only", async () => {
    const res = (await asUser(ids.owner, () => rpc("verify_supervisor", [null, "9999", "void"]))) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true, approver_name: "Shop Owner" });
  });
});

describe("row level security", () => {
  it("hides credential hashes from every client role", async () => {
    await expect(asUser(ids.cashier, () => q("select pin_hash from profiles"))).rejects.toThrow(/permission denied/);
    await expect(asUser(ids.owner, () => q("select badge_hash from profiles"))).rejects.toThrow(/permission denied/);
    const names = await asUser(ids.cashier, () => q("select full_name, role from profiles"));
    expect(names.length).toBe(3);
  });

  it("keeps cost and settings owner-only", async () => {
    await q("insert into product_costs (product_id, store_id, cost_cents) values ($1, $2, 8000)", [ids["Marie Biscuit"], ids.store]);
    expect((await asUser(ids.cashier, () => q("select 1 from product_costs"))).length).toBe(0);
    expect((await asUser(ids.supervisor, () => q("select 1 from product_costs"))).length).toBe(0);
    expect((await asUser(ids.owner, () => q("select 1 from product_costs"))).length).toBe(1);
  });

  it("stops a cashier editing the catalogue or writing sales directly", async () => {
    const changed = await asUser(ids.cashier, () => db.query("update products set name = 'Hacked' where name = 'Cream Cracker'"));
    expect(changed.affectedRows).toBe(0);
    await expect(
      asUser(ids.cashier, () => q("insert into sales (id, store_id, subtotal_cents, total_cents, created_at) values (gen_random_uuid(), $1, 1, 1, now())", [ids.store])),
    ).rejects.toThrow(/permission denied/);
    await expect(asUser(ids.cashier, () => q("insert into stock_movements (store_id, product_id, qty_change, type) values ($1, $2, 100, 'adjustment')", [ids.store, ids["Marie Biscuit"]]))).rejects.toThrow(/permission denied/);
    await expect(asUser(ids.cashier, () => rpc("consume_approval", [crypto.randomUUID(), "void"]))).rejects.toThrow(/permission denied/);
  });

  it("lets the owner edit the catalogue", async () => {
    const changed = await asUser(ids.owner, () => db.query("update products set is_favourite = true where name = 'Cream Cracker'"));
    expect(changed.affectedRows).toBe(1);
  });

  it("limits audit and stock history to the right roles", async () => {
    expect((await asUser(ids.cashier, () => q("select 1 from audit_logs"))).length).toBe(0);
    expect((await asUser(ids.owner, () => q("select 1 from audit_logs"))).length).toBeGreaterThan(0);
    expect((await asUser(ids.cashier, () => q("select 1 from stock_movements"))).length).toBe(0);
    expect((await asUser(ids.supervisor, () => q("select 1 from stock_movements"))).length).toBeGreaterThan(0);
  });

  it("never exposes approvals to a client", async () => {
    await expect(asUser(ids.owner, () => q("select 1 from approvals"))).rejects.toThrow(/permission denied/);
  });
});

describe("till sign-in (staff code + PIN, checked on the server)", () => {
  const signIn = (code: string, pin: string) =>
    asUser(ids.cashier, () => rpc("verify_staff_pin", [code, pin])) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any

  it("signs a member of staff in and returns who they are, never a hash", async () => {
    const res = await signIn("3", "3333");
    expect(res).toMatchObject({ ok: true, staff: { name: "Nimal (Cashier)", role: "cashier", code: "3" } });
    expect(JSON.stringify(res)).not.toMatch(/hash|\$2a\$/);
  });

  it("rejects an unknown code and a wrong PIN, counting tries", async () => {
    expect(await signIn("99", "1234")).toMatchObject({ ok: false, reason: "unknown_staff" });
    expect(await signIn("3", "0000")).toMatchObject({ ok: false, reason: "wrong_pin", tries_left: 2 });
    expect(await signIn("3", "3333")).toMatchObject({ ok: true }); // success resets the count
    expect(await signIn("3", "0000")).toMatchObject({ reason: "wrong_pin", tries_left: 2 });
  });

  it("locks the person after three wrong PINs, at sign-in or approval alike", async () => {
    await q("update profiles set failed_attempts = 0, locked_until = null where staff_code = '3'");
    await signIn("3", "1");
    await signIn("3", "2");
    expect(await signIn("3", "3")).toMatchObject({ ok: false, reason: "locked" });
    expect(await signIn("3", "3333")).toMatchObject({ ok: false, reason: "locked" });
    await q("update profiles set locked_until = null, failed_attempts = 0 where staff_code = '3'");
  });

  it("lets the owner approve on a cashier till with the PIN only, but nobody else", async () => {
    const approve = (code: string | null, pin: string) =>
      asUser(ids.cashier, () => rpc("verify_supervisor", [null, pin, "void", code])) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await approve("1", "9999")).toMatchObject({ ok: true, approver_role: "owner" });
    expect(await approve("2", "2222")).toMatchObject({ ok: false, reason: "badge_required" }); // supervisor still needs the badge
    expect(await approve("3", "3333")).toMatchObject({ ok: false, reason: "badge_required" });
    expect(await approve(null, "9999")).toMatchObject({ ok: false, reason: "badge_required" });
    expect(await approve("1", "0000")).toMatchObject({ ok: false, reason: "wrong_pin" });
  });

  it("recognises a supervisor badge before the PIN is typed", async () => {
    const check = (b: string) => asUser(ids.cashier, () => rpc("check_badge", [b])) as Promise<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(await check("SUP-0002")).toMatchObject({ ok: true, name: "Kamal (Supervisor)" });
    expect(await check("NOPE")).toMatchObject({ ok: false });
    expect(await check("")).toMatchObject({ ok: false });
  });

  it("keeps the internal PIN check away from clients", async () => {
    await expect(
      asUser(ids.cashier, () => q("select public.check_pin((select p from profiles p where staff_code = '3'), '3333')")),
    ).rejects.toThrow(/permission denied/);
  });

  it("requires a signed-in till", async () => {
    await expect(rpc("verify_staff_pin", ["3", "3333"])).rejects.toThrow();
  });

  it("tells the till the shop settings", async () => {
    const ctx = (await asUser(ids.cashier, () => rpc("get_till_context", []))) as { store: { name: string; bottle_fee_cents: number }; device: { role: string } };
    expect(ctx.store).toMatchObject({ name: "My Spice Shop", bottle_fee_cents: 10000 });
    expect(ctx.device.role).toBe("cashier");
  });
});

describe("archiving instead of deleting", () => {
  it("lets only the owner archive a product, and audits it", async () => {
    await expect(asUser(ids.cashier, () => rpc("archive_product", [ids["Cream Cracker"], "x"]))).rejects.toThrow(/only the owner/);
    await expect(asUser(ids.supervisor, () => rpc("archive_product", [ids["Cream Cracker"], "x"]))).rejects.toThrow(/only the owner/);
    await asUser(ids.owner, () => rpc("archive_product", [ids["Cream Cracker"], "Discontinued"]));
    const [p] = await q<{ is_active: boolean; archived_at: string | null }>("select is_active, archived_at from products where name = 'Cream Cracker'");
    expect(p.is_active).toBe(false);
    expect(p.archived_at).not.toBeNull();
    expect((await q("select 1 from audit_logs where action = 'product_archived'")).length).toBe(1);
  });

  it("blocks hard deletes of products and sales", async () => {
    await expect(q("delete from products where name = 'Cream Cracker'")).rejects.toThrow(/Hard delete/);
    await expect(q("delete from sales")).rejects.toThrow(/Hard delete/);
  });
});

describe("categories and packet sizes", () => {
  it("lets the owner create a category and reuses it on a second call", async () => {
    const first = (await asUser(ids.owner, () => rpc("save_category", ["Spices", 3]))) as { id: string; name: string };
    expect(first.name).toBe("Spices");
    const again = (await asUser(ids.owner, () => rpc("save_category", ["Spices", 7]))) as { id: string };
    expect(again.id).toBe(first.id);
    expect((await q("select 1 from categories where name = $1", ["Spices"])).length).toBe(1);
  });
  it("refuses an empty category name", async () => {
    await expect(asUser(ids.owner, () => rpc("save_category", ["   ", 0]))).rejects.toThrow(/name is required/);
  });
  it("refuses catalogue changes from a cashier", async () => {
    await expect(asUser(ids.cashier, () => rpc("save_category", ["Nope", 0]))).rejects.toThrow(/owner or a supervisor/);
  });
  it("gives a weighted product packet sizes the till can sell", async () => {
    const made = (await asUser(ids.owner, () =>
      rpc("save_product", [{ name: "Turmeric Powder", sale_mode: "weighted", price_cents: 0, kind: "trade" }]),
    )) as { id: string };
    await asUser(ids.owner, () =>
      rpc("save_pack_sizes", [made.id, [
        { weight_g: 100, price_cents: 9000 },
        { weight_g: 250, price_cents: 20000 },
      ]]),
    );
    const sizes = await q<{ weight_g: number; price_cents: string }>(
      "select weight_g, price_cents from pack_sizes where product_id = $1 and is_active order by weight_g",
      [made.id],
    );
    expect(sizes.map((x) => x.weight_g)).toEqual([100, 250]);
    // Stock is never typed in: a new packet starts empty and is filled by a movement.
    const [{ packets }] = await q<{ packets: string }>(
      "select packets_on_hand packets from pack_sizes where product_id = $1 limit 1",
      [made.id],
    );
    expect(Number(packets)).toBe(0);
  });
  it("retires a packet size that is dropped from the form instead of deleting it", async () => {
    const made = (await asUser(ids.owner, () =>
      rpc("save_product", [{ name: "Cinnamon Sticks", sale_mode: "weighted", price_cents: 0, kind: "trade" }]),
    )) as { id: string };
    await asUser(ids.owner, () => rpc("save_pack_sizes", [made.id, [{ weight_g: 100, price_cents: 5000 }, { weight_g: 200, price_cents: 9000 }]]));
    const before = await q<{ id: string }>("select id from pack_sizes where product_id = $1 and is_active", [made.id]);
    expect(before.length).toBe(2);
    await asUser(ids.owner, () => rpc("save_pack_sizes", [made.id, [{ id: before[0].id, weight_g: 100, price_cents: 5500 }]]));
    const active = await q<{ id: string }>("select id from pack_sizes where product_id = $1 and is_active", [made.id]);
    expect(active.length).toBe(1);
    expect((await q("select 1 from pack_sizes where product_id = $1", [made.id])).length).toBe(2);
  });
  it("rejects a packet with no weight", async () => {
    const made = (await asUser(ids.owner, () =>
      rpc("save_product", [{ name: "Cardamom", sale_mode: "weighted", price_cents: 0, kind: "trade" }]),
    )) as { id: string };
    await expect(
      asUser(ids.owner, () => rpc("save_pack_sizes", [made.id, [{ weight_g: 0, price_cents: 100 }]])),
    ).rejects.toThrow(/weight must be greater than zero/);
  });
});

describe("receiving stock", () => {
  it("adds to the existing count instead of overwriting it", async () => {
    const before = await stockOf("Marie Biscuit");
    await asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 10, 9000, "Kandy market", "Weekly run"]));
    expect(await stockOf("Marie Biscuit")).toBe(before + 10);
    // The same call again keeps adding: this is what makes restocking possible at all.
    await asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 5]));
    expect(await stockOf("Marie Biscuit")).toBe(before + 15);
  });
  it("records the movement with its cost, supplier and who did it", async () => {
    await asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 3, 12500, "Colombo supplier", "Top up"]));
    const [m] = await q<{ type: string; qty_change: string; unit_cost_cents: string; reason: string; created_by: string }>(
      "select type, qty_change, unit_cost_cents, reason, created_by from stock_movements where product_id = $1 order by created_at desc limit 1",
      [ids["Marie Biscuit"]],
    );
    expect(m.type).toBe("purchase");
    expect(Number(m.qty_change)).toBe(3);
    expect(Number(m.unit_cost_cents)).toBe(12500);
    expect(m.reason).toBe("Colombo supplier / Top up");
    expect(m.created_by).toBeTruthy();
  });
  it("receives into a packet, which is where a weighted product keeps its stock", async () => {
    const before = await packsOf();
    await asUser(ids.owner, () => rpc("receive_stock", [ids["Curry Powder"], ids.curry250, 12, 15000]));
    expect(await packsOf()).toBe(before + 12);
    // Receiving by weight must not touch the product-level count.
    expect(await stockOf("Curry Powder")).toBe(0);
  });
  it("refuses a weighted product received without a packet", async () => {
    await expect(
      asUser(ids.owner, () => rpc("receive_stock", [ids["Curry Powder"], null, 5])),
    ).rejects.toThrow(/which packet size/);
  });
  it("refuses a packet on a unit product", async () => {
    await expect(
      asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], ids.curry250, 5])),
    ).rejects.toThrow(/sold by unit/);
  });
  it("refuses zero, negative and negative-cost receipts", async () => {
    await expect(asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 0]))).rejects.toThrow(/greater than zero/);
    await expect(asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, -4]))).rejects.toThrow(/greater than zero/);
    await expect(asUser(ids.owner, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 1, -100]))).rejects.toThrow(/cannot be negative/);
  });
  it("refuses a cashier and an unknown product", async () => {
    await expect(asUser(ids.cashier, () => rpc("receive_stock", [ids["Marie Biscuit"], null, 5]))).rejects.toThrow(
      /owner or a supervisor/,
    );
    await expect(
      asUser(ids.owner, () => rpc("receive_stock", [crypto.randomUUID(), null, 5])),
    ).rejects.toThrow(/unknown product/);
  });
  it("clears the out-of-stock alert once the item is restocked", async () => {
    const made = (await asUser(ids.owner, () =>
      rpc("save_product", [{ name: "Restock Test", price_cents: 1000, reorder_level: 5, kind: "trade" }]),
    )) as { id: string };
    // A count below the reorder level raises the alert...
    await asUser(ids.owner, () => rpc("receive_stock", [made.id, null, 2]));
    const raised = await q(
      "select 1 from notifications where product_id = $1 and resolved_at is null and type = 'low_stock'",
      [made.id],
    );
    expect(raised.length).toBe(1);
    // ...and receiving enough to clear it resolves the alert.
    await asUser(ids.owner, () => rpc("receive_stock", [made.id, null, 20]));
    const [{ title: cleared }] = await q<{ title: string }>(
      "select title from notifications where product_id = $1 and resolved_at is not null order by id limit 1",
      [made.id],
    );
    expect(cleared).toContain("Restock Test");
    const still = await q(
      "select 1 from notifications where product_id = $1 and resolved_at is null and type in ('low_stock','out_of_stock')",
      [made.id],
    );
    expect(still.length).toBe(0);
  });
  it("shows the movement history to the owner but not to a cashier", async () => {
    const history = () =>
      q("select * from public.product_movements($1, $2)", [ids["Marie Biscuit"], 10]);
    const owner = await asUser(ids.owner, history);
    expect(owner.length).toBeGreaterThan(0);
    const cashier = await asUser(ids.cashier, history);
    expect(cashier.length).toBe(0);
  });
});

describe("adding a customer at the counter", () => {
  // The till used to insert name/phone/email only. store_id is NOT NULL and the insert policy checks
  // it against app_store_id(), so Postgres reported "new row violates row-level security policy"
  // rather than anything as useful as "store_id is required".
  it("reproduces the failure when store_id is omitted", async () => {
    await expect(
      asUser(ids.cashier, () =>
        q("insert into public.customers (name, phone) values ($1, $2) returning id", ["Nimal", "0771234567"]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it("lets a cashier add a customer with the store set", async () => {
    const [row] = await asUser(ids.cashier, () =>
      q<{ id: string; store_id: string }>(
        "insert into public.customers (store_id, name, phone) values (public.app_store_id(), $1, $2) returning id, store_id",
        ["Nimal Perera", "0771234567"],
      ),
    );
    expect(row.store_id).toBe(ids.store);
  });
  it("still refuses to add a customer into another shop", async () => {
    const [other] = await q<{ id: string }>(
      "insert into stores (name, owner_id) values ('Other shop', $1) returning id",
      [ids.owner],
    );
    await expect(
      asUser(ids.cashier, () =>
        q("insert into public.customers (store_id, name, phone) values ($1, $2, $3) returning id", [other.id, "X", "0779999999"]),
      ),
    ).rejects.toThrow(/row-level security/);
  });
  it("lets a cashier add the customer but not edit one afterwards", async () => {
    const [row] = await asUser(ids.cashier, () =>
      q<{ id: string }>(
        "insert into public.customers (store_id, name, phone) values (public.app_store_id(), $1, $2) returning id",
        ["Kasun", "0772222222"],
      ),
    );
    // RLS filters the row out of the UPDATE rather than raising, so nothing changes silently.
    await asUser(ids.cashier, () => q("update public.customers set phone = $1 where id = $2", ["0770000000", row.id]));
    const [after] = await q<{ phone: string }>("select phone from customers where id = $1", [row.id]);
    expect(after.phone).toBe("0772222222");
  });
  it("adds a customer through the RPC without the caller naming a store", async () => {
    const made = (await asUser(ids.cashier, () => rpc("add_customer", ["Sandya", "0714444444", "s@shop.test"]))) as {
      id: string;
      name: string;
      phone: string;
    };
    expect(made.name).toBe("Sandya");
    const [row] = await q<{ store_id: string; email: string }>("select store_id, email from customers where id = $1", [made.id]);
    expect(row.store_id).toBe(ids.store);
    expect(row.email).toBe("s@shop.test");
  });
  it("rejects a duplicate number in words the counter understands", async () => {
    await asUser(ids.cashier, () => rpc("add_customer", ["First", "0715555555"]));
    await expect(asUser(ids.cashier, () => rpc("add_customer", ["Second", "0715555555"]))).rejects.toThrow(
      /already belongs to another customer/,
    );
  });
  it("rejects a customer with no name or no number", async () => {
    await expect(asUser(ids.cashier, () => rpc("add_customer", ["  ", "0716666666"]))).rejects.toThrow(/name is required/);
    await expect(asUser(ids.cashier, () => rpc("add_customer", ["Someone", "  "]))).rejects.toThrow(/number is required/);
  });
  it("refuses an anonymous caller", async () => {
    await expect(q("select public.add_customer($1, $2, $3)", ["Anon", "0717777777", null])).rejects.toThrow(/not signed in/);
  });
});

describe("a sale made for a named customer", () => {
  async function customer(name: string, phone: string) {
    const made = (await asUser(ids.owner, () => rpc("add_customer", [name, phone, null]))) as { id: string };
    return made.id;
  }
  it("stores the customer on the receipt", async () => {
    const cust = await customer("Sandya Perera", "0771000001");
    const payload = salePayload({ customer_id: cust });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const [row] = await q<{ customer_id: string }>("select customer_id from sales where id = $1", [payload.id]);
    expect(row.customer_id).toBe(cust);
  });
  it("awards one point per LKR 100 spent", async () => {
    const cust = await customer("Points Test", "0771000002");
    // 59000 cents = LKR 590 -> 5 points, remainder not banked.
    const payload = salePayload({ customer_id: cust, subtotal_cents: 59000, total_cents: 59000 });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const [row] = await q<{ pts: string }>(
      "select coalesce(sum(points), 0) pts from customer_points where customer_id = $1",
      [cust],
    );
    expect(Number(row.pts)).toBe(5);
  });
  it("awards no points on a sale under LKR 100", async () => {
    const cust = await customer("Small Spender", "0771000003");
    const payload = salePayload({
      customer_id: cust,
      subtotal_cents: 9000,
      total_cents: 9000,
      bottle_fee_cents: 0,
      lines: [{ product_id: ids["Marie Biscuit"], kind: "item", name: "Marie Biscuit", qty: 1, unit_price_cents: 9000, tax_rate_pct: 0, tax_cents: 0, line_total_cents: 9000 }],
      payments: [{ method: "cash", amount_cents: 9000, tendered_cents: 9000, change_cents: 0 }],
    });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const [row] = await q<{ pts: string }>("select coalesce(sum(points), 0) pts from customer_points where customer_id = $1", [cust]);
    expect(Number(row.pts)).toBe(0);
  });
  it("does not mint a second lot of points when the till replays a sale", async () => {
    const cust = await customer("Replay Test", "0771000004");
    const payload = salePayload({ customer_id: cust });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const again = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]))) as { status: string };
    expect(again.status).toBe("duplicate");
    const [row] = await q<{ pts: string }>("select coalesce(sum(points), 0) pts from customer_points where customer_id = $1", [cust]);
    expect(Number(row.pts)).toBe(5);
  });
  it("still records a walk-in sale with no customer and no points", async () => {
    const payload = salePayload();
    const res = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]))) as { status: string };
    expect(res.status).toBe("created");
    const [row] = await q<{ customer_id: string | null }>("select customer_id from sales where id = $1", [payload.id]);
    expect(row.customer_id).toBeNull();
    expect((await q("select 1 from customer_points where sale_id = $1", [payload.id])).length).toBe(0);
  });
  it("refuses a customer from another shop", async () => {
    const [other] = await q<{ id: string }>("insert into stores (name, owner_id) values ('Other', $1) returning id", [ids.owner]);
    const [cust] = await q<{ id: string }>(
      "insert into customers (store_id, name, phone) values ($1, 'Foreign', '0771000005') returning id",
      [other.id],
    );
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(salePayload({ customer_id: cust.id }))])),
    ).rejects.toThrow(/unknown customer/);
  });
});
describe("receipt history for the dashboard", () => {
  it("lists the shop's receipts with customer, cashier and points", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["History Customer", "0771000006", null]))) as { id: string };
    const payload = salePayload({ customer_id: made.id });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const rows = await asUser(ids.owner, () =>
      q<{ receipt_no: number; customer_name: string | null; cashier_name: string | null; points_earned: number; total_cents: number }>(
        "select * from public.sale_history(null, null, null, 100, 0)",
      ),
    );
    const row = rows.find((r) => String(r.total_cents) === "59000");
    expect(row).toBeTruthy();
    expect(row!.customer_name).toBe("History Customer");
    expect(row!.cashier_name).toBeTruthy();
    expect(Number(row!.points_earned)).toBe(5);
  });
  it("searches by customer name", async () => {
    const rows = await asUser(ids.owner, () => q("select * from public.sale_history(null, null, $1, 100, 0)", ["History Customer"]));
    expect(rows.length).toBeGreaterThan(0);
  });
  it("shows a cashier nothing", async () => {
    const rows = await asUser(ids.cashier, () => q("select * from public.sale_history(null, null, null, 100, 0)"));
    expect(rows.length).toBe(0);
  });
  it("returns the lines of one receipt", async () => {
    const payload = salePayload();
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const lines = await asUser(ids.owner, () => q<{ name: string }>("select * from public.sale_detail($1)", [payload.id]));
    expect(lines.length).toBe(3);
  });
  it("shows each customer's balance and spend", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["Directory Person", "0771000007", null]))) as { id: string };
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(salePayload({ customer_id: made.id }))]));
    const dir = await asUser(ids.owner, () => q<{ name: string; points: number; visits: number }>("select * from public.customer_directory()"));
    const row = dir.find((d) => d.name === "Directory Person");
    expect(row).toBeTruthy();
    expect(Number(row!.points)).toBe(5);
    expect(Number(row!.visits)).toBe(1);
  });
});

describe("the customer gate at the start of a bill", () => {
  it("finds a registered number and shows points, spend, visits and bottles", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["Gate Customer", "0772000001", null]))) as { id: string };
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(salePayload({ customer_id: made.id }))]));
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0772000001"]))) as {
      id: string; name: string; points: number; spend_cents: number; visits: number; bottles_out: number;
    };
    expect(card.id).toBe(made.id);
    expect(card.name).toBe("Gate Customer");
    expect(Number(card.points)).toBe(5);
    expect(Number(card.visits)).toBe(1);
    expect(Number(card.spend_cents)).toBe(59000);
  });
  it("returns null for a number nobody has registered", async () => {
    const card = await asUser(ids.cashier, () => rpc("customer_card", ["0779999999"]));
    expect(card).toBeNull();
  });
  it("still finds the customer from a partial number, for a cashier reading it back", async () => {
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0001"]))) as { name: string } | null;
    expect(card?.name).toBe("Gate Customer");
  });
  it("prefers the exact number over a partial one", async () => {
    await asUser(ids.owner, () => rpc("add_customer", ["Partial Person", "0772001000", null]));
    // '2000' matches neither exactly; '0772000001' matches Gate Customer exactly.
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0772000001"]))) as { name: string };
    expect(card.name).toBe("Gate Customer");
  });
  it("lets a cashier read the card, because they are the one at the counter", async () => {
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0772000001"]))) as { name: string } | null;
    expect(card?.name).toBe("Gate Customer");
  });
  it("shows bottles a customer still has out", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["Bottle Holder", "0772000002", null]))) as { id: string };
    // one bottle sold, no empty returned: the gate must warn before the next sale
    const payload = salePayload({
      customer_id: made.id,
      subtotal_cents: 25000,
      total_cents: 25000,
      bottle_fee_cents: 0,
      bottles_returned: 0,
      lines: [{ product_id: ids["Fresh Milk (glass bottle)"], kind: "item", name: "Fresh Milk (glass bottle)", qty: 1, unit_price_cents: 25000, tax_rate_pct: 0, tax_cents: 0, line_total_cents: 25000 }],
      payments: [{ method: "cash", amount_cents: 25000, tendered_cents: 25000, change_cents: 0 }],
    });
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0772000002"]))) as { bottles_out: number };
    expect(Number(card.bottles_out)).toBe(1);
  });
});

describe("credit accounts", () => {
  async function withLimit(name: string, phone: string, limit: number) {
    const made = (await asUser(ids.owner, () => rpc("add_customer", [name, phone, null]))) as { id: string };
    await asUser(ids.owner, () => rpc("set_credit_terms", [made.id, limit, 30, false]));
    return made.id;
  }
  function creditSale(customerId: string, total = 59000) {
    return salePayload({ customer_id: customerId, subtotal_cents: total, total_cents: total, payments: [{ method: "credit", amount_cents: total }] });
  }
  it("refuses a tab for a customer with no limit", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["No Limit", "0773000001", null]))) as { id: string };
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(made.id))])),
    ).rejects.toThrow(/no credit limit/);
  });
  it("refuses a tab that would pass the limit", async () => {
    const id = await withLimit("Tight Limit", "0773000002", 50000);
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id, 59000))])),
    ).rejects.toThrow(/credit limit exceeded/);
  });
  it("refuses a credit sale with no customer at all", async () => {
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(salePayload({ payments: [{ method: "credit", amount_cents: 59000 }] }))])),
    ).rejects.toThrow(/needs a customer/);
  });
  it("refuses a blocked customer", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["Blocked", "0773000003", null]))) as { id: string };
    await asUser(ids.owner, () => rpc("set_credit_terms", [made.id, 100000, 30, true]));
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(made.id))])),
    ).rejects.toThrow(/blocked/);
  });
  it("puts the sale on the tab and leaves the balance outstanding", async () => {
    const id = await withLimit("Owing Customer", "0773000004", 100000);
    const res = (await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]))) as {
      status: string; credit_balance_cents: number;
    };
    expect(res.status).toBe("created");
    expect(Number(res.credit_balance_cents)).toBe(59000);
    const [row] = await q<{ amount_cents: string; due_on: string | null }>(
      "select amount_cents, due_on from customer_credit_entries where customer_id = $1",
      [id],
    );
    expect(Number(row.amount_cents)).toBe(59000);
    expect(row.due_on).not.toBeNull(); // 30-day terms
  });
  it("stops at the limit across several sales, not just one", async () => {
    const id = await withLimit("Running Tab", "0773000005", 100000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id, 59000))]));
    // 59000 + 59000 = 118000 > 100000
    await expect(
      asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id, 59000))])),
    ).rejects.toThrow(/credit limit exceeded/);
  });
  it("reduces the balance when the tab is settled", async () => {
    const id = await withLimit("Payer", "0773000006", 100000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]));
    const res = (await asUser(ids.owner, () => rpc("settle_credit", [id, 20000, "cash"]))) as { balance_cents: number };
    expect(Number(res.balance_cents)).toBe(39000);
  });
  it("refuses a settlement larger than the debt", async () => {
    const id = await withLimit("Overpayer", "0773000007", 100000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]));
    await expect(
      asUser(ids.owner, () => rpc("settle_credit", [id, 999999, "cash"])),
    ).rejects.toThrow(/exceeds the balance/);
  });
  it("refuses a cashier settling a tab", async () => {
    const id = await withLimit("Cashier Tries", "0773000008", 100000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]));
    await expect(
      asUser(ids.cashier, () => rpc("settle_credit", [id, 1000, "cash"])),
    ).rejects.toThrow(/owner or a supervisor/);
  });
  it("refuses a cashier opening a tab", async () => {
    const made = (await asUser(ids.owner, () => rpc("add_customer", ["No Terms", "0773000009", null]))) as { id: string };
    await expect(
      asUser(ids.cashier, () => rpc("set_credit_terms", [made.id, 100000, 0, false])),
    ).rejects.toThrow(/owner or a supervisor/);
  });
  it("lists who owes money, and drops them once they have paid", async () => {
    const id = await withLimit("On The Book", "0773000010", 100000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]));
    const book = await asUser(ids.owner, () =>
      q<{ name: string; balance_cents: string }>("select * from public.credit_book()"),
    );
    expect(book.find((b) => b.name === "On The Book")).toBeTruthy();
    await asUser(ids.owner, () => rpc("settle_credit", [id, 59000, "cash"]));
    const after = await asUser(ids.owner, () => q<{ name: string }>("select * from public.credit_book()"));
    expect(after.find((b) => b.name === "On The Book")).toBeUndefined();
  });
  it("shows the tab and limit on the gate card", async () => {
    const id = await withLimit("Card Customer", "0773000011", 75000);
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(creditSale(id))]));
    const card = (await asUser(ids.cashier, () => rpc("customer_card", ["0773000011"]))) as {
      credit_balance_cents: number; credit_limit_cents: number;
    };
    expect(Number(card.credit_balance_cents)).toBe(59000);
    expect(Number(card.credit_limit_cents)).toBe(75000);
  });
});
describe("the invoice kept with each sale", () => {
  it("is missing until one is attached", async () => {
    const payload = salePayload();
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    const pending = await asUser(ids.owner, () =>
      q<{ sales_needing_invoice: string }>("select * from public.sales_needing_invoice()"),
    );
    expect(pending.some((p) => p.sales_needing_invoice === payload.id)).toBe(true);
  });
  it("stores the document and stops asking for it", async () => {
    const payload = salePayload();
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    await asUser(ids.owner, () => rpc("attach_invoice", [payload.id, { receiptNo: 1, total: 59000 }]));
    const inv = (await asUser(ids.owner, () => rpc("sale_invoice", [payload.id]))) as { total: number };
    expect(Number(inv.total)).toBe(59000);
    const pending = await asUser(ids.owner, () => q<{ sales_needing_invoice: string }>("select * from public.sales_needing_invoice()"));
    expect(pending.some((p) => p.sales_needing_invoice === payload.id)).toBe(false);
  });
  it("never overwrites an invoice that already exists", async () => {
    const payload = salePayload();
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    await asUser(ids.owner, () => rpc("attach_invoice", [payload.id, { total: 111 }]));
    await asUser(ids.owner, () => rpc("attach_invoice", [payload.id, { total: 999 }]));
    const inv = (await asUser(ids.owner, () => rpc("sale_invoice", [payload.id]))) as { total: number };
    expect(Number(inv.total)).toBe(111);
  });
  it("hides the invoice from a cashier", async () => {
    const payload = salePayload();
    await asUser(ids.cashier, () => rpc("complete_sale", [JSON.stringify(payload)]));
    await asUser(ids.owner, () => rpc("attach_invoice", [payload.id, { total: 59000 }]));
    const inv = await asUser(ids.cashier, () => rpc("sale_invoice", [payload.id]));
    expect(inv).toBeNull();
  });
});
