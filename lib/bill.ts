import type { Cents } from "./money";
import { lineTotal, taxInside } from "./money";
import type { BillLine, BillSnapshot } from "./types";

/** Glass-bottle milk: the customer returns an empty or LKR 100 is added (PLAN.md §4.8). */
export const BOTTLE_FEE: Cents = 10000;
export const BOTTLE_FEE_LABEL = "Bottle not returned";

export interface BillRow {
  key: string;
  kind: "item" | "voided" | "bottle_fee";
  line?: BillLine;
  name: string;
  label?: string;
  qty: number;
  unitPrice: Cents;
  total: Cents;
  note?: string;
}

export interface BillTotals {
  rows: BillRow[];
  subtotal: Cents;
  discount: Cents;
  total: Cents;
  taxIncluded: Cents;
  bottleCount: number;
  feeCount: number;
  feeAmount: Cents;
}

export function bottleCount(lines: BillLine[]): number {
  return lines.reduce((n, l) => (!l.voided && l.returnableBottle ? n + l.qty : n), 0);
}

/** Bottles still owing a fee after returns and supervisor waivers. */
export function feeCount(snapshot: BillSnapshot): number {
  return Math.max(0, bottleCount(snapshot.lines) - snapshot.bottlesReturned - snapshot.feeWaived);
}

export function computeBill(snapshot: BillSnapshot): BillTotals {
  const rows: BillRow[] = [];
  let subtotal = 0;
  let taxIncluded = 0;

  for (const line of snapshot.lines) {
    const total = lineTotal(line.unitPrice, line.qty);
    if (line.voided) {
      rows.push({
        key: line.id,
        kind: "voided",
        line,
        name: line.name,
        label: line.label,
        qty: line.qty,
        unitPrice: line.unitPrice,
        total,
        note: line.voided.reason,
      });
      continue;
    }
    subtotal += total;
    taxIncluded += taxInside(total, line.taxRate);
    rows.push({
      key: line.id,
      kind: "item",
      line,
      name: line.name,
      label: line.label,
      qty: line.qty,
      unitPrice: line.unitPrice,
      total,
    });
  }

  const owing = feeCount(snapshot);
  const feeAmount = owing * BOTTLE_FEE;
  if (owing > 0) {
    rows.push({
      key: "bottle-fee",
      kind: "bottle_fee",
      name: BOTTLE_FEE_LABEL,
      qty: owing,
      unitPrice: BOTTLE_FEE,
      total: feeAmount,
      note: "Locked",
    });
  }
  subtotal += feeAmount;

  const discount = Math.min(snapshot.discount, subtotal);
  return {
    rows,
    subtotal,
    discount,
    total: subtotal - discount,
    taxIncluded,
    bottleCount: bottleCount(snapshot.lines),
    feeCount: owing,
    feeAmount,
  };
}

let seq = 0;
export const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${seq++}`;

/** Add a product (or pack size) to the bill. Scanning the same item again raises its quantity. */
export function addLine(lines: BillLine[], incoming: Omit<BillLine, "id">): { lines: BillLine[]; id: string } {
  const existing = lines.find(
    (l) => !l.voided && l.productId === incoming.productId && l.packSizeId === incoming.packSizeId,
  );
  if (existing) {
    return {
      id: existing.id,
      lines: lines.map((l) => (l.id === existing.id ? { ...l, qty: l.qty + incoming.qty } : l)),
    };
  }
  const id = newId();
  return { id, lines: [...lines, { ...incoming, id }] };
}

/**
 * Supervisor-approved removal. Removes `qty` from an active line and records the removed part
 * as a struck-through line, so nothing silently disappears.
 */
export function voidQty(
  lines: BillLine[],
  lineId: string,
  qty: number,
  reason: string,
  by: string,
  at: number,
): BillLine[] {
  const target = lines.find((l) => l.id === lineId && !l.voided);
  if (!target || qty <= 0) return lines;
  const removed = Math.min(qty, target.qty);
  const voided: BillLine = { ...target, id: newId(), qty: removed, voided: { reason, by, at } };
  const remaining = target.qty - removed;
  const out: BillLine[] = [];
  for (const l of lines) {
    if (l.id !== lineId) {
      out.push(l);
      continue;
    }
    if (remaining > 0) out.push({ ...l, qty: remaining });
    out.push(voided);
  }
  return out;
}

export function activeLines(lines: BillLine[]): BillLine[] {
  return lines.filter((l) => !l.voided);
}
