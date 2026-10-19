"use client";

import { useCallback, useEffect, useState } from "react";
import { Ban, Check, Loader2, Wallet } from "lucide-react";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { permissions, useShop } from "./useShop";

type BookRow = {
  customer_id: string;
  name: string;
  phone: string | null;
  balance_cents: number;
  limit_cents: number;
  oldest_due_on: string | null;
  is_blocked: boolean;
};

/**
 * Who owes the shop money and for how long.
 *
 * Read from customer_credit_entries, never from a stored balance column: the ledger is the truth,
 * so a wrong tab can always be traced to the entry that caused it.
 */
export function CreditScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? <CreditBook canSettle={can.settleCredit} /> : <NotAllowed what="credit accounts" role={ctx?.role} />}
    </DashboardShell>
  );
}

function CreditBook({ canSettle }: { canSettle: boolean }) {
  const [rows, setRows] = useState<BookRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error: err } = await getSupabase().rpc("credit_book");
    setLoading(false);
    if (err) return setError(err.message);
    setError(null);
    setRows((data as BookRow[] | null) ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function settle(r: BookRow) {
    const cents = parseMoneyInput(amount);
    if (cents === null || cents <= 0) return setError("Enter the amount received.");
    setBusy(true);
    const { error: err } = await getSupabase().rpc("settle_credit", {
      p_customer: r.customer_id,
      p_amount_cents: cents,
      p_method: "cash",
    });
    setBusy(false);
    if (err) return setError(err.message);
    setSettlingId(null);
    setAmount("");
    await load();
  }

  const total = rows.reduce((a, r) => a + Number(r.balance_cents), 0);
  const overdue = rows.filter((r) => r.oldest_due_on && new Date(r.oldest_due_on) < new Date());

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold">Credit</h1>
        <p className="text-sm text-muted">Tabs customers have open. Oldest debt first.</p>
      </div>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Outstanding</p>
          <p className="num mt-1 text-lg font-semibold">{formatMoney(total)}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Customers</p>
          <p className="num mt-1 text-lg font-semibold">{rows.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface px-4 py-3">
          <p className="text-xs uppercase tracking-wide text-muted">Past due</p>
          <p className={`num mt-1 text-lg font-semibold ${overdue.length ? "text-danger" : ""}`}>{overdue.length}</p>
        </div>
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading the credit book...</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Wallet className="mx-auto mb-2 text-muted" size={22} />
          <p className="text-sm text-muted">Nobody owes the shop anything.</p>
          <p className="mt-1 text-xs text-muted">Open a tab for a customer from the Customers screen.</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Due</th>
                <th className="px-4 py-2 text-right">Owed</th>
                <th className="px-4 py-2 text-right">Limit</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const late = r.oldest_due_on && new Date(r.oldest_due_on) < new Date();
                return (
                  <tr key={r.customer_id} className="border-t border-border">
                    <td className="px-4 py-2">
                      <span className="font-medium">{r.name}</span>
                      {r.is_blocked && (
                        <span className="ml-2 inline-flex items-center gap-1 text-xs text-danger">
                          <Ban size={11} /> blocked
                        </span>
                      )}
                      {r.phone && <div className="font-mono text-xs text-muted">{r.phone}</div>}
                    </td>
                    <td className={`px-4 py-2 text-xs ${late ? "font-semibold text-danger" : "text-muted"}`}>
                      {r.oldest_due_on ? new Date(r.oldest_due_on).toLocaleDateString() : "—"}
                    </td>
                    <td className="num px-4 py-2 text-right font-medium">{formatMoney(Number(r.balance_cents))}</td>
                    <td className="num px-4 py-2 text-right text-muted">{formatMoney(Number(r.limit_cents))}</td>
                    <td className="px-4 py-2 text-right">
                      {!canSettle ? null : settlingId === r.customer_id ? (
                        <div className="flex items-center justify-end gap-1">
                          <input
                            autoFocus
                            className="field w-28 text-right"
                            placeholder={formatMoney(Number(r.balance_cents), false)}
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                            onKeyDown={(e) => e.key === "Enter" && void settle(r)}
                          />
                          <button
                            onClick={() => void settle(r)}
                            disabled={busy}
                            className="rounded-md bg-primary px-2 py-1.5 text-xs text-primary-fg"
                          >
                            {busy ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => {
                            setSettlingId(r.customer_id);
                            setAmount(formatMoney(Number(r.balance_cents), false).replace(/,/g, ""));
                          }}
                          className="rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-surface-2"
                        >
                          Settle
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!canSettle && rows.length > 0 && (
        <p className="text-xs text-muted">Only the owner or a supervisor can record a settlement.</p>
      )}
    </div>
  );
}
