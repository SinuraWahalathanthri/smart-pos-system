/**
 * Time travel and explanation. Because state is a fold, "what did stock look like at 14:32?" and
 * "which events produced this total?" are the same operation: replay to a point and read.
 *
 * This is the capability that a mutable-row schema cannot offer without an audit table bolted on,
 * and even then the audit table is a second copy that can disagree with the live rows.
 */

import { reduce, type PosState } from "./pos-reducer";
import type { LedgerEvent } from "./types";

export interface TimelineEntry {
  seq: number;
  at: string;
  recordedAt: string;
  type: string;
  actor: string;
  commandId: string;
  hash: string;
  summary: string;
}

/** One line per event, for an operator reading what happened and in what order. */
export function timeline(events: LedgerEvent[]): TimelineEntry[] {
  return events.map((e) => ({
    seq: e.seq,
    at: e.at,
    recordedAt: e.recordedAt,
    type: e.type,
    actor: e.actor,
    commandId: e.commandId,
    hash: e.hash.slice(0, 12),
    summary: summarise(e),
  }));
}

function summarise(e: LedgerEvent): string {
  const p = e.payload as Record<string, unknown>;
  switch (e.type) {
    case "product.registered":
      return `registered ${String(p.sku)} "${String(p.name)}"`;
    case "product.priced":
      return `priced ${String(p.productId).slice(0, 8)} at ${String(p.priceCents)}c (${String(p.reason)})`;
    case "stock.received":
      return `received ${String(p.qty)} x ${String(p.productId).slice(0, 8)}${p.batchNo ? ` batch ${String(p.batchNo)}` : ""}`;
    case "stock.issued":
      return `issued ${String(p.qty)} (${String(p.reason)})`;
    case "stock.adjusted":
      return `counted ${String(p.countedQty)} (ledger said ${String(p.expectedQty)})`;
    case "sale.completed": {
      const lines = (p.lines as unknown[] | undefined)?.length ?? 0;
      return `sale #${String(p.receiptNo)} — ${lines} line(s), ${String(p.method)}, tendered ${String(p.tenderedCents)}c`;
    }
    case "sale.line_voided":
      return `voided ${String(p.qty)} of a line (${String(p.reason)})`;
    case "sale.refunded":
      return `refunded ${String(p.qty)} (${String(p.reason)}${p.restock ? ", restocked" : ""})`;
    case "bottle.returned":
      return `bottles returned: ${String(p.qty)}`;
    case "bottle.fee_charged":
      return `bottle fee charged on ${String(p.qty)}`;
    default:
      return e.type;
  }
}

/** State exactly as it stood after `seq`. Everything after is ignored, not undone. */
export function asOf(state: PosState, events: LedgerEvent[], seq: number): PosState {
  return events.filter((e) => e.seq <= seq).reduce(reduce, state);
}

/** State as it stood at a wall-clock instant, using business time (`at`), not record time. */
export function asOfBusinessTime(state: PosState, events: LedgerEvent[], at: string): PosState {
  const cutoff = new Date(at).getTime();
  return events.filter((e) => new Date(e.at).getTime() <= cutoff).reduce(reduce, state);
}

export interface StateDiff {
  key: string;
  before: unknown;
  after: unknown;
}

/** Field-level differences between two folds, so a reconciliation can be explained rather than guessed. */
export function diffState(a: PosState, b: PosState): StateDiff[] {
  const out: StateDiff[] = [];
  const keys = new Set([...Object.keys(a.stock), ...Object.keys(b.stock)]);
  for (const k of keys) {
    if ((a.stock[k] ?? 0) !== (b.stock[k] ?? 0)) {
      out.push({ key: `stock:${k}`, before: a.stock[k] ?? 0, after: b.stock[k] ?? 0 });
    }
  }
  const bottleFields = ["outstanding", "emptyReturned", "feeChargedCents", "feeCount"] as const;
  for (const f of bottleFields) {
    if (a.bottles[f] !== b.bottles[f]) {
      out.push({ key: `bottles.${f}`, before: a.bottles[f], after: b.bottles[f] });
    }
  }
  const aSales = Object.keys(a.sales).length;
  const bSales = Object.keys(b.sales).length;
  if (aSales !== bSales) out.push({ key: "sales.count", before: aSales, after: bSales });
  return out;
}

/** Why does this key have this value? The events that touched it, in order. */
export function explainKey(events: LedgerEvent[], key: string): TimelineEntry[] {
  const touches = (e: LedgerEvent): boolean => {
    if (key.startsWith("stock:")) {
      const [, rest] = key.split(":");
      const [productId, packSizeId = ""] = rest.split("|");
      const sameUnit = (p: { productId?: string; packSizeId?: string | null }) =>
        p.productId === productId && (p.packSizeId ?? "") === packSizeId;

      const p = e.payload as Record<string, unknown>;
      if (sameUnit(p as { productId?: string; packSizeId?: string | null })) return true;
      if (Array.isArray(p.lines)) {
        return (p.lines as { productId?: string; packSizeId?: string | null; kind?: string }[]).some(
          (l) => sameUnit(l) && l.kind !== "bottle_fee",
        );
      }
      return false;
    }
    if (key.startsWith("bottles.")) return e.type.startsWith("bottle.") || e.type === "sale.completed";
    return e.type.startsWith("sale.");
  };
  return timeline(events.filter(touches));
}
