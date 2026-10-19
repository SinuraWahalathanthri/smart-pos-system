import { create } from "zustand";
import type { PosDB } from "../data/db";
import { isAuthError, isNetworkError, type SbClient, type SbError } from "../supabase/client";
import { buildInvoice } from "../invoice";
import { applyUnsyncedSales, CATALOGUE_SELECT, mapProduct, toSalePayload, type ServerProductRow } from "./mappers";

/**
 * Local-first sync. The till always sells against local data; this moves sales up and the catalogue down.
 *  - Upload: each queued sale goes to complete_sale(). The server is idempotent on the sale id, so a retry
 *    after a dropped connection can never double-count.
 *  - Three kinds of failure: no connection (keep the queue, try later), expired sign-in (keep the queue,
 *    ask for the till to be signed in again), or the server refused that sale (mark it failed, carry on).
 *  - Download: catalogue and stock come from the server, minus sales the server has not seen yet.
 */

export type SyncState = "idle" | "syncing" | "offline" | "auth" | "error";

interface SyncStore {
  state: SyncState;
  lastSyncAt: number | null;
  message: string | null;
}

export const useSync = create<SyncStore>(() => ({ state: "idle", lastSyncAt: null, message: null }));

export interface PushResult {
  synced: number;
  failed: number;
  stopped: "offline" | "auth" | null;
}

const PAGE = 500;
const CATALOGUE_EVERY_MS = 5 * 60 * 1000;

/** Replace the local catalogue with the server's, keeping the effect of sales not yet uploaded. */
export async function pullCatalogue(client: SbClient, db: PosDB): Promise<number> {
  const rows: ServerProductRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await client.from("products").select(CATALOGUE_SELECT).range(from, from + PAGE - 1);
    if (error) throw Object.assign(new Error(error.message), { sb: error });
    const page = (data ?? []) as unknown as ServerProductRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  const unsynced = await db.sales.where("syncStatus").anyOf("pending", "failed").toArray();
  const products = applyUnsyncedSales(rows.map(mapProduct), unsynced);

  await db.transaction("rw", db.products, db.meta, async () => {
    await db.products.clear();
    await db.products.bulkPut(products);
    await db.meta.put({ key: "cataloguePulledAt", value: Date.now() });
  });
  return products.length;
}

/** Shop name and settings for the header and bill. */
export async function pullTillContext(client: SbClient, db: PosDB): Promise<void> {
  const { data, error } = await client.rpc("get_till_context");
  if (error) throw Object.assign(new Error(error.message), { sb: error });
  await db.meta.put({ key: "till", value: data });
}

function errorOf(e: unknown): SbError {
  const sb = (e as { sb?: SbError })?.sb;
  if (sb) return sb;
  return { message: e instanceof Error ? e.message : String(e) };
}

/** Upload queued sales, oldest first. */
export async function pushPendingSales(client: SbClient, db: PosDB): Promise<PushResult> {
  const queue = await db.sales.where("syncStatus").equals("pending").sortBy("createdAt");
  const result: PushResult = { synced: 0, failed: 0, stopped: null };

  for (const sale of queue) {
    let error: SbError | null = null;
    let data: unknown = null;
    try {
      ({ data, error } = await client.rpc("complete_sale", { p_sale: toSalePayload(sale) }));
    } catch (e) {
      error = errorOf(e);
    }

    if (!error) {
      const reply = data as {
        receipt_no?: number | string;
        points_earned?: number;
        credit_balance_cents?: number;
        customer_name?: string | null;
      } | null;
      const receipt = reply?.receipt_no;
      await db.sales.update(sale.id, {
        syncStatus: "synced",
        serverReceiptNo: receipt === undefined ? undefined : Number(receipt),
        syncError: undefined,
      });
      result.synced += 1;
      // The invoice is written once the server has accepted the sale, because only then are the
      // receipt number and the customer's real points/tab known. A failure here must not undo a
      // sale that is already safely recorded, so it is best-effort: the sale stays in
      // sales_needing_invoice() and is retried on the next cycle.
      try {
        await attachInvoice(client, db, sale.id, reply ?? null);
      } catch {
        // retried next cycle by backfillInvoices
      }
      continue;
    }

    if (isNetworkError(error)) {
      result.stopped = "offline";
      return result;
    }
    if (isAuthError(error)) {
      result.stopped = "auth";
      return result;
    }
    // The server understood and refused this sale. Park it so it cannot block the ones behind it.
    await db.sales.update(sale.id, { syncStatus: "failed", syncError: error.message });
    result.failed += 1;
  }
  return result;
}

/**
 * Write and store the frozen invoice for one sale. Uses the customer snapshot captured on the till
 * (points/tab before the sale) plus the server's reply (points/tab after), so the document is
 * internally consistent even if the customer shops again before the next sync.
 */
