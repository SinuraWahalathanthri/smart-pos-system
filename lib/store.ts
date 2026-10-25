"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { addLine, computeBill, newId, voidQty } from "./bill";
import type { Cents } from "./money";
import { isConnected } from "./supabase/client";
import type { BillLine, BillSnapshot, BottleDeposit, HeldBill, PackSize, Product, SaleRecord, Staff } from "./types";

export type SessionUser = Pick<Staff, "id" | "name" | "role" | "code">;

export type Dialog =
  | { type: "weight"; product: Product }
  | { type: "pay"; exact?: boolean }
  | { type: "search" }
  | { type: "palette" }
  | { type: "calc" }
  | { type: "help" }
  | { type: "held" }
  | { type: "qty" }
  | { type: "discount" }
  | { type: "customer" }
  | { type: "bottles" }
  | { type: "void"; lineId: string; approver: string }
  | { type: "success"; sale: SaleRecord; change: Cents }
  | null;

export interface CustomerCardState {
  id: string;
  name: string;
  points?: number;
  credit_balance_cents?: number;
  credit_limit_cents?: number;
  bottles_out?: number;
}
export interface Approval {
  description: string;
  resolve: (approver: SessionUser | null) => void;
}

export interface Toast {
  id: number;
  message: string;
  kind: "info" | "error" | "success" | "warn";
}

interface PosState extends BillSnapshot {
  session: SessionUser | null;
  locked: boolean;
  selectedId: string | null;
  lastAddedId: string | null;
  pendingQty: number;
  dialog: Dialog;
  approval: Approval | null;
  toast: Toast | null;
  /** True while the till is asking who the next sale is for, before the bill starts. */
  gating: boolean;
  setGating: (v: boolean) => void;
  /** Points, tab and bottles for the attached customer, shown on the bill. */
  customerPoints: number;
  customerCredit: number;
  customerLimit: number;
  customerBottles: number;
  setCustomerCard: (c: CustomerCardState | null) => void;

  login: (user: SessionUser) => void;
  logout: () => void;
  setLocked: (v: boolean) => void;
  openDialog: (d: Dialog) => void;
  closeDialog: () => void;
  notify: (message: string, kind?: Toast["kind"]) => void;
  requestApproval: (description: string) => Promise<SessionUser | null>;
  resolveApproval: (approver: SessionUser | null) => void;

  setPendingQty: (n: number) => void;
  addProduct: (p: Product, pack?: PackSize, qty?: number) => void;
  select: (id: string | null) => void;
  moveSelection: (dir: 1 | -1) => void;
  setQty: (lineId: string, qty: number) => void;
  nudgeQty: (lineId: string, delta: number) => void;
  voidLine: (lineId: string, qty: number, reason: string, by: string) => void;
  setDiscount: (cents: Cents) => void;
  attachCustomer: (c: { id: string; name: string } | null) => void;
  /** Refresh the count the bill shows after bottles are handed back at the counter. */
  setCustomerBottles: (n: number) => void;
  /** The customer keeps one more bottle and pays its deposit on this bill. */
  addDeposit: (d: Omit<BottleDeposit, "qty">) => void;
  /** Take one deposit back off the bill (nothing has been paid yet). */
  removeDeposit: (productId: string) => void;
  clearBill: () => void;
  snapshot: () => BillSnapshot;
  loadBill: (held: HeldBill) => void;
}

const emptyBill = (): BillSnapshot & { deposits: BottleDeposit[] } => ({ lines: [], deposits: [], discount: 0 });
let toastSeq = 0;

