"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Droplets, Receipt, TrendingUp, Users } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { permissions, useShop } from "./useShop";

type Overview = {
  sales: number;
  revenue_cents: number;
  customers: number;
  low_stock: number;
  bottles_out: number;
  staff: number;
  days: number;
};

type Row = {
  product_id: string;
  name: string;
  units_sold: number;
  revenue_cents: number;
  cost_cents: number | null;
  margin_cents: number | null;
  stock_on_hand: number;
  reorder_level: number;
  is_low_stock: boolean;
  bottles_out: number;
};

/**
 * Overview and per-product analytics.
 *
 * Margin is only present for the owner: the server returns null cost for a supervisor, so there is
 * nothing to hide in the browser. Showing "n/a" is deliberate - a supervisor sees revenue, never
 * what the shop paid.
 */
export function OverviewScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);

  return (
    <DashboardShell>
      {can.viewAnalytics ? (
        <Overview currency={ctx?.store?.currency ?? "LKR"} isOwner={ctx?.role === "owner"} bottles={{ fee: ctx?.store?.bottle_fee_cents ?? 0 }} />
      ) : (
        <NotAllowed what="reports" role={ctx?.role} />
      )}
    </DashboardShell>
  );
}

function Overview({
  currency,
  isOwner,
  bottles,
}: {
  currency: string;
  isOwner: boolean;
  bottles: { fee: number };
}) {
  const [days, setDays] = useState(30);
  const [stats, setStats] = useState<Overview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      setLoading(true);
      const sb = getSupabase();
      const [{ data: ov, error: e1 }, { data: pa, error: e2 }] = await Promise.all([
        sb.rpc("store_overview", { p_days: days }),
        sb.rpc("product_analytics", { p_days: days }),
      ]);
      if (!alive) return;
      setLoading(false);
      const err = e1 ?? e2;
      if (err) {
        setError(err.message);
        return;
      }
      setStats(ov as Overview);
      setRows((pa as Row[] | null) ?? []);
    })();
    return () => {
      alive = false;
    };
  }, [days]);

  const money = (c: number) => formatMoney(c);
  const low = rows.filter((r) => r.is_low_stock);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Overview</h1>
          <p className="text-sm text-muted">How the shop is doing.</p>
        </div>
        <div className="flex gap-1 rounded-lg bg-surface-2 p-1">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              onClick={() => setDays(d)}
              className={`rounded-md px-3 py-1.5 text-sm ${days === d ? "bg-surface font-medium shadow-sm" : "text-muted"}`}
            >
              {d} days
            </button>
          ))}
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          icon={<TrendingUp size={16} />}
          label="Revenue"
          value={loading ? "..." : money(stats?.revenue_cents ?? 0)}
          hint={`${days} days`}
        />
        <Stat icon={<Receipt size={16} />} label="Sales" value={loading ? "..." : String(stats?.sales ?? 0)} />
        <Stat icon={<Users size={16} />} label="Customers served" value={loading ? "..." : String(stats?.customers ?? 0)} />
        <Stat
          icon={<Droplets size={16} />}
          label="Bottles out"
          value={loading ? "..." : String(stats?.bottles_out ?? 0)}
          hint={stats?.bottles_out ? `Worth ${money((stats.bottles_out ?? 0) * bottles.fee)}` : "None owing"}
          tone={stats?.bottles_out ? "warning" : undefined}
        />
      </div>

      {low.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-warning/40 bg-warning-soft p-3 text-sm">
          <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={16} />
          <p>
            <span className="font-medium">{low.length} product{low.length === 1 ? "" : "s"} low on stock:</span>{" "}
            {low.slice(0, 4).map((r) => r.name).join(", ")}
            {low.length > 4 && ` and ${low.length - 4} more`}
          </p>
        </div>
      )}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">By product</h2>
          <Link href="/products" className="text-sm text-primary underline">
            Manage products
          </Link>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
            No products yet. Analytics appear once you add products and make sales.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2 text-right">Sold</th>
                  <th className="px-4 py-2 text-right">Revenue</th>
                  {isOwner && <th className="px-4 py-2 text-right">Margin</th>}
                  <th className="px-4 py-2 text-right">Stock</th>
                  <th className="px-4 py-2 text-right">Bottles out</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.product_id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 text-right font-mono">{Number(r.units_sold)}</td>
                    <td className="px-4 py-2 text-right font-mono">{money(r.revenue_cents)}</td>
                    {isOwner && (
                      <td className="px-4 py-2 text-right font-mono">
                        {r.margin_cents == null ? (
                          <span className="text-muted">-</span>
                        ) : (
                          <span className={r.margin_cents < 0 ? "text-danger" : ""}>{money(r.margin_cents)}</span>
                        )}
                      </td>
                    )}
                    <td className={`px-4 py-2 text-right font-mono ${r.is_low_stock ? "text-warning" : ""}`}>
                      {Number(r.stock_on_hand)}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{r.bottles_out || "-"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!isOwner && (
          <p className="mt-2 text-xs text-muted">
            Cost and margin are visible to the shop owner only.
          </p>
        )}
      </section>
      <BottlesOwed money={money} />
    </div>
  );
}
type Debtor = { customer_id: string; name: string; phone: string; bottles_out: number; last_sale_at: string | null };
/**
 * Who still has the shop's bottles. This is the list the owner asked for: a customer who never
 * brought the bottle back shows up here until it is returned or the deposit is charged.
 */
function BottlesOwed({ money }: { money: (c: number) => string }) {
  const [rows, setRows] = useState<Debtor[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    void (async () => {
      const { data } = await getSupabase().rpc("customers_with_bottles", { p_limit: 50 });
      setRows((data as Debtor[] | null) ?? []);
      setLoading(false);
    })();
  }, []);
  if (loading) return <p className="text-sm text-muted">Loading bottles...</p>;
  if (rows.length === 0) {
    return (
      <section>
        <h2 className="mb-2 font-semibold">Bottles owed</h2>
        <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
          Every bottle has been returned. Nothing outstanding.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="mb-2 font-semibold">Bottles owed</h2>
      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        <table className="w-full text-sm">
          <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
            <tr>
              <th className="px-4 py-2">Customer</th>
              <th className="px-4 py-2">Mobile</th>
              <th className="px-4 py-2 text-right">Bottles</th>
              <th className="px-4 py-2 text-right">Last visit</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.customer_id} className="border-t border-border">
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2 font-mono">{r.phone}</td>
                <td className="px-4 py-2 text-right font-mono text-warning">{r.bottles_out}</td>
                <td className="px-4 py-2 text-right text-muted">
                  {r.last_sale_at ? new Date(r.last_sale_at).toLocaleDateString() : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-xs text-muted">
        Returned at the till with F7, once the customer is attached to the bill.
      </p>
    </section>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className={`rounded-xl border bg-surface p-4 ${tone === "warning" ? "border-warning/40" : "border-border"}`}>
      <div className="flex items-center gap-2 text-xs uppercase text-muted">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