async function attachInvoice(
  client: SbClient,
  db: PosDB,
  saleId: string,
  reply: { points_earned?: number; credit_balance_cents?: number; customer_name?: string | null } | null,
): Promise<void> {
  const sale = await db.sales.get(saleId);
  if (!sale) return;
  const until = (await db.meta.get("till"))?.value as
    | { store?: { name?: string; address?: string | null; phone?: string | null; vat_no?: string | null } }
    | undefined;
  const snap = (await db.meta.get("customerSnap"))?.value as
    | { id: string; name?: string; phone?: string; points?: number; credit_balance_cents?: number; credit_limit_cents?: number }
    | null
    | undefined;
  const customer = sale.customerId
    ? {
        id: sale.customerId,
        name: reply?.customer_name ?? sale.customerName ?? snap?.name,
        phone: snap?.id === sale.customerId ? snap.phone : undefined,
        pointsBefore: snap?.id === sale.customerId ? (snap.points ?? 0) : 0,
        creditBefore: snap?.id === sale.customerId ? (snap.credit_balance_cents ?? 0) : 0,
        creditLimit: snap?.id === sale.customerId ? (snap.credit_limit_cents ?? 0) : 0,
      }
    : null;
  const pointsAfter = customer ? customer.pointsBefore + (reply?.points_earned ?? 0) : 0;
  const inv = buildInvoice(sale, {
    shop: {
      name: until?.store?.name ?? "Shop",
      address: until?.store?.address ?? undefined,
      phone: until?.store?.phone ?? undefined,
      vatNo: until?.store?.vat_no ?? undefined,
    },
    customer,
    after: customer ? { points: pointsAfter, creditCents: reply?.credit_balance_cents ?? customer.creditBefore } : null,
  });
  const { error } = await client.rpc("attach_invoice", { p_sale: saleId, p_invoice: inv });
  if (error) throw Object.assign(new Error(error.message), { sb: error });
  // Keep a local copy, so the till can reprint without the network.
  await db.meta.put({ key: `invoice:${saleId}`, value: inv });
}
/** Sales the server accepted while this till was shut, plus anything missed above. */
export async function backfillInvoices(client: SbClient, db: PosDB): Promise<number> {
  const { data, error } = await client.rpc("sales_needing_invoice");
  if (error) throw Object.assign(new Error(error.message), { sb: error });
  const ids = (data ?? []) as unknown as string[];
  let done = 0;
  for (const id of ids) {
    try {
      await attachInvoice(client, db, id, null);
      done += 1;
    } catch {
      // next cycle
    }
  }
  return done;
}
let running: Promise<void> | null = null;
let lastPullAt = 0;

/** One full cycle. Never runs twice at once. Pass force to refresh the catalogue now. */
export function runSync(client: SbClient, db: PosDB, opts: { force?: boolean } = {}): Promise<void> {
  running ??= cycle(client, db, !!opts.force).finally(() => {
    running = null;
  });
  return running;
}

async function cycle(client: SbClient, db: PosDB, force: boolean): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    useSync.setState({ state: "offline", message: "No internet connection" });
    return;
  }
  useSync.setState({ state: "syncing", message: null });
  try {
    const pushed = await pushPendingSales(client, db);
    if (pushed.stopped === "offline") return void useSync.setState({ state: "offline", message: "Server not reachable" });
    if (pushed.stopped === "auth") {
      return void useSync.setState({ state: "auth", message: "Till sign-in expired. Sign the till in again to sync." });
    }

    await backfillInvoices(client, db).catch(() => 0);
    const due = force || pushed.synced > 0 || Date.now() - lastPullAt > CATALOGUE_EVERY_MS;
    if (due) {
      await pullTillContext(client, db);
      await pullCatalogue(client, db);
      lastPullAt = Date.now();
    }
    useSync.setState({
      state: "idle",
      lastSyncAt: Date.now(),
      message: pushed.failed > 0 ? `${pushed.failed} sale(s) were refused by the server` : null,
    });
  } catch (e) {
    const err = errorOf(e);
    if (isNetworkError(err)) useSync.setState({ state: "offline", message: "Server not reachable" });
    else if (isAuthError(err)) useSync.setState({ state: "auth", message: "Till sign-in expired. Sign the till in again to sync." });
    else useSync.setState({ state: "error", message: err.message });
  }
}

/** Start background syncing; returns a function that stops it. */
export function startSync(client: SbClient, db: PosDB, everyMs = 30_000): () => void {
  let stopped = false;
  const go = (force = false) => {
    if (!stopped) void runSync(client, db, { force });
  };
  go(true);
  const timer = setInterval(() => go(), everyMs);
  const onOnline = () => go(true);
  if (typeof window !== "undefined") window.addEventListener("online", onOnline);
  return () => {
    stopped = true;
    clearInterval(timer);
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  };
}

/** Ask for a sync soon (e.g. right after a sale) without waiting for the timer. */
let nudge: ReturnType<typeof setTimeout> | null = null;
export function nudgeSync(client: SbClient, db: PosDB) {
  if (nudge) clearTimeout(nudge);
  nudge = setTimeout(() => void runSync(client, db), 400);
}

/** Reset module state (tests). */
export function _resetSyncForTests() {
  running = null;
  lastPullAt = 0;
  useSync.setState({ state: "idle", lastSyncAt: null, message: null });
}