export const usePos = create<PosState>()(
  persist(
    (set, get) => ({
      ...emptyBill(),
      session: null,
      locked: false,
      // Always starts true and is never persisted, so every fresh page load asks again. A reload
      // mid-bill is protected by PosScreen requiring an empty bill before showing the gate, not by
      // remembering that it was dismissed.
      gating: true,
      selectedId: null,
      lastAddedId: null,
      pendingQty: 1,
      dialog: null,
      approval: null,
      toast: null,

      login: (user) => set({ session: user, locked: false, gating: true }),
      logout: () => set({ session: null, locked: false, ...emptyBill(), selectedId: null, dialog: null, gating: false }),
      setLocked: (v) => set({ locked: v, dialog: null }),
      openDialog: (d) => set({ dialog: d }),
      closeDialog: () => set({ dialog: null }),
      notify: (message, kind = "info") => set({ toast: { id: ++toastSeq, message, kind } }),

      requestApproval: (description) =>
        new Promise((resolve) => {
          // A second request replaces any open one (the earlier caller gets "declined").
          get().approval?.resolve(null);
          set({ approval: { description, resolve } });
        }),
      resolveApproval: (approver) => {
        const a = get().approval;
        set({ approval: null });
        a?.resolve(approver);
      },

      setPendingQty: (n) => set({ pendingQty: Math.max(1, Math.min(999, Math.floor(n))) }),

      addProduct: (p, pack, qty) => {
        const n = qty ?? get().pendingQty;
        const unitPrice = pack ? pack.price : p.price;
        const { lines, id } = addLine(get().lines, {
          productId: p.id,
          packSizeId: pack?.id,
          name: p.name,
          label: pack?.label,
          qty: n,
          unitPrice,
          taxRate: p.taxRate,
          returnableBottle: p.returnableBottle,
        });
        set({ lines, selectedId: id, lastAddedId: id, pendingQty: 1 });
      },

      select: (id) => set({ selectedId: id }),
      moveSelection: (dir) => {
        const active = get().lines.filter((l) => !l.voided);
        if (active.length === 0) return;
        const i = active.findIndex((l) => l.id === get().selectedId);
        const next = i === -1 ? (dir === 1 ? 0 : active.length - 1) : (i + dir + active.length) % active.length;
        set({ selectedId: active[next].id });
      },

      setQty: (lineId, qty) =>
        set({ lines: get().lines.map((l) => (l.id === lineId && !l.voided ? { ...l, qty: Math.max(1, qty) } : l)) }),
      nudgeQty: (lineId, delta) => {
        const line = get().lines.find((l) => l.id === lineId && !l.voided);
        if (!line) return;
        // Raising is free; lowering to zero would be a removal, which needs a supervisor.
        if (line.qty + delta < 1) {
          get().notify("To remove a line, press F8 (supervisor needed)", "warn");
          return;
        }
        get().setQty(lineId, line.qty + delta);
      },

      voidLine: (lineId, qty, reason, by) => {
        const lines = voidQty(get().lines, lineId, qty, reason, by, Date.now());
        const stillThere = lines.find((l) => l.id === lineId && !l.voided);
        const active = lines.filter((l) => !l.voided);
        set({
          lines,
          selectedId: stillThere ? lineId : (active[active.length - 1]?.id ?? null),
        });
      },

      setDiscount: (cents) => set({ discount: Math.max(0, cents) }),

      // A new bill belongs to a new customer: carrying the last one over would silently credit
      // someone else's points and bottles to the previous customer.
      clearBill: () =>
        set({
          ...emptyBill(),
          selectedId: null,
          lastAddedId: null,
          pendingQty: 1,
          customerId: undefined,
          customerName: undefined,
          customerPoints: 0,
          customerCredit: 0,
          customerLimit: 0,
          customerBottles: 0,
          gating: true,
        }),
      setGating: (v) => set({ gating: v }),
      customerPoints: 0,
      customerCredit: 0,
      customerLimit: 0,
      customerBottles: 0,
      setCustomerCard: (c) =>
        set({
          // A deposit settles one person's loan. Switching the bill to someone else must drop it,
          // or the next customer would pay for the previous one's bottle.
          ...(c?.id !== get().customerId ? { deposits: [] } : {}),
          customerId: c?.id,
          customerName: c?.name,
          customerPoints: c?.points ?? 0,
          customerCredit: c?.credit_balance_cents ?? 0,
          customerLimit: c?.credit_limit_cents ?? 0,
          customerBottles: c?.bottles_out ?? 0,
        }),
      attachCustomer: (c) =>
        set({
          ...(c?.id !== get().customerId ? { deposits: [] } : {}),
          customerId: c?.id,
          customerName: c?.name,
        }),
      // A return registered at the counter changes the count the bill shows immediately; the next
      // gate/customer lookup reads it from the database again anyway.
      setCustomerBottles: (n) => set({ customerBottles: Math.max(0, Math.round(n)) }),
      addDeposit: (d) => {
        const deposits = get().deposits ?? [];
        const existing = deposits.find((x) => x.productId === d.productId);
        set({
          deposits: existing
            ? deposits.map((x) => (x.productId === d.productId ? { ...x, qty: x.qty + 1 } : x))
            : [...deposits, { ...d, qty: 1 }],
        });
      },
      removeDeposit: (productId) =>
        set({
          deposits: (get().deposits ?? [])
            .map((x) => (x.productId === productId ? { ...x, qty: x.qty - 1 } : x))
            .filter((x) => x.qty > 0),
        }),
      snapshot: () => {
        const { lines, deposits, discount, customerId, customerName } = get();
        return { lines, deposits, discount, customerId, customerName };
      },
      loadBill: (held) =>
        set({
          lines: held.lines,
          deposits: held.deposits ?? [],
          discount: held.discount,
          customerId: held.customerId,
          customerName: held.customerName,
          selectedId: held.lines.find((l) => !l.voided)?.id ?? null,
        }),
    }),
    {
      // Demo and connected tills never share a saved session or bill (different staff ids).
      name: isConnected() ? "pos-session-live" : "pos-session",
      // v1 saved the gate's dismissed flag, which hid the customer prompt after every reload.
      // Bumping the version runs migrate() on the state already sitting in a till's storage.
      version: 2,
      migrate: (persisted, version) => (version < 2 ? dropSavedGating(persisted) : persisted),
      // The signed-in user and the bill in progress survive a refresh or a power cut.
      partialize: (s) => ({
        session: s.session,
        lines: s.lines,
        deposits: s.deposits,
        discount: s.discount,
        // Who the bill is for must survive a refresh too, or points and bottles would silently
        // land on the wrong person (or on nobody) after a power cut.
        customerId: s.customerId,
        customerName: s.customerName,
        customerPoints: s.customerPoints,
        customerCredit: s.customerCredit,
        customerLimit: s.customerLimit,
        customerBottles: s.customerBottles,
        // gating is deliberately NOT persisted. It describes whether the till has yet asked who
        // this bill is for, which is a per-visit question: saving "false" would mean the gate is
        // dismissed once and never appears again on any later reload.
      }),
    },
  ),
);

