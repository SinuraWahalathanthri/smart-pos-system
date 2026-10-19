"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Search, Star, Wallet } from "lucide-react";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { permissions, useShop } from "./useShop";

type CustomerRow = {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  points: number;
  spend_cents: number;
  visits: number;
  credit_balance_cents?: number;
  credit_limit_cents?: number;
};

/**
 * Customers and what they are worth to the shop.
 *
 * Points come from public.customer_points, which is only ever written by record_sale, so the
 * balance here cannot drift from the receipts shown on the Receipts screen.
 */
export function CustomersScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);

  return (
    <DashboardShell>
      {can.viewAnalytics ? <CustomerList /> : <NotAllowed what="customers" role={ctx?.role} />}
    </DashboardShell>
  );
}

function CustomerList() {
  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  const reload = useCallback(async () => {
    const { data, error: err } = await getSupabase().rpc("customer_directory");
    if (err) return setError(err.message);
    setError(null);
    setRows((data as CustomerRow[] | null) ?? []);
  }, []);
  useEffect(() => {
    let stale = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await getSupabase().rpc("customer_directory");
      if (stale) return;
      setLoading(false);
      if (err) {
        setError(err.message);
        return;
      }
      setRows((data as CustomerRow[] | null) ?? []);
    })();
    return () => {
      stale = true;
    };
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.phone ?? "").includes(q));
  }, [rows, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Customers</h1>
          <p className="text-sm text-muted">Points are earned at LKR 100 per point on completed orders.</p>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 text-muted" size={16} />
          <input className="field pl-8" placeholder="Name or mobile" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      {loading ? (
        <p className="text-sm text-muted">Loading customers...</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted">
            {rows.length === 0 ? "No customers yet. Add one at the till when a customer gives a number." : "Nothing matches that search."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Mobile</th>
                <th className="px-4 py-2 text-right">Visits</th>
                <th className="px-4 py-2 text-right">Spent</th>
                <th className="px-4 py-2 text-right">Points</th>
                <th className="px-4 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{r.name}</td>
                  <td className="px-4 py-2 font-mono text-muted">{r.phone ?? "-"}</td>
                  <td className="px-4 py-2 text-right font-mono">{r.visits}</td>
                  <td className="px-4 py-2 text-right font-mono">{formatMoney(Number(r.spend_cents))}</td>
                  <td className="px-4 py-2 text-right font-mono font-medium">
                    <span className="inline-flex items-center gap-1">
                      <Star size={13} className="text-warning" />
                      {r.points}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <CreditCell row={r} onSaved={() => void reload()} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * A customer's tab: what they owe, and the limit the owner has set. Editing the limit is inline
 * because setting it is the only way a customer can ever use credit, and making it a separate
 * screen would leave new customers permanently unable to put anything on account.
 */
function CreditCell({ row, onSaved }: { row: CustomerRow; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [limit, setLimit] = useState(
    row.credit_limit_cents ? formatMoney(Number(row.credit_limit_cents), false).replace(/,/g, "") : "",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const owed = Number(row.credit_balance_cents ?? 0);
  const cap = Number(row.credit_limit_cents ?? 0);
  async function save() {
    const cents = limit.trim() === "" ? 0 : parseMoneyInput(limit);
    if (cents === null || cents < 0) return setError("Enter a limit in rupees.");
    setBusy(true);
    const { error: err } = await getSupabase().rpc("set_credit_terms", {
      p_customer: row.id,
      p_limit_cents: cents,
      p_terms_days: 0,
      p_blocked: false,
    });
    setBusy(false);
    if (err) return setError(err.message);
    setError(null);
    setEditing(false);
    onSaved();
  }
  if (editing) {
    return (
      <div className="flex items-center justify-end gap-1">
        <input
          autoFocus
          className="field w-24 text-right"
          placeholder="Limit"
          value={limit}
          onChange={(e) => setLimit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
        />
        <button onClick={() => void save()} disabled={busy} className="rounded-md bg-primary px-2 py-1 text-xs text-primary-fg">
          {busy ? <Loader2 className="animate-spin" size={12} /> : "Save"}
        </button>
        {error && <span className="text-xs text-danger">{error}</span>}
      </div>
    );
  }
  return (
    <button
      onClick={() => setEditing(true)}
      className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs hover:bg-surface-2"
      title={cap > 0 ? `${formatMoney(owed)} owed of ${formatMoney(cap)} limit` : "No credit limit set"}
    >
      <Wallet size={12} className={cap > 0 ? "text-primary" : "text-muted"} />
      {cap > 0 ? (
        <span className={owed > 0 ? "font-medium text-danger" : "text-muted"}>
          {formatMoney(owed)} / {formatMoney(cap)}
        </span>
      ) : (
        <span className="text-muted">No tab</span>
      )}
    </button>
  );
}
