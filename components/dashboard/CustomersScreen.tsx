"use client";

import { useEffect, useMemo, useState } from "react";
import { Search, Star } from "lucide-react";
import { formatMoney } from "@/lib/money";
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