export const billTotals = (s: BillSnapshot) => computeBill(s);
/**
 * Remove a remembered gate dismissal from a saved till state.
 *
 * Older builds persisted `gating`, so a till that had once answered the customer prompt kept
 * `gating: false` on disk and stopped asking on every later reload. Dropping the key lets the
 * store fall back to its default, which asks. Pure, so the migration rule can be tested directly.
 */
export function dropSavedGating(persisted: unknown): Record<string, unknown> | null {
  if (!persisted || typeof persisted !== "object") return null;
  const { gating: _dropped, ...rest } = persisted as Record<string, unknown>;
  return rest;
}
/**
 * Whether the till should ask who this sale is for right now.
 *
 * Kept here rather than inline in PosScreen so the rule is testable: the gate is asked once per
 * visit, and only over an empty bill. That is what stops it reappearing when the page reloads
 * mid-sale or when a held bill is recalled - no remembered "dismissed" flag is needed.
 */
export function shouldOpenGate(s: {
  gating: boolean;
  session: unknown;
  locked: boolean;
  approval: unknown;
  dialog: unknown;
  lines: unknown[];
  customerId?: string;
  hydrated: boolean;
}): boolean {
  return (
    s.gating &&
    s.hydrated &&
    !!s.session &&
    !s.locked &&
    !s.approval &&
    !s.dialog &&
    s.lines.length === 0 &&
    !s.customerId
  );
}
export const heldId = newId;
export type { BillLine };
