"use client";

import { useEffect, useMemo, useState } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { CheckCircle2, Lock, Trash2 } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { computeBill } from "@/lib/bill";
import { CASHIER_DISCOUNT_LIMIT_PCT } from "@/lib/config";
import { signInStaff } from "@/lib/data/access";
import { getDb } from "@/lib/data/db";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { CENTS_PER_POINT, pointsFor } from "@/lib/points";
import { SHORTCUTS } from "@/lib/shortcuts";
import { playCue } from "@/lib/sound";
import { usePos } from "@/lib/store";
import type { SaleRecord } from "@/lib/types";
import { useShake } from "@/lib/useShake";
import { Button, Dialog, Keycap } from "../ui/Dialog";

/* ---------- Shortcut cheat sheet ---------- */
export function HelpDialog({ onClose }: { onClose: () => void }) {
  const groups = ["Bill", "Find", "Payment", "Tools", "Navigate"] as const;
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} onConfirm={onClose} width="max-w-3xl">
      <div className="grid gap-x-8 gap-y-4 sm:grid-cols-2">
        {groups.map((g) => (
          <section key={g}>
            <h3 className="mb-1.5 text-xs font-bold uppercase tracking-wider text-muted">{g}</h3>
            <ul className="space-y-1">
              {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 text-sm">
                  <span>{s.label}</span>
                  <Keycap>{s.keys}</Keycap>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
      <p className="mt-4 text-xs text-muted">Every action also works with the mouse. Scanning always goes to the scan bar.</p>
      <button data-autofocus className="sr-only" onClick={onClose}>
        Close
      </button>
    </Dialog>
  );
}

/* ---------- Change quantity of the selected line (F2) ---------- */
export function QtyDialog({ onClose }: { onClose: () => void }) {
  const lines = usePos((s) => s.lines);
  const selectedId = usePos((s) => s.selectedId);
  const line = lines.find((l) => l.id === selectedId && !l.voided);
  const [value, setValue] = useState(String(line?.qty ?? 1));

  async function apply() {
    const s = usePos.getState();
    if (!line) return onClose();
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n) || n < 1) {
      s.notify("Enter a quantity of 1 or more", "warn");
      return;
    }
    onClose();
    if (n > line.qty) return s.setQty(line.id, n);
    if (n < line.qty) {
      // Lowering a quantity removes items, so it needs a supervisor (same as a void).
      const who = await s.requestApproval(`Reduce ${line.name}${line.label ? " " + line.label : ""} from ${line.qty} to ${n}`);
      if (who) {
        s.voidLine(line.id, line.qty - n, "Quantity corrected", who.name);
        s.notify(`Quantity corrected by ${who.name}`, "success");
      }
    }
  }

  return (
    <Dialog
      title="Change quantity"
      onClose={onClose}
      onConfirm={apply}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">Cancel</Button>
          <Button variant="primary" onClick={apply} keycap="Enter">Apply</Button>
        </>
      }
    >
      {line ? (
        <>
          <p className="mb-2 font-medium">
            {line.name} {line.label && <span className="text-muted">{line.label}</span>}
          </p>
          <input
            data-autofocus
            value={value}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, "").slice(0, 3))}
            inputMode="numeric"
            aria-label="Quantity"
            className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-3 text-center text-3xl font-bold outline-none"
          />
          <p className="mt-2 text-xs text-muted">Raising is free. Lowering needs a supervisor.</p>
        </>
      ) : (
        <p className="text-muted">Select a bill line first (↑/↓).</p>
      )}
    </Dialog>
  );
}

