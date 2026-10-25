import { computeBill } from "./bill";
import { taxInside, type Cents } from "./money";
import type { BillSnapshot, PayMethod, SaleLine, SaleRecord } from "./types";
import { newId } from "./bill";

export interface PaymentInput {
  method: PayMethod;
  tendered?: Cents;
  ref?: string;
}

/** Turn the bill on screen into the record that is stored (and later synced). */
export function buildSale(
  snapshot: BillSnapshot,
  cashier: { id: string; name: string },
  payment: PaymentInput,
  now = Date.now(),
): { sale: Omit<SaleRecord, "receiptNo" | "syncStatus">; change: Cents } {
  const bill = computeBill(snapshot);
  const lines: SaleLine[] = [];
  const voidedLines: SaleRecord["voidedLines"] = [];

  for (const r of bill.rows) {
    if (r.kind !== "item" || !r.line) continue;
    lines.push({
      productId: r.line.productId,
      packSizeId: r.line.packSizeId,
      name: r.line.name,
      label: r.line.label,
      qty: r.line.qty,
      unitPrice: r.line.unitPrice,
      taxRate: r.line.taxRate,
      lineTotal: r.total,
      taxAmount: taxInside(r.total, r.line.taxRate),
      kind: "item",
    });
  }

  // A deposit names the bottle it is for, so the server can settle exactly that loan.
  for (const r of bill.rows) {
    if (r.kind !== "deposit" || !r.depositProductId) continue;
    lines.push({
      productId: r.depositProductId,
      name: r.name,
      qty: r.qty,
      unitPrice: r.unitPrice,
      taxRate: 0,
      lineTotal: r.total,
      taxAmount: 0,
      kind: "bottle_fee",
    });
  }

  for (const r of bill.rows) {
    if (r.kind !== "voided" || !r.line?.voided) continue;
    voidedLines.push({
      productId: r.line.productId,
      packSizeId: r.line.packSizeId,
      name: r.name,
      label: r.label,
      qty: r.qty,
      unitPrice: r.unitPrice,
      reason: r.line.voided.reason,
      by: r.line.voided.by,
    });
  }

  const tendered = payment.method === "cash" ? (payment.tendered ?? bill.total) : undefined;
  const change = tendered !== undefined ? Math.max(0, tendered - bill.total) : 0;

  return {
    change,
    sale: {
      id: newId(),
      createdAt: now,
      cashierId: cashier.id,
      cashierName: cashier.name,
      lines,
      voidedLines,
      subtotal: bill.subtotal,
      discount: bill.discount,
      total: bill.total,
      taxIncluded: bill.taxIncluded,
      // Empties are registered per customer by F7 (return_bottles), not counted on the bill: an
      // empty handed back settles an earlier loan, and a bottle taken now starts a new one.
      bottlesReturned: 0,
      // Selling a bottle takes no deposit. A deposit on this bill is for a bottle the customer
      // keeps from an earlier loan; the server recomputes this from the lines anyway.
      bottleFeeCharged: bill.depositTotal,
      customerId: snapshot.customerId,
      customerName: snapshot.customerName,
      payments: [{ method: payment.method, amount: bill.total, tendered, change: tendered !== undefined ? change : undefined, ref: payment.ref }],
    },
  };
}
