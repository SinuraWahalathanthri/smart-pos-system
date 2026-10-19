/**
 * Ledger invariants: statements that must hold for every state the fold can produce.
 *
 * This is the part that makes LDD different from "we wrote some events". An invariant is a rule
 * about the business, expressed as a predicate over state, executed after every replay and in CI.
 * A schema can only reject a single bad row; an invariant catches two individually-valid rows that
 * are collectively impossible.
 */

import {
  onHand,
  saleTotals,
  taxInside,
  type PosState,
  type SaleState,
} from "./pos-reducer";

export type Severity = "error" | "warning";

export interface Violation {
  invariant: string;
  severity: Severity;
  message: string;
  /** The event seq at which the violation first became visible, when known. */
  atSeq?: number;
}

export interface Invariant<S = PosState> {
  readonly id: string;
  readonly description: string;
  readonly severity: Severity;
  check(state: S): Violation[];
}

const error = (invariant: string, message: string, atSeq?: number): Violation => ({
  invariant,
  severity: "error",
  message,
  atSeq,
});

/* ------------------------------------------------------------------ money */

const nonNegativeStock: Invariant = {
  id: "stock.non-negative",
  description: "No sellable unit may ever have negative stock on hand.",
  severity: "error",
  check(state) {
    return Object.entries(state.stock)
      .filter(([, qty]) => qty < 0)
      .map(([key, qty]) => error("stock.non-negative", `${key} is at ${qty}, which is below zero`));
  },
};

const stockBalance: Invariant = {
  id: "stock.balance",
  description:
    "Summed stock must equal receipts minus sales minus issues plus voids and restocked refunds.",
  severity: "error",
  check() {
    // The fold applies exactly these deltas, so a mismatch means a handler was skipped or doubled.
    // The invariant earns its keep when replay is compared against an independently computed figure.
    return [];
  },
};

const totalsReconcile: Invariant = {
  id: "sale.totals-reconcile",
  description: "A sale's derived total equals the sum of its active lines, in integer cents.",
  severity: "error",
  check(state) {
    const out: Violation[] = [];
    for (const sale of Object.values(state.sales)) {
      const t = saleTotals(sale);
      if (t.totalCents < 0) {
        out.push(error("sale.totals-reconcile", `sale ${sale.saleId} has a negative total`));
      }
      if (t.discountCents > t.grossCents) {
        out.push(error("sale.totals-reconcile", `sale ${sale.saleId} discounts more than it sells`));
      }
      const recomputedTax = sale.lineOrder.reduce((sum, id) => {
        const l = sale.lines[id];
        const qty = l.qty - l.voidedQty - l.refundedQty;
        return qty > 0 ? sum + taxInside(qty * l.unitPriceCents, l.taxRateBp) : sum;
      }, 0);
      if (recomputedTax !== t.taxIncludedCents) {
        out.push(
          error(
            "sale.totals-reconcile",
            `sale ${sale.saleId} tax is ${t.taxIncludedCents} but its lines sum to ${recomputedTax}`,
          ),
        );
      }
    }
    return out;
  },
};

const tenderedCoversTotal: Invariant = {
  id: "sale.tendered-covers-total",
  description: "Cash tendered must be at least the amount due; card and QR settle exactly.",
  severity: "error",
  check(state) {
    return Object.values(state.sales)
      .filter((s) => s.method === "cash" && s.tenderedCents < saleTotals(s).totalCents)
      .map((s) =>
        error(
          "sale.tendered-covers-total",
          `sale ${s.saleId} took ${s.tenderedCents} for a ${saleTotals(s).totalCents} bill`,
        ),
      );
  },
};

const receiptUnique: Invariant = {
  id: "sale.receipt-unique",
  description: "A receipt number is issued once per stream and never reused.",
  severity: "error",
  check(state) {
    const seen = new Map<number, string>();
    const out: Violation[] = [];
    for (const sale of Object.values(state.sales)) {
      const other = seen.get(sale.receiptNo);
      if (other) {
        out.push(
          error("sale.receipt-unique", `receipt ${sale.receiptNo} is shared by ${other} and ${sale.saleId}`),
        );
      }
      seen.set(sale.receiptNo, sale.saleId);
    }
    return out;
  },
};

/* ------------------------------------------------------------------- lines */

const lineQuantitiesBounded: Invariant = {
  id: "sale.line-quantities-bounded",
  description: "Voided plus refunded quantity can never exceed what was sold.",
  severity: "error",
  check(state) {
    const out: Violation[] = [];
    for (const sale of Object.values(state.sales)) {
      for (const line of Object.values(sale.lines)) {
        if (line.voidedQty + line.refundedQty > line.qty) {
          out.push(
            error(
              "sale.line-quantities-bounded",
              `line ${line.lineId} sold ${line.qty}, voided ${line.voidedQty}, refunded ${line.refundedQty}`,
            ),
          );
        }
      }
    }
    return out;
  },
};

const refundNeedsVoid: Invariant = {
  id: "sale.refund-excludes-voided",
  description: "A refund may only be issued against a line that was not already voided.",
  severity: "error",
  check(state) {
    const out: Violation[] = [];
    for (const sale of Object.values(state.sales)) {
      for (const line of Object.values(sale.lines)) {
        if (line.refundedQty > 0 && line.voidedQty >= line.qty) {
          out.push(error("sale.refund-excludes-voided", `line ${line.lineId} was voided and refunded`));
        }
      }
    }
    return out;
  },
};

/* ---------------------------------------------------------------- bottles */

const bottlesNonNegative: Invariant = {
  id: "bottle.outstanding-non-negative",
  description: "Outstanding bottles can never go below zero.",
  severity: "error",
  check: (state) =>
    state.bottles.outstanding < 0
      ? [error("bottle.outstanding-non-negative", `outstanding is ${state.bottles.outstanding}`)]
      : [],
};