/* ---------- Bill discount (F6) ---------- */
export function DiscountDialog({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("");
  const snapshot = usePos(
    useShallow((s) => ({ lines: s.lines, bottlesReturned: s.bottlesReturned, feeWaived: s.feeWaived, discount: 0 })),
  );
  const subtotal = useMemo(() => computeBill(snapshot).subtotal, [snapshot]);

  const isPct = value.trim().endsWith("%");
  const num = parseMoneyInput(value.replace("%", ""));
  const amount = num === null ? 0 : isPct ? Math.round((subtotal * num) / 10000) : num;
  const pct = subtotal > 0 ? (amount / subtotal) * 100 : 0;
  const needsApproval = pct > CASHIER_DISCOUNT_LIMIT_PCT;

  async function apply() {
    const s = usePos.getState();
    if (value.trim() === "" || amount === 0) {
      s.setDiscount(0);
      return onClose();
    }
    if (amount > subtotal) return s.notify("Discount is larger than the bill", "warn");
    onClose();
    if (needsApproval && s.session?.role === "cashier") {
      const who = await s.requestApproval(`Discount of ${formatMoney(amount)} (${pct.toFixed(1)}% of the bill)`);
      if (!who) return;
    }
    s.setDiscount(amount);
    s.notify(`Discount ${formatMoney(amount)} applied`, "success");
  }

  return (
    <Dialog
      title="Bill discount"
      onClose={onClose}
      onConfirm={apply}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">Cancel</Button>
          <Button variant="primary" onClick={apply} keycap="Enter">Apply</Button>
        </>
      }
    >
      <input
        data-autofocus
        value={value}
        onChange={(e) => setValue(e.target.value.replace(/[^0-9.%]/g, ""))}
        placeholder="Amount (100) or percent (5%)"
        aria-label="Discount"
        className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-3 text-2xl font-bold outline-none"
      />
      <p className="num mt-2 text-sm text-muted">
        {amount > 0 ? `Takes ${formatMoney(amount)} off ${formatMoney(subtotal)}` : "Leave empty and press Enter to clear the discount"}
      </p>
      {needsApproval && amount > 0 && (
        <p className="mt-1 text-sm font-medium text-warning">Over {CASHIER_DISCOUNT_LIMIT_PCT}%: a supervisor will be asked to approve.</p>
      )}
    </Dialog>
  );
}

