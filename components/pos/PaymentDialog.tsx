"use client";

import { useMemo, useState } from "react";
import { Banknote, CreditCard, QrCode, UserRound } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { computeBill } from "@/lib/bill";
import { buildSale } from "@/lib/checkout";
import { getDb, recordSale } from "@/lib/data/db";
import { asSbClient, getSupabase, isConnected } from "@/lib/supabase/client";
import { nudgeSync } from "@/lib/sync/engine";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { playCue } from "@/lib/sound";
import { usePos } from "@/lib/store";
import type { PayMethod } from "@/lib/types";
import { Button, Dialog, Keycap } from "../ui/Dialog";

const METHODS: { id: PayMethod; label: string; key: string; Icon: typeof Banknote }[] = [
  { id: "cash", label: "Cash", key: "C", Icon: Banknote },
  { id: "card", label: "Card", key: "D", Icon: CreditCard },
  { id: "qr", label: "QR / transfer", key: "Q", Icon: QrCode },
  { id: "credit", label: "Credit", key: "R", Icon: UserRound },
];

const NOTES = [500, 1000, 2000, 5000];

export function PaymentDialog({ exact, onClose }: { exact?: boolean; onClose: () => void }) {
  // customerId/customerName must be part of the snapshot, or buildSale records every sale as a
  // walk-in no matter who the gate selected before the bill started.
  const snapshot = usePos(
    useShallow((s) => ({
      lines: s.lines,
      // Without this a deposit shown on the bill would be missing from the sale actually recorded.
      deposits: s.deposits,
      discount: s.discount,
      customerId: s.customerId,
      customerName: s.customerName,
    })),
  );
  const session = usePos((s) => s.session)!;
  const notify = usePos((s) => s.notify);
  const bill = useMemo(() => computeBill(snapshot), [snapshot]);

  const customerId = usePos((s) => s.customerId);
  const customerName = usePos((s) => s.customerName);
  const customerCredit = usePos((s) => s.customerCredit);
  const customerLimit = usePos((s) => s.customerLimit);
  const [method, setMethod] = useState<PayMethod>("cash");
  const [typed, setTyped] = useState(exact ? formatMoney(bill.total, false).replace(/,/g, "") : "");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState(false);

  const tendered = parseMoneyInput(typed);
  const change = method === "cash" && tendered !== null ? tendered - bill.total : null;
  const short = change !== null && change < 0;

  function choose(m: PayMethod) {
    // Credit is the one method the server will refuse outright if the shop is not lending to this
    // person, so say why here rather than letting the sale fail at the end.
    if (m === "credit") {
      if (!customerId) return notify("Choose a customer before putting a sale on a tab", "warn");
      if (customerLimit <= 0) return notify(`${customerName} has no credit limit. Ask the owner to open a tab.`, "warn");
      if (customerCredit + bill.total > customerLimit) {
        return notify(
          `${customerName} is ${formatMoney(customerCredit)} in and the limit is ${formatMoney(customerLimit)}`,
          "warn",
        );
      }
    }
    setMethod(m);
  }

  async function complete() {
    if (busy) return;
    if (bill.total <= 0) {
      notify("Nothing to pay", "warn");
      return;
    }
    if (method === "cash" && (tendered === null || tendered < bill.total)) {
      notify(tendered === null ? "Type the cash received, or press F10 for exact" : "Cash received is less than the total", "warn");
      playCue("error");
      return;
    }
    setBusy(true);
    try {
      const { sale, change: due } = buildSale(snapshot, session, { method, tendered: tendered ?? undefined, ref: ref || undefined });
      const saved = await recordSale(sale);
      // Capture what the customer looked like *before* this sale, so the invoice can show the
      // change (+points, new tab) rather than only the totals after the fact.
      if (sale.customerId) {
        const s = usePos.getState();
        await getDb().meta.put({
          key: "customerSnap",
          value: {
            id: sale.customerId,
            name: s.customerName,
            points: s.customerPoints,
            credit_balance_cents: s.customerCredit,
            credit_limit_cents: s.customerLimit,
          },
        });
      }
      if (isConnected()) nudgeSync(asSbClient(getSupabase()), getDb()); // upload soon; the sale is already safe locally
      usePos.getState().clearBill();
      playCue("done");
      usePos.getState().openDialog({ type: "success", sale: saved, change: due });
    } catch (err) {
      setBusy(false);
      notify(`Could not save the sale: ${err instanceof Error ? err.message : "unknown error"}`, "error");
      playCue("error");
    }
  }

  function onKey(e: React.KeyboardEvent): boolean {
    const inInput = (e.target as HTMLElement).tagName === "INPUT";
    if (e.key === "F10") {
      e.preventDefault();
      setMethod("cash");
      setTyped(formatMoney(bill.total, false).replace(/,/g, ""));
      return true;
    }
    if (!inInput) {
      const m = METHODS.find((x) => x.key.toLowerCase() === e.key.toLowerCase());
      if (m) {
        e.preventDefault();
        choose(m.id);
        return true;
      }
      if (method === "cash") {
        if (/^[0-9.]$/.test(e.key)) {
          e.preventDefault();
          setTyped((t) => (t.length < 10 ? t + e.key : t));
          return true;
        }
        if (e.key === "Backspace") {
          e.preventDefault();
          setTyped((t) => t.slice(0, -1));
          return true;
        }
        if (e.key === "Delete") {
          e.preventDefault();
          setTyped("");
          return true;
        }
      }
    }
    return false;
  }

  return (
    <Dialog
      title="Payment"
      onClose={onClose}
      onConfirm={complete}
      onKey={onKey}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">
            Back
          </Button>
          <Button variant="primary" onClick={complete} keycap="Enter" disabled={busy || short} data-autofocus>
            Complete sale
          </Button>
        </>
      }
    >
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-sm font-bold uppercase tracking-wider text-muted">Total due</span>
        <span className="num text-4xl font-bold">{formatMoney(bill.total)}</span>
      </div>

      <div role="radiogroup" aria-label="Payment method" className="mb-4 grid grid-cols-4 gap-2">
        {METHODS.map(({ id, label, key, Icon }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={method === id}
            onClick={() => choose(id)}
            className={`flex flex-col items-center gap-1 rounded-xl border-2 px-2 py-3 text-sm font-semibold ${
              method === id ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
            } ${id === "credit" ? "opacity-50" : ""}`}
          >
            <Icon size={22} />
            {label}
            <Keycap>{key}</Keycap>
          </button>
        ))}
      </div>

      {method === "cash" ? (
        <div>
          <label className="text-sm font-semibold text-muted" htmlFor="tendered">
            Cash received
          </label>
          <div className="mt-1 flex items-center gap-2 rounded-xl border-2 border-primary px-3">
            <span className="text-muted">LKR</span>
            <input
              id="tendered"
              value={typed}
              inputMode="decimal"
              onChange={(e) => setTyped(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.00"
              className="num h-14 min-w-0 flex-1 bg-transparent text-3xl font-bold outline-none"
              aria-describedby="change-due"
            />
            <Keycap>F10 exact</Keycap>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {NOTES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setTyped(String(n))}
                className="num rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold hover:border-primary"
              >
                {n.toLocaleString("en-US")}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setTyped(String(Math.ceil(bill.total / 100 / 100) * 100))}
              className="num rounded-lg border border-border bg-surface-2 px-3 py-1.5 text-sm font-semibold hover:border-primary"
            >
              Round up
            </button>
          </div>
          <div
            id="change-due"
            aria-live="polite"
            className={`mt-4 flex items-baseline justify-between rounded-xl px-4 py-3 ${
              short ? "bg-danger-soft text-danger" : change !== null ? "bg-success-soft text-success" : "bg-surface-2 text-muted"
            }`}
          >
            <span className="text-sm font-bold uppercase tracking-wider">{short ? "Still to pay" : "Change due"}</span>
            <span className="num text-4xl font-bold">
              {change === null ? "—" : formatMoney(Math.abs(change))}
            </span>
          </div>
        </div>
      ) : (
        <div>
          <label className="text-sm font-semibold text-muted" htmlFor="payref">
            Reference (optional)
          </label>
          <input
            id="payref"
            value={ref}
            onChange={(e) => setRef(e.target.value)}
            placeholder={method === "card" ? "Last 4 digits or approval code" : "Transfer reference"}
            className="mt-1 h-12 w-full rounded-xl border-2 border-border bg-surface px-3 text-lg outline-none focus:border-primary"
          />
          <p className="mt-2 text-sm text-muted">
            Take the payment on the {method === "card" ? "card machine" : "customer’s phone"} first, then press Enter to record it.
          </p>
        </div>
      )}
    </Dialog>
  );
}
