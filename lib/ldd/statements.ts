/**
 * The three statement types that make a command specifiable without reading its implementation.
 *
 *   S1  Invariant    â€” true in every state, checked after every replay.
 *   S2  Precondition â€” must hold before a command may append; a failure aborts it.
 *   S3  Postconditionâ€” must hold in the state immediately after it appends; a failure rolls it back.
 *
 * Writing these first is the whole discipline: the command becomes "the thing that turns S2 into S3
 * without breaking S1", and the tests are then a transcription rather than an invention.
 */

import type { PosState } from "./pos-reducer";
import { saleTotals } from "./pos-reducer";
import type { Command, LedgerEvent } from "./types";
import { checkInvariants, errorsOnly, type Invariant, type Violation } from "./invariants";

export type Statement<T> = (x: T) => boolean | string;

export interface CommandSpec<P = unknown> {
  readonly type: string;
  readonly intent: string;
  /** S2: checked against the current state before appending. */
  readonly preconditions: Statement<{ state: PosState; command: Command<P> }>[];
  /** S3: checked against the next state. */
  readonly postconditions: Statement<{ before: PosState; after: PosState; command: Command<P>; event: LedgerEvent }>[];
  /** S1 additions specific to this command, beyond the global suite. */
  readonly invariants?: Invariant<PosState>[];
}

const named: Record<string, string> = {};

/** Describe a statement in words, so a failure message reads as an assertion rather than a boolean. */
export function nameStatement(key: string, label: string): string {
  named[key] = label;
  return label;
}

function runStatement<T>(s: Statement<T>, input: T): Violation[] {
  const result = s(input);
  if (result === true) return [];
  return [
    {
      invariant: "statement",
      severity: "error",
      message: typeof result === "string" ? result : "statement returned false",
    },
  ];
}

export function checkPreconditions<P>(
  spec: CommandSpec<P>,
  state: PosState,
  command: Command<P>,
): Violation[] {
  return spec.preconditions.flatMap((s) => runStatement(s, { state, command }));
}

export function checkPostconditions<P>(
  spec: CommandSpec<P>,
  before: PosState,
  after: PosState,
  command: Command<P>,
  event: LedgerEvent,
): Violation[] {
  return [
    ...spec.postconditions.flatMap((s) => runStatement(s, { before, after, command, event })),
    ...errorsOnly(checkInvariants(after, spec.invariants ?? [])),
  ];
}

/* ------------------------------------------------------------- POS specs */

const positive = (n: number) => Number.isInteger(n) && n > 0;

export const completeSaleSpec: CommandSpec = {
  type: "sale.completed",
  intent:
    "Record a paid bill. Stock leaves the ledger once; totals are derived from the lines and must reconcile.",
  preconditions: [
    ({ state, command }) => {
      const p = command.payload as {
        receiptNo: number;
        lines: { productId: string; packSizeId: string | null; qty: number; kind: string }[];
      };
      if (!positive(p.receiptNo)) return "receipt number must be a positive integer";
      if (state.receipts[p.receiptNo] !== undefined) {
        return `receipt ${p.receiptNo} is already issued`;
      }
      for (const l of p.lines) {
        if (!positive(l.qty)) return `line quantity ${l.qty} is not a positive integer`;
        if (!Number.isInteger(l.qty)) return `line quantity ${l.qty} must be whole units`;
        if (l.kind !== "item") continue;
        const key = `${l.productId}|${l.packSizeId ?? ""}`;
        const available = state.stock[key] ?? 0;
        if (available < l.qty) return `${key} has ${available} on hand but ${l.qty} are being sold`;
      }
      return true;
    },
  ],
  postconditions: [
    ({ after, command }) => {
      const p = command.payload as { saleId: string; receiptNo: number };
      if (!after.sales[p.saleId]) return "the sale was not recorded";
      if (after.receipts[p.receiptNo] !== p.saleId) return "the receipt was not registered to this sale";
      return true;
    },
    ({ after, command }) => {
      const p = command.payload as { saleId: string };
      const sale = after.sales[p.saleId];
      if (!sale) return true;
      const t = saleTotals(sale);
      if (t.activeLineCount === 0) return "a completed sale must keep at least one active line";
      return true;
    },
  ],
};