/* ---------- Held bills (F9) ---------- */
export function HeldDialog({ onClose }: { onClose: () => void }) {
  const held = useLiveQuery(() => getDb().held.orderBy("createdAt").reverse().toArray(), [], []);
  const hasLines = usePos((s) => s.lines.length > 0);
  const [idx, setIdx] = useState(0);
  const i = Math.min(idx, Math.max(0, held.length - 1));

  async function recall() {
    const h = held[i];
    if (!h) return;
    const s = usePos.getState();
    if (hasLines) return s.notify("Hold or finish the current bill first", "warn");
    s.loadBill(h);
    await getDb().held.delete(h.id);
    s.notify("Held bill recalled", "success");
    onClose();
  }

  async function discard() {
    const h = held[i];
    if (!h) return;
    const s = usePos.getState();
    const who = await s.requestApproval(`Discard held bill (${h.lines.filter((l) => !l.voided).length} lines)`);
    if (who) {
      await getDb().held.delete(h.id);
      s.notify(`Held bill discarded (approved by ${who.name})`, "success");
    }
  }

  function onKey(e: React.KeyboardEvent): boolean {
    if (e.key === "ArrowDown") return (setIdx(Math.min(i + 1, held.length - 1)), e.preventDefault(), true);
    if (e.key === "ArrowUp") return (setIdx(Math.max(i - 1, 0)), e.preventDefault(), true);
    if (e.key === "Delete") return (void discard(), e.preventDefault(), true);
    return false;
  }

  return (
    <Dialog title="Held bills" onClose={onClose} onConfirm={recall} onKey={onKey} width="max-w-lg">
      {held.length === 0 ? (
        <p className="py-6 text-center text-muted">No bills on hold. Press F9 with items on the bill to hold it.</p>
      ) : (
        <ul className="space-y-1.5" data-autofocus tabIndex={0}>
          {held.map((h, n) => {
            const t = computeBill(h);
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => setIdx(n)}
                  onDoubleClick={recall}
                  className={`flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left ${n === i ? "border-primary bg-primary-soft" : "border-border"}`}
                >
                  <span>
                    <span className="block font-medium">
                      {h.lines.filter((l) => !l.voided).reduce((a, l) => a + l.qty, 0)} items · {h.cashierName}
                    </span>
                    <span className="num block text-xs text-muted">{new Date(h.createdAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
                  </span>
                  <span className="num text-lg font-semibold">{formatMoney(t.total)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-4 flex items-center justify-between">
        <span className="text-xs text-muted">↑/↓ choose · Enter recall · Del discard (supervisor)</span>
        <div className="flex gap-2">
          <Button onClick={discard} disabled={held.length === 0}>
            <Trash2 size={15} /> Discard
          </Button>
          <Button variant="primary" onClick={recall} disabled={held.length === 0} keycap="Enter">
            Recall
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------- Sale complete ---------- */
export function SuccessDialog({ sale, change, onClose }: { sale: SaleRecord; change: number; onClose: () => void }) {
  const points = sale.customerId ? pointsFor(sale.total) : 0;
  return (
    <Dialog
      title="Sale complete"
      onClose={onClose}
      onConfirm={onClose}
      width="max-w-md"
      footer={
        <Button variant="primary" className="h-12 flex-1" onClick={onClose} keycap="Enter" data-autofocus>
          Next customer
        </Button>
      }
    >
      <div className="flex flex-col items-center gap-2 py-2 text-center">
        <CheckCircle2 size={44} className="text-success" />
        <p className="text-sm text-muted">Receipt #{sale.receiptNo}</p>
        <p className="num text-lg">{formatMoney(sale.total)} paid by {sale.payments[0]?.method}</p>
        {sale.payments[0]?.method === "cash" && (
          <div className="mt-1 w-full rounded-xl bg-success-soft px-4 py-3 text-success">
            <p className="text-xs font-bold uppercase tracking-wider">Change due</p>
            <p className="num text-5xl font-bold">{formatMoney(change)}</p>
          </div>
        )}
        {sale.bottleFeeCharged > 0 && <p className="text-sm text-warning">Includes bottle fee {formatMoney(sale.bottleFeeCharged)}</p>}
        {sale.customerId && (
          <div className="mt-1 w-full rounded-xl bg-primary-soft px-4 py-3 text-left text-primary">
            <p className="text-sm font-semibold">
              Order completed for {sale.customerName ?? "the selected customer"}
            </p>
            <p className="mt-0.5 text-xs">
              {points > 0
                ? `Earned ${points} point${points === 1 ? "" : "s"} on this order.`
                : `Points start at ${formatMoney(CENTS_PER_POINT)} spent.`}
            </p>
          </div>
        )}
        <p className="text-xs text-muted">Saved on this PC · syncs when online. Receipt printing is switched off (no printer set up).</p>
      </div>
    </Dialog>
  );
}

/* ---------- Lock screen (Ctrl+L) ---------- */
export function LockScreen() {
  const session = usePos((s) => s.session)!;
  const lines = usePos((s) => s.lines.length);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | false>(false);
  const [shakeRef, shake] = useShake<HTMLDivElement>();

  useEffect(() => {
    document.getElementById("unlock-pin")?.focus();
  }, []);

  async function unlock() {
    const res = await signInStaff(session.code, pin);
    if (res.ok && res.user.id === session.id) {
      playCue("ok");
      usePos.getState().setLocked(false);
    } else {
      setError(res.ok ? "Wrong PIN" : res.message);
      setPin("");
      shake();
      playCue("error");
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-bg/95 backdrop-blur">
      <div ref={shakeRef} className="w-80 rounded-2xl border border-border bg-surface p-6 text-center shadow-[var(--shadow)]">
        <Lock className="mx-auto mb-2 text-muted" size={32} />
        <h2 className="text-xl font-semibold">Till locked</h2>
        <p className="mb-4 text-sm text-muted">
          {session.name}
          {lines > 0 && " · bill kept"}
        </p>
        <input
          id="unlock-pin"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => {
            setError(false);
            setPin(e.target.value.replace(/\D/g, "").slice(0, 8));
          }}
          onKeyDown={(e) => e.key === "Enter" && unlock()}
          aria-label="PIN to unlock"
          placeholder="PIN"
          className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-4 text-center text-2xl tracking-[0.4em] outline-none"
        />
        <p role="alert" className="mt-2 min-h-5 text-sm font-medium text-danger">{error || ""}</p>
        <Button variant="primary" className="mt-1 w-full" onClick={unlock} keycap="Enter">Unlock</Button>
      </div>
    </div>
  );
}