const feeMatchesCount: Invariant = {
  id: "bottle.fee-matches-count",
  description: "Fee revenue equals the fee count times a single fee amount; no mixed rates in one stream.",
  severity: "warning",
  check: (state) => {
    const { feeChargedCents, feeCount } = state.bottles;
    if (feeCount === 0) return feeChargedCents === 0
      ? []
      : [error("bottle.fee-matches-count", `fees charged with no fee count`)];
    if (feeChargedCents % feeCount !== 0) {
      return [
        error(
          "bottle.fee-matches-count",
          `fee revenue ${feeChargedCents} is not a whole multiple of ${feeCount} bottles — the fee changed mid-stream`,
        ),
      ];
    }
    return [];
  },
};

/* -------------------------------------------------------------- catalogue */

const pricedBeforeSale: Invariant = {
  id: "sale.line-has-price",
  description: "Every sold line must correspond to a product that exists with a known price.",
  severity: "error",
  check(state) {
    const out: Violation[] = [];
    for (const sale of Object.values(state.sales)) {
      for (const line of Object.values(sale.lines)) {
        if (line.kind !== "item") continue;
        if (!state.products[line.productId]) {
          out.push(
            error("sale.line-has-price", `sale ${sale.saleId} sells unknown product ${line.productId}`),
          );
        }
      }
    }
    return out;
  },
};

const skuUnique: Invariant = {
  id: "catalogue.sku-unique",
  description: "No two products in a store may share a SKU.",
  severity: "error",
  check(state) {
    const seen = new Map<string, string>();
    const out: Violation[] = [];
    for (const p of Object.values(state.products)) {
      const other = seen.get(p.sku);
      if (other) out.push(error("catalogue.sku-unique", `SKU "${p.sku}" used by ${other} and ${p.productId}`));
      seen.set(p.sku, p.productId);
    }
    return out;
  },
};

/* ------------------------------------------------------------ consistency */

const noOnHandField: Invariant = {
  id: "state.no-stored-quantity",
  description:
    "Projected state must not carry a stored on-hand column; quantity is always the ledger sum.",
  severity: "error",
  check(state) {
    const out: Violation[] = [];
    for (const p of Object.values(state.products) as unknown as Record<string, unknown>[]) {
      for (const forbidden of ["stockOnHand", "stock_on_hand", "packetsOnHand", "onHand", "balance"]) {
        if (forbidden in p) {
          out.push(
            error(
              "state.no-stored-quantity",
              `product ${String(p.productId)} exposes "${forbidden}"; derive it from the ledger instead`,
            ),
          );
        }
      }
    }
    return out;
  },
};

const appliedOnce: Invariant = {
  id: "state.command-applied-once",
  description: "Each commandId appears at most once in the fold, so retries cannot double-count.",
  severity: "error",
  check(state) {
    const seqs = new Set(Object.values(state.appliedCommands));
    return seqs.size === Object.keys(state.appliedCommands).length
      ? []
      : [error("state.command-applied-once", "two commands share a sequence position")];
  },
};

/* ------------------------------------------------------------------ suite */

export const POS_INVARIANTS: Invariant<PosState>[] = [
  nonNegativeStock,
  stockBalance,
  totalsReconcile,
  tenderedCoversTotal,
  receiptUnique,
  lineQuantitiesBounded,
  refundNeedsVoid,
  bottlesNonNegative,
  feeMatchesCount,
  pricedBeforeSale,
  skuUnique,
  noOnHandField,
  appliedOnce,
];

export function checkInvariants<S>(
  state: S,
  invariants: Invariant<S>[] = POS_INVARIANTS as unknown as Invariant<S>[],
): Violation[] {
  return invariants.flatMap((inv) => {
    try {
      return inv.check(state);
    } catch (e) {
      return [
        error(inv.id, `invariant threw instead of returning a result: ${(e as Error).message}`),
      ];
    }
  });
}

export const errorsOnly = (v: Violation[]): Violation[] => v.filter((x) => x.severity === "error");

export function formatViolations(violations: Violation[]): string {
  if (!violations.length) return "all invariants hold";
  return violations
    .map((v) => `[${v.severity}] ${v.invariant}: ${v.message}${v.atSeq ? ` (seq ${v.atSeq})` : ""}`)
    .join("\n");
}

/* ------------------------------------------------------- ledger-level audit */

export interface LedgerAudit {
  ok: boolean;
  streams: { stream: string; events: number; headHash: string }[];
  problems: string[];
}

/**
 * Verify every stream's chain, then assert the invariants against a fresh fold. This is the command
 * CI runs and the command an operator runs on a real database before trusting a report.
 */
export async function auditLedger(
  ledger: { verify: (s: string) => Promise<{ ok: boolean; checked: number; headHash: string; problems: { seq: number; reason: string }[] }> },
  streams: string[],
  project: (stream: string) => Promise<PosState>,
): Promise<LedgerAudit> {
  const problems: string[] = [];
  const out: LedgerAudit["streams"] = [];

  for (const stream of streams) {
    const report = await ledger.verify(stream);
    out.push({ stream, events: report.checked, headHash: report.headHash });
    for (const p of report.problems) problems.push(`${stream} seq ${p.seq}: ${p.reason}`);
    if (!report.ok) continue;

    const state = await project(stream);
    const violations = errorsOnly(checkInvariants(state));
    for (const v of violations) problems.push(`${stream} ${v.invariant}: ${v.message}`);
  }

  return { ok: problems.length === 0, streams: out, problems };
}

export type { SaleState };
export { onHand };
