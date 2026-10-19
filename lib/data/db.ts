import Dexie, { type Table } from "dexie";
import type { HeldBill, Product, SaleRecord, Staff } from "../types";
import { isConnected } from "../supabase/client";
import { hashSecret } from "./auth";
import { DEMO_STAFF, seedProducts } from "./seed";

/**
 * Local-first store. The till reads and writes here, so it keeps selling offline.
 * Sales are queued with syncStatus "pending" until the Supabase sync (next phase) pushes them.
 */
export class PosDB extends Dexie {
  products!: Table<Product, string>;
  staff!: Table<Staff, string>;
  sales!: Table<SaleRecord, string>;
  held!: Table<HeldBill, string>;
  meta!: Table<{ key: string; value: unknown }, string>;

  constructor(name = "pos-db") {
    super(name);
    this.version(1).stores({
      products: "id, category, barcode, sku, active",
      staff: "id, code",
      sales: "id, receiptNo, createdAt, syncStatus",
      held: "id, createdAt",
      meta: "key",
    });
  }
}

let instance: PosDB | null = null;

/**
 * Client-only. Never call during server rendering.
 * Connected tills use their own database, so demo records can never mix with real shop data.
 */
export function getDb(): PosDB {
  if (typeof window === "undefined") throw new Error("Local database is only available in the browser");
  instance ??= new PosDB(isConnected() ? "pos-db-live" : "pos-db");
  return instance;
}

let seeding: Promise<void> | null = null;

/**
 * Demo mode only: loads the sample shop. When connected to Supabase the catalogue comes from the server.
 * Safe to call from several places at once (login page, till, React strict mode): runs once, uses put.
 */
export function ensureSeeded(): Promise<void> {
  if (isConnected()) return Promise.resolve();
  seeding ??= doSeed().catch((err) => {
    seeding = null; // allow a retry after a failure
    throw err;
  });
  return seeding;
}

async function doSeed(): Promise<void> {
  const db = getDb();
  if ((await db.products.count()) === 0) await db.products.bulkPut(seedProducts());
  if ((await db.staff.count()) === 0) {
    const rows: Staff[] = [];
    for (const d of DEMO_STAFF) {
      const salt = `salt-${d.staff.id}`;
      rows.push({
        ...d.staff,
        salt,
        pinHash: await hashSecret(salt, d.pin),
        badgeHash: d.badge ? await hashSecret(salt, d.badge) : undefined,
      });
    }
    await db.staff.bulkPut(rows);
  }
}

/** Wipe local demo data and reseed (used from settings during development). */
export async function resetDemoData(): Promise<void> {
  const db = getDb();
  await Promise.all([db.products.clear(), db.staff.clear(), db.sales.clear(), db.held.clear(), db.meta.clear()]);
  seeding = null;
  await ensureSeeded();
}

/**
 * Persist a completed sale and take its stock, in one transaction.
 * The receipt number comes from a local counter; the server assigns the official one on sync.
 */
export async function recordSale(sale: Omit<SaleRecord, "receiptNo" | "syncStatus">): Promise<SaleRecord> {
  const db = getDb();
  return db.transaction("rw", db.products, db.sales, db.meta, async () => {
    const seq = ((await db.meta.get("receiptSeq"))?.value as number | undefined) ?? 10000;
    const receiptNo = seq + 1;
    await db.meta.put({ key: "receiptSeq", value: receiptNo });

    for (const l of sale.lines) {
      if (l.kind !== "item") continue;
      const p = await db.products.get(l.productId);
      if (!p) continue;
      if (l.packSizeId) {
        p.packSizes = p.packSizes.map((ps) => (ps.id === l.packSizeId ? { ...ps, stock: ps.stock - l.qty } : ps));
      } else {
        p.stock -= l.qty;
      }
      await db.products.put(p);
    }

    const record: SaleRecord = { ...sale, receiptNo, syncStatus: "pending" };
    await db.sales.add(record);
    return record;
  });
}