export const voidLineSpec: CommandSpec = {
  type: "sale.line_voided",
  intent: "Remove part of a bill before payment. The quantity returns to stock and the line is struck through.",
  preconditions: [
    ({ state, command }) => {
      const p = command.payload as { saleId: string; lineId: string; qty: number; approvedByStaffId: string };
      if (!p.approvedByStaffId) return "a void needs an approving supervisor";
      if (!positive(p.qty)) return "void quantity must be a positive integer";
      const line = state.sales[p.saleId]?.lines[p.lineId];
      if (!line) return `line ${p.lineId} is not on sale ${p.saleId}`;
      if (line.qty - line.voidedQty < p.qty) return `only ${line.qty - line.voidedQty} unit(s) remain active`;
      return true;
    },
  ],
  postconditions: [
    ({ before, after, command }) => {
      const p = command.payload as { saleId: string; lineId: string; qty: number };
      const b = before.sales[p.saleId].lines[p.lineId].voidedQty;
      const a = after.sales[p.saleId].lines[p.lineId].voidedQty;
      return a === b + p.qty || `voided quantity went from ${b} to ${a}, expected ${b + p.qty}`;
    },
    ({ before, after, command }) => {
      const p = command.payload as { saleId: string; lineId: string; qty: number };
      const line = after.sales[p.saleId].lines[p.lineId];
      if (line.kind !== "item") return true;
      const key = `${line.productId}|${line.packSizeId ?? ""}`;
      const delta = (after.stock[key] ?? 0) - (before.stock[key] ?? 0);
      return delta === p.qty || `stock changed by ${delta} but ${p.qty} were voided`;
    },
  ],
};

export const refundSpec: CommandSpec = {
  type: "sale.refunded",
  intent: "Return money for goods already sold. Restocking is explicit, because damaged goods must not go back on the shelf.",
  preconditions: [
    ({ state, command }) => {
      const p = command.payload as { saleId: string; lineId: string; qty: number; approvedByStaffId: string };
      if (!p.approvedByStaffId) return "a refund needs an approving supervisor";
      if (!positive(p.qty)) return "refund quantity must be a positive integer";
      const line = state.sales[p.saleId]?.lines[p.lineId];
      if (!line) return `line ${p.lineId} is not on sale ${p.saleId}`;
      const refundable = line.qty - line.voidedQty - line.refundedQty;
      if (refundable < p.qty) return `only ${refundable} unit(s) are refundable`;
      return true;
    },
  ],
  postconditions: [
    ({ before, after, command }) => {
      const p = command.payload as { saleId: string; lineId: string; qty: number; restock: boolean };
      const line = after.sales[p.saleId].lines[p.lineId];
      const key = `${line.productId}|${line.packSizeId ?? ""}`;
      const delta = (after.stock[key] ?? 0) - (before.stock[key] ?? 0);
      if (p.restock && line.kind === "item") {
        return delta === p.qty || `stock should have risen by ${p.qty}, it moved by ${delta}`;
      }
      return delta === 0 || `stock is not restocked on this refund, but it moved by ${delta}`;
    },
  ],
};

export const stockReceivedSpec: CommandSpec = {
  type: "stock.received",
  intent: "Goods arrive. Stock rises, and a batch is created when a best-before date is given.",
  preconditions: [
    ({ command }) => {
      const p = command.payload as { qty: number; unitCostCents: number };
      if (!positive(p.qty)) return "received quantity must be a positive integer";
      if (p.unitCostCents < 0) return "unit cost cannot be negative";
      return true;
    },
  ],
  postconditions: [
    ({ before, after, command }) => {
      const p = command.payload as { productId: string; packSizeId: string | null; qty: number };
      const key = `${p.productId}|${p.packSizeId ?? ""}`;
      const delta = (after.stock[key] ?? 0) - (before.stock[key] ?? 0);
      return delta === p.qty || `stock rose by ${delta}, expected ${p.qty}`;
    },
  ],
};

export const POS_SPECS: CommandSpec[] = [completeSaleSpec, voidLineSpec, refundSpec, stockReceivedSpec];

export const specFor = (type: string): CommandSpec | undefined => POS_SPECS.find((s) => s.type === type);


