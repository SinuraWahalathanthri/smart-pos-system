"use client";

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { addLine, computeBill, newId, voidQty, bottleCount } from "./bill";
import type { Cents } from "./money";
import { isConnected } from "./supabase/client";
import type { BillLine, BillSnapshot, HeldBill, PackSize, Product, SaleRecord, Staff } from "./types";

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
  returnBottle: (delta: 1 | -1) => void;
  waiveFee: () => void;
  setDiscount: (cents: Cents) => void;
  attachCustomer: (c: { id: string; name: string } | null) => void;
  clearBill: () => void;
  snapshot: () => BillSnapshot;
  loadBill: (held: HeldBill) => void;
}

const emptyBill = (): BillSnapshot => ({ lines: [], bottlesReturned: 0, feeWaived: 0, discount: 0 });
let toastSeq = 0;

export const usePos = create<PosState>()(
  persist(
    (set, get) => ({
      ...emptyBill(),
      session: null,
      locked: false,
      // Defaults to asking; persist() overrides this with whatever the till was doing, so a reload
      // mid-bill keeps that bill and is not re-asked. get() is not available while the store is
      // still being created, which is why this cannot be derived from lines here.
      gating: true,
      selectedId: null,
      lastAddedId: null,
      pendingQty: 1,
      dialog: null,
      approval: null,
      toast: null,

      login: (user) => set({ session: user, locked: false, gating: !get().lines.length }),
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
        // Returned empties can't exceed the milk still on the bill.
        const bottles = bottleCount(lines);
        const s = get();
        if (s.bottlesReturned > bottles) set({ bottlesReturned: bottles });
        if (s.bottlesReturned + s.feeWaived > bottles) {
          set({ feeWaived: Math.max(0, bottles - get().bottlesReturned) });
        }
      },

      returnBottle: (delta) => {
        const s = get();
        const bottles = bottleCount(s.lines);
        const next = s.bottlesReturned + delta;
        if (next < 0) return;
        if (next > bottles) {
          s.notify("No more milk bottles on this bill to cover", "warn");
          return;
        }
        set({ bottlesReturned: next });
      },
      waiveFee: () => set({ feeWaived: get().feeWaived + 1 }),
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
          gating: true,
        }),
      setGating: (v) => set({ gating: v }),
      attachCustomer: (c) =>
        set({ customerId: c?.id, customerName: c?.name }),
      snapshot: () => {
        const { lines, bottlesReturned, feeWaived, discount, customerId, customerName } = get();
        return { lines, bottlesReturned, feeWaived, discount, customerId, customerName };
      },
      loadBill: (held) =>
        set({
          lines: held.lines,
          bottlesReturned: held.bottlesReturned,
          feeWaived: held.feeWaived,
          discount: held.discount,
          customerId: held.customerId,
          customerName: held.customerName,
          selectedId: held.lines.find((l) => !l.voided)?.id ?? null,
        }),
    }),
    {
      // Demo and connected tills never share a saved session or bill (different staff ids).
      name: isConnected() ? "pos-session-live" : "pos-session",
      // The signed-in user and the bill in progress survive a refresh or a power cut.
      partialize: (s) => ({
        session: s.session,
        lines: s.lines,
        bottlesReturned: s.bottlesReturned,
        feeWaived: s.feeWaived,
        discount: s.discount,
        // Who the bill is for must survive a refresh too, or points and bottles would silently
        // land on the wrong person (or on nobody) after a power cut.
        customerId: s.customerId,
        customerName: s.customerName,
        gating: s.gating,
      }),
    },
  ),
);

export const billTotals = (s: BillSnapshot) => computeBill(s);
export const heldId = newId;
export type { BillLine };
