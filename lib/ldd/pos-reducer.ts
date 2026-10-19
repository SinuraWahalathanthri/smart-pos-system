/**
 * The projection: ledger events folded into the state the UI reads.
 *
 * The reducer is pure and total. It must handle every registered event type, and it must throw on
 * an unknown type rather than skip it â€” a skipped event silently changes a stock count or a total,
 * which is worse than a visible failure.
 *
 * Nothing here mutates its input. State is rebuilt from events, so there is exactly one way for the
 * database to reach a given shape, and replaying the same events always reproduces it byte for byte.
 */

import type { Cents, LedgerEvent } from "./types";

/** `<productId>|<packSizeId>`, with an empty pack id for product-level stock. */
export type StockKey = string;

export const stockKey = (productId: string, packSizeId: string | null): StockKey =>
  `${productId}|${packSizeId ?? ""}`;

export interface PriceEntry {
  priceCents: Cents;
  taxRateBp: number;
}

export interface ProductState {
  productId: string;
  sku: string;
  name: string;
  categoryId: string;
  unitGrams: number | null;
  prices: Record<string, PriceEntry>;
}

export interface SaleLineState {
  lineId: string;
  productId: string;
  packSizeId: string | null;
  qty: number;
  voidedQty: number;
  refundedQty: number;
  unitPriceCents: Cents;
  taxRateBp: number;
  kind: "item" | "bottle_fee";
}

export interface SaleState {
  saleId: string;
  receiptNo: number;
  deviceId: string;
  cashierId: string;
  shiftId: string | null;
  lines: Record<string, SaleLineState>;
  lineOrder: string[];
  discountCents: Cents;
  tenderedCents: Cents;
  method: "cash" | "card" | "qr";
  occurredAt: string;
  recordedAt: string;
  seq: number;
}

export interface BottleState {
  /** Bottles sold and not yet accounted for. */
  outstanding: number;
  emptyReturned: number;
  feeChargedCents: Cents;
  feeCount: number;
}

export interface PosState {
  readonly products: Record<string, ProductState>;
  readonly stock: Record<StockKey, number>;
  readonly batches: Record<string, { batchNo: string; expiresOn: string | null; remaining: number }>;
  readonly sales: Record<string, SaleState>;
  readonly receipts: Record<number, string>;
  readonly bottles: BottleState;
  readonly appliedCommands: Record<string, number>;
}

export const emptyState = (): PosState => ({
  products: {},
  stock: {},
  batches: {},
  sales: {},
  receipts: {},
  bottles: { outstanding: 0, emptyReturned: 0, feeChargedCents: 0, feeCount: 0 },
  appliedCommands: {},
});

const bump = (s: Record<StockKey, number>, key: StockKey, delta: number) => ({
  ...s,
  [key]: (s[key] ?? 0) + delta,
});

/**
 * The reducer. `now`-dependent logic is deliberately absent: an event's `at`/`recordedAt` are carried
 * on the event, so replay never depends on when it happens.
 */
