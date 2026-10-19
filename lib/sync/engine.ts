import { create } from "zustand";
import type { PosDB } from "../data/db";
import { isAuthError, isNetworkError, type SbClient, type SbError } from "../supabase/client";
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
      const receipt = (data as { receipt_no?: number | string } | null)?.receipt_no;
      await db.sales.update(sale.id, {
        syncStatus: "synced",
        serverReceiptNo: receipt === undefined ? undefined : Number(receipt),
        syncError: undefined,
      });
      result.synced += 1;
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
