import type { Cents } from "./money";
import { lineTotal, taxInside } from "./money";
import type { BillLine, BillSnapshot } from "./types";

/**
 * Glass-bottle milk: the bottle is a LOAN. It leaves the shop at LKR 250 with no deposit taken.
 * The customer owes the bottle back, and only pays this deposit on a later visit if they keep it.
 * Selling milk never adds it; F7 "Keep, charge" puts it on that later bill as a deposit row.
 */
export const BOTTLE_FEE: Cents = 10000;

export interface BillRow {
  key: string;
  kind: "item" | "voided" | "deposit";
  line?: BillLine;
  /** Set on a deposit row: the bottled product whose loan it settles. */
  depositProductId?: string;
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
  /** Deposits taken on this bill for bottles the customer keeps. Part of subtotal and total. */
  depositTotal: Cents;
}

export function bottleCount(lines: BillLine[]): number {
  return lines.reduce((n, l) => (!l.voided && l.returnableBottle ? n + l.qty : n), 0);
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

  // A discount is on the goods. It must not quietly eat into a deposit, which settles a debt.
  const discount = Math.min(snapshot.discount, subtotal);

  let depositTotal = 0;
  for (const d of snapshot.deposits ?? []) {
    if (d.qty <= 0) continue;
    const total = lineTotal(d.unitPrice, d.qty);
    depositTotal += total;
    rows.push({
      key: `deposit-${d.productId}`,
      kind: "deposit",
      depositProductId: d.productId,
      name: `Bottle deposit - ${d.name}`,
      qty: d.qty,
      unitPrice: d.unitPrice,
      total,
    });
  }
  subtotal += depositTotal;

  return {
    rows,
    subtotal,
    discount,
    total: subtotal - discount,
    taxIncluded,
    bottleCount: bottleCount(snapshot.lines),
    depositTotal,
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
