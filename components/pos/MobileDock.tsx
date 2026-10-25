"use client";

import { useEffect, useState } from "react";
import {
  Calculator,
  CheckCircle2,
  Cloud,
  CreditCard,
  Droplets,
  Grid2x2,
  HelpCircle,
  Lock,
  Pause,
  Percent,
  ReceiptText,
  ScanLine,
  Trash2,
  UserRound,
  X,
} from "lucide-react";
import { formatMoney } from "@/lib/money";
import { SHORTCUTS } from "@/lib/shortcuts";

/** Actions that need a bill line selected first; hidden until one is, so taps do not dead-end. */
const NEEDS_LINE = new Set(["qty", "void"]);

const ICONS: Record<string, typeof ReceiptText> = {
  qty: Grid2x2,
  search: ScanLine,
  calc: Calculator,
  customer: UserRound,
  discount: Percent,
  bottle: Droplets,
  void: Trash2,
  hold: Pause,
  exact: Cloud,
  pay: CreditCard,
  palette: Grid2x2,
  help: HelpCircle,
  lock: Lock,
};

/**
 * Touch replacement for the keyboard.
 *
 * Every till action has a key, and on a phone there is no keyboard, so this menu is the only way to
 * reach them. It is built from SHORTCUTS rather than a hand-written list: a shortcut added to the
 * registry appears here automatically, which is what stops the two drifting apart again.
 */
export function ActionMenu({
  onClose,
  onRun,
  hasLines,
}: {
  onClose: () => void;
  onRun: (id: string) => void;
  hasLines: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const actions = SHORTCUTS.filter((s) => ICONS[s.id] && (!NEEDS_LINE.has(s.id) || hasLines));

  return (
    <div className="fade-in fixed inset-0 z-50 flex items-end bg-black/50" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Till actions"
        className="slide-in-right-sm w-full rounded-t-2xl border border-border bg-surface p-4 pb-6 shadow-[var(--shadow)]"
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-base font-semibold">Actions</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded-md p-2 text-muted hover:bg-surface-2">
            <X size={18} />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {actions.map((s) => {
            const Icon = ICONS[s.id];
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onRun(s.id);
                  onClose();
                }}
                className="flex flex-col items-center gap-1.5 rounded-xl border border-border bg-surface-2 px-1 py-3 text-xs font-medium text-text active:scale-[0.97]"
              >
                <Icon size={20} className="text-muted" />
                <span className="text-center leading-tight">{s.barLabel ?? s.label.split(" ")[0]}</span>
              </button>
            );
          })}
        </div>
        <p className="mt-3 text-center text-[11px] text-muted">
          Tip: a USB barcode scanner still works on a phone or tablet.
        </p>
      </div>
    </div>
  );
}

/**
 * "3 × Cardamom added" confirmation for touch, sliding in from the right.
 *
 * Deliberately not the shared toast: that one carries errors and is cleared by the next notify(), so
 * a fast picker would wipe a stock warning off screen. This has its own short-lived state.
 */
export function AddedToast({
  name,
  label,
  qty,
  itemCount,
  onView,
  onDone,
}: {
  name: string;
  label?: string;
  qty: number;
  itemCount: number;
  onView: () => void;
  onDone: () => void;
}) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [name, label, qty, onDone]);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-32 z-40 flex justify-center px-3">
      <div
        role="status"
        aria-live="polite"
        className="slide-in-right-sm pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-success/40 bg-success-soft px-3 py-2 text-success shadow-[var(--shadow)]"
      >
        <CheckCircle2 size={18} className="shrink-0" />
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">
            {qty} × {name}
            {label && <span className="ml-1 opacity-80">{label}</span>}
          </p>
          <p className="text-xs opacity-90">
            Added to invoice · {itemCount} item{itemCount === 1 ? "" : "s"} now
          </p>
        </div>
        <button type="button" onClick={onView} className="shrink-0 rounded-lg bg-success px-2 py-1 text-xs font-semibold text-white">
          View
        </button>
      </div>
    </div>
  );
}

/**
 * Floating buttons: the invoice (with a live item count) and the action menu.
 *
 * `left` moves them to the bottom-left for right-handed use. The invoice is the larger target
 * because it is reached far more often than the menu.
 */
export function MobileDock({
  itemCount,
  total,
  hasLines,
  side,
  onRun,
  onOpenBill,
}: {
  itemCount: number;
  total: number;
  hasLines: boolean;
  side: "left" | "right";
  onRun: (id: string) => void;
  onOpenBill: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const align = side === "left" ? "left-4 items-start" : "right-4 items-end";

  return (
    <>
      <div className={`fixed bottom-4 z-30 flex flex-col gap-2 ${align}`}>
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          className="grid h-12 w-12 place-items-center rounded-full border border-border bg-surface text-muted shadow-[var(--shadow)] active:scale-95"
          aria-label="Open till actions"
        >
          <Grid2x2 size={20} />
        </button>

        <button
          type="button"
          onClick={onOpenBill}
          className="relative flex items-center gap-2 rounded-full bg-primary px-4 py-3 text-primary-fg shadow-[var(--shadow)] active:scale-95"
          aria-label={`Open invoice, ${itemCount} item${itemCount === 1 ? "" : "s"}`}
        >
          <ReceiptText size={22} />
          {itemCount > 0 && <span className="num text-sm font-bold leading-none">{formatMoney(total, false)}</span>}
          {itemCount > 0 && (
            <span className="num absolute -right-1 -top-1 grid min-w-6 place-items-center rounded-full border-2 border-surface bg-danger px-1 text-xs font-bold text-white">
              {itemCount > 99 ? "99+" : itemCount}
            </span>
          )}
        </button>
      </div>

      {menuOpen && <ActionMenu hasLines={hasLines} onClose={() => setMenuOpen(false)} onRun={onRun} />}
    </>
  );
}