export function reduce(state: PosState, event: LedgerEvent): PosState {
  // Idempotency at the projection layer as well as the store: the same command never counts twice.
  if (state.appliedCommands[event.commandId] !== undefined) return state;
  const base: PosState = {
    ...state,
    appliedCommands: { ...state.appliedCommands, [event.commandId]: event.seq },
  };

  switch (event.type) {
    case "product.registered": {
      const p = event.payload as {
        productId: string;
        sku: string;
        name: string;
        categoryId: string;
        unitGrams: number | null;
      };
      const existing = base.products[p.productId];
      if (existing) {
        throw new Error(`product ${p.productId} registered twice`);
      }
      if (Object.values(base.products).some((x) => x.sku === p.sku)) {
        throw new Error(`SKU "${p.sku}" is already in use`);
      }
      return {
        ...base,
        products: {
          ...base.products,
          [p.productId]: { ...p, prices: {} },
        },
      };
    }

    case "product.priced": {
      const p = event.payload as {
        productId: string;
        packSizeId: string | null;
        priceCents: number;
        taxRateBp: number;
      };
      const product = base.products[p.productId];
      if (!product) throw new Error(`price set for unknown product ${p.productId}`);
      return {
        ...base,
        products: {
          ...base.products,
          [p.productId]: {
            ...product,
            prices: {
              ...product.prices,
              [p.packSizeId ?? ""]: { priceCents: p.priceCents, taxRateBp: p.taxRateBp },
            },
          },
        },
      };
    }

    case "stock.received": {
      const p = event.payload as {
        productId: string;
        packSizeId: string | null;
        qty: number;
        batchNo: string | null;
        expiresOn: string | null;
      };
      const next: PosState = { ...base, stock: bump(base.stock, stockKey(p.productId, p.packSizeId), p.qty) };
      if (!p.batchNo) return next;
      const batchId = `${p.productId}|${p.packSizeId ?? ""}|${p.batchNo}`;
      const prior = next.batches[batchId]?.remaining ?? 0;
      return {
        ...next,
        batches: {
          ...next.batches,
          [batchId]: { batchNo: p.batchNo, expiresOn: p.expiresOn, remaining: prior + p.qty },
        },
      };
    }

    case "stock.issued": {
      const p = event.payload as { productId: string; packSizeId: string | null; qty: number };
      const key = stockKey(p.productId, p.packSizeId);
      const onHand = base.stock[key] ?? 0;
      if (onHand < p.qty) throw new Error(`cannot issue ${p.qty} of ${key}: only ${onHand} on hand`);
      return { ...base, stock: bump(base.stock, key, -p.qty) };
    }

    case "stock.adjusted": {
      const p = event.payload as { productId: string; packSizeId: string | null; countedQty: number };
      const key = stockKey(p.productId, p.packSizeId);
      const onHand = base.stock[key] ?? 0;
      return { ...base, stock: bump(base.stock, key, p.countedQty - onHand) };
    }

    case "sale.completed": {
      const p = event.payload as {
        saleId: string;
        receiptNo: number;
        deviceId: string;
        cashierId: string;
        shiftId: string | null;
        discountCents: number;
        tenderedCents: number;
        method: "cash" | "card" | "qr";
        occurredAt: string;
        lines: {
          lineId: string;
          productId: string;
          packSizeId: string | null;
          qty: number;
          unitPriceCents: number;
          taxRateBp: number;
          kind: "item" | "bottle_fee";
        }[];
      };

      if (base.sales[p.saleId]) throw new Error(`sale ${p.saleId} completed twice`);
      if (base.receipts[p.receiptNo] !== undefined) {
        throw new Error(`receipt ${p.receiptNo} is already used by sale ${base.receipts[p.receiptNo]}`);
      }
      const ids = new Set(p.lines.map((l) => l.lineId));
      if (ids.size !== p.lines.length) throw new Error(`sale ${p.saleId} has duplicate line ids`);

      const lines: Record<string, SaleLineState> = {};
      for (const l of p.lines) {
        lines[l.lineId] = { ...l, voidedQty: 0, refundedQty: 0 };
      }

      let stock = base.stock;
      let bottles = base.bottles;
      for (const l of p.lines) {
        if (l.kind !== "item") continue;
        const key = stockKey(l.productId, l.packSizeId);
        if ((stock[key] ?? 0) < l.qty) {
          throw new Error(`cannot sell ${l.qty} of ${key}: only ${stock[key] ?? 0} on hand`);
        }
        stock = bump(stock, key, -l.qty);
        if (base.products[l.productId]?.name.includes("Milk")) {
          bottles = { ...bottles, outstanding: bottles.outstanding + l.qty };
        }
      }

      return {
        ...base,
        stock,
        bottles,
        sales: {
          ...base.sales,
          [p.saleId]: {
            saleId: p.saleId,
            receiptNo: p.receiptNo,
            deviceId: p.deviceId,
            cashierId: p.cashierId,
            shiftId: p.shiftId,
            lines,
            lineOrder: p.lines.map((l) => l.lineId),
            discountCents: p.discountCents,
            tenderedCents: p.tenderedCents,
            method: p.method,
            occurredAt: p.occurredAt,
            recordedAt: event.recordedAt,
            seq: event.seq,
          },
        },
        receipts: { ...base.receipts, [p.receiptNo]: p.saleId },
      };
    }

    case "sale.line_voided": {
      const p = event.payload as { saleId: string; lineId: string; qty: number };
      const sale = base.sales[p.saleId];
      if (!sale) throw new Error(`void for unknown sale ${p.saleId}`);
      const line = sale.lines[p.lineId];
      if (!line) throw new Error(`void for unknown line ${p.lineId}`);
      if (line.qty - line.voidedQty < p.qty) {
        throw new Error(`cannot void ${p.qty} of line ${p.lineId}: only ${line.qty - line.voidedQty} active`);
      }
      return {
        ...base,
        stock: line.kind === "item" ? bump(base.stock, stockKey(line.productId, line.packSizeId), p.qty) : base.stock,
        sales: {
          ...base.sales,
          [p.saleId]: {
            ...sale,
            lines: { ...sale.lines, [p.lineId]: { ...line, voidedQty: line.voidedQty + p.qty } },
          },
        },
      };
    }

    case "sale.refunded": {
      const p = event.payload as { saleId: string; lineId: string; qty: number; restock: boolean };
      const sale = base.sales[p.saleId];
      if (!sale) throw new Error(`refund for unknown sale ${p.saleId}`);
      const line = sale.lines[p.lineId];
      if (!line) throw new Error(`refund for unknown line ${p.lineId}`);
      const refundable = line.qty - line.voidedQty - line.refundedQty;
      if (refundable < p.qty) {
        throw new Error(`cannot refund ${p.qty} of line ${p.lineId}: only ${refundable} refundable`);
      }
      const restore = p.restock && line.kind === "item";
      return {
        ...base,
        stock: restore ? bump(base.stock, stockKey(line.productId, line.packSizeId), p.qty) : base.stock,
        sales: {
          ...base.sales,
          [p.saleId]: {
            ...sale,
            lines: { ...sale.lines, [p.lineId]: { ...line, refundedQty: line.refundedQty + p.qty } },
          },
        },
      };
    }

    case "bottle.returned": {
      const p = event.payload as { qty: number };
      const covered = Math.min(p.qty, base.bottles.outstanding);
      return {
        ...base,
        bottles: {
          ...base.bottles,
          outstanding: base.bottles.outstanding - covered,
          emptyReturned: base.bottles.emptyReturned + p.qty,
        },
      };
    }

    case "bottle.fee_charged": {
      const p = event.payload as { qty: number; feeUnitCents: number };
      return {
        ...base,
        bottles: {
          ...base.bottles,
          feeCount: base.bottles.feeCount + p.qty,
          feeChargedCents: base.bottles.feeChargedCents + p.qty * p.feeUnitCents,
        },
      };
    }

    default:
      // A projection that ignores an event is a projection that lies about money.
      throw new Error(`reducer has no handler for event type "${event.type}" â€” refusing to continue`);
  }
}

/* ------------------------------------------------------------- derivations */

/** Tax contained in a tax-inclusive gross amount, in integer cents. */
export const taxInside = (grossCents: Cents, rateBp: number): Cents =>
  rateBp <= 0 ? 0 : Math.round((grossCents * rateBp) / (10_000 + rateBp));

export interface SaleTotals {
  subtotalCents: Cents;
  bottleFeeCents: Cents;
  grossCents: Cents;
  discountCents: Cents;
  totalCents: Cents;
  taxIncludedCents: Cents;
  changeCents: Cents;
  activeLineCount: number;
}

/** Totals are derived, never stored: there is no column that can disagree with its own lines. */
export function saleTotals(sale: SaleState): SaleTotals {
  let subtotal = 0;
  let bottleFee = 0;
  let tax = 0;
  let active = 0;

  for (const id of sale.lineOrder) {
    const line = sale.lines[id];
    const qty = line.qty - line.voidedQty - line.refundedQty;
    if (qty <= 0) continue;
    active += 1;
    const amount = qty * line.unitPriceCents;
    if (line.kind === "bottle_fee") bottleFee += amount;
    else subtotal += amount;
    tax += taxInside(amount, line.taxRateBp);
  }

  const gross = subtotal + bottleFee;
  const discount = Math.min(sale.discountCents, gross);
  const total = gross - discount;
  return {
    subtotalCents: subtotal,
    bottleFeeCents: bottleFee,
    grossCents: gross,
    discountCents: discount,
    totalCents: total,
    taxIncludedCents: tax,
    changeCents: Math.max(0, sale.tenderedCents - total),
    activeLineCount: active,
  };
}

/** Stock on hand for one sellable unit. Absent key means zero, not unknown. */
export const onHand = (state: PosState, productId: string, packSizeId: string | null = null): number =>
  state.stock[stockKey(productId, packSizeId)] ?? 0;

/** Batches that still have stock, earliest expiry first â€” the FEFO queue. */
export function fefoQueue(state: PosState, productId: string, packSizeId: string | null = null) {
  const prefix = `${productId}|${packSizeId ?? ""}|`;
  return Object.entries(state.batches)
    .filter(([id, b]) => id.startsWith(prefix) && b.remaining > 0)
    .sort((a, b) => (a[1].expiresOn ?? "9999").localeCompare(b[1].expiresOn ?? "9999"))
    .map(([id, b]) => ({ id, ...b }));
}
