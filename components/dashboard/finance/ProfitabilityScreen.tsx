"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, Info } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { formatPercent, monthPeriod, type Period, type ProductProfit } from "@/lib/finance";
import { centsToDecimal, downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { Button, Dialog } from "@/components/ui/Dialog";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import { Empty, ErrorNote, Loading, Money, PeriodLabel, Section } from "./FinanceUI";
import { MonthPicker } from "./FinanceScreen";

type SortKey = "revenue" | "profit" | "margin" | "units";

/**
 * What each product actually earns.
 *
 * The default sort is gross profit, not revenue: the biggest seller is often not the one paying the
 * rent, and a table sorted by revenue quietly encourages the wrong conclusion.
 *
 * A supervisor sees revenue but not cost, because 0010 established that cost is owner-only and the
 * server returns null for it. The screen says so rather than showing a column of dashes with no
 * explanation.
 */
export function ProfitabilityScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? (
        <Profitability isOwner={ctx?.role === "owner"} />
      ) : (
        <NotAllowed what="profitability" role={ctx?.role} />
      )}
    </DashboardShell>
  );
}

function Profitability({ isOwner }: { isOwner: boolean }) {
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [rows, setRows] = useState<ProductProfit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("profit");
  const [editing, setEditing] = useState<ProductProfit | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const { data, error: err } = await getSupabase().rpc("product_profitability", { p_from: p.from, p_to: p.to });
    setLoading(false);
    if (err) return setError(err.message);
    setError(null);
    setRows((data as ProductProfit[] | null) ?? []);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      if (sort === "units") return Number(b.qty_sold) - Number(a.qty_sold);
      if (sort === "margin") return (Number(b.margin_pct) || -1e9) - (Number(a.margin_pct) || -1e9);
      if (sort === "revenue") return Number(b.revenue_cents) - Number(a.revenue_cents);
      return (Number(b.gross_profit_cents) || -1e9) - (Number(a.gross_profit_cents) || -1e9);
    });
    return copy;
  }, [rows, sort]);

  const totals = useMemo(
    () => ({
      revenue: rows.reduce((n, r) => n + Number(r.revenue_cents), 0),
      cogs: rows.reduce((n, r) => n + Number(r.cogs_cents ?? 0), 0),
      profit: rows.reduce((n, r) => n + Number(r.gross_profit_cents ?? 0), 0),
      uncosted: rows.filter((r) => isOwner && !r.cost_known).length,
      belowCost: rows.filter((r) => r.is_below_cost),
    }),
    [rows, isOwner],
  );

  function exportRows() {
    const csv = toCsv(sorted, [
      { header: "Product", value: (r) => r.name },
      { header: "SKU", value: (r) => r.sku },
      { header: "Category", value: (r) => r.category },
      { header: "Units sold", value: (r) => r.qty_sold },
      { header: "Revenue (LKR)", value: (r) => centsToDecimal(r.revenue_cents) },
      { header: "Cost of goods (LKR)", value: (r) => centsToDecimal(r.cogs_cents) },
      { header: "Gross profit (LKR)", value: (r) => centsToDecimal(r.gross_profit_cents) },
      { header: "Margin %", value: (r) => r.margin_pct },
      { header: "Markup %", value: (r) => r.markup_pct },
      { header: "Cost known", value: (r) => (r.cost_known ? "yes" : "no") },
      { header: "Stock on hand", value: (r) => r.stock_on_hand },
    ]);
    downloadCsv(exportFilename("product-profitability", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Profitability</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker period={period} onChange={setPeriod} />
          <select
            className="field w-auto"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            aria-label="Sort by"
          >
            <option value="profit">Sorted by: gross profit</option>
            <option value="revenue">Sorted by: revenue</option>
            <option value="margin">Sorted by: margin</option>
            <option value="units">Sorted by: units sold</option>
          </select>
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportRows}
            disabled={rows.length === 0}
          >
            <Download size={15} /> Export
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}

      {!isOwner && (
        <div className="flex gap-2 rounded-xl border border-border bg-surface p-3 text-sm text-muted">
          <Info className="mt-0.5 shrink-0" size={16} />
          <p>
            Costs and margins are visible to the shop owner only, so you are seeing revenue and volume
            without them. Ask the owner if you need the margin on a product.
          </p>
        </div>
      )}

      {isOwner && totals.uncosted > 0 && (
        <div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
          {totals.uncosted} product{totals.uncosted === 1 ? "" : "s"} sold this period{" "}
          {totals.uncosted === 1 ? "has" : "have"} no recorded cost, so{" "}
          {totals.uncosted === 1 ? "its" : "their"} profit is overstated. Set a cost to fix it.
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Revenue from goods</p>
          <p className="mt-1 text-xl font-semibold">
            <Money cents={totals.revenue} />
          </p>
          <p className="mt-1 text-xs text-muted">after discounts and refunds</p>
        </div>
        {isOwner && (
          <>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Cost of those goods</p>
              <p className="mt-1 text-xl font-semibold">
                <Money cents={totals.cogs} />
              </p>
              <p className="mt-1 text-xs text-muted">at the cost recorded when sold</p>
            </div>
            <div className="rounded-xl border border-border bg-surface p-4">
              <p className="text-xs uppercase tracking-wide text-muted">Gross profit</p>
              <p className={`mt-1 text-xl font-semibold ${totals.profit < 0 ? "text-danger" : ""}`}>
                <Money cents={totals.profit} />
              </p>
              <p className="mt-1 text-xs text-muted">
                {totals.revenue === 0 ? "—" : formatPercent((totals.profit / totals.revenue) * 100)} margin
              </p>
            </div>
          </>
        )}
      </div>

      {totals.belowCost.length > 0 && isOwner && (
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
          <p className="font-medium text-danger">Sold below cost</p>
          <p className="mt-1 text-muted">
            {totals.belowCost.map((r) => r.name).join(", ")} — these earned less than the goods cost. Either
            the price is too low or the recorded cost is wrong.
          </p>
        </div>
      )}

      <Section title="Products sold this period">
        {loading ? (
          <Loading what="profitability" />
        ) : sorted.length === 0 ? (
          <Empty>Nothing was sold in {period.label}.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="py-2 pr-3 font-medium">Product</th>
                  <th className="py-2 pr-3 text-right font-medium">Units</th>
                  <th className="py-2 pr-3 text-right font-medium">Revenue</th>
                  {isOwner && (
                    <>
                      <th className="py-2 pr-3 text-right font-medium">Unit cost</th>
                      <th className="py-2 pr-3 text-right font-medium">Profit / unit</th>
                      <th className="py-2 pr-3 text-right font-medium">Margin</th>
                      <th className="py-2 pr-3 text-right font-medium">Markup</th>
                      <th className="py-2 pr-3 text-right font-medium">Gross profit</th>
                      <th className="py-2 text-right font-medium">Cost</th>
                    </>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {sorted.map((r) => (
                  <tr key={r.product_id} className={r.is_below_cost ? "bg-danger/5" : ""}>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{r.name}</span>
                      {r.category && <span className="ml-2 text-xs text-muted">{r.category}</span>}
                      {Number(r.units_refunded) > 0 && (
                        <span className="ml-2 text-xs text-muted">{r.units_refunded} returned</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums">{Number(r.qty_sold).toFixed(2).replace(/\.00$/, "")}</td>
                    <td className="py-2 pr-3 text-right">
                      <Money cents={r.revenue_cents} />
                    </td>
                    {isOwner && (
                      <>
                        <td className="py-2 pr-3 text-right">
                          <Money cents={r.unit_cost_cents} muted />
                        </td>
                        <td className={`py-2 pr-3 text-right ${Number(r.gross_profit_per_unit_cents) < 0 ? "text-danger" : ""}`}>
                          <Money cents={r.gross_profit_per_unit_cents} />
                        </td>
                        <td className={`py-2 pr-3 text-right ${Number(r.margin_pct) < 0 ? "text-danger" : ""}`}>
                          {formatPercent(r.margin_pct === null ? null : Number(r.margin_pct))}
                        </td>
                        <td className="py-2 pr-3 text-right">{formatPercent(r.markup_pct === null ? null : Number(r.markup_pct))}</td>
                        <td className="py-2 pr-3 text-right font-medium">
                          <Money cents={r.gross_profit_cents} />
                        </td>
                        <td className="py-2 text-right">
                          {r.cost_known ? (
                            <button
                              className="text-xs text-muted underline hover:text-text"
                              onClick={() => setEditing(r)}
                              title="Change the recorded cost"
                            >
                              {formatMoney(r.current_cost_cents ?? 0)}
                            </button>
                          ) : (
                            <button
                              className="rounded bg-warning/15 px-1.5 py-0.5 text-xs text-warning"
                              onClick={() => setEditing(r)}
                            >
                              Set cost
                            </button>
                          )}
                        </td>
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          Margin is profit as a share of what the customer paid; markup is profit as a share of what the
          goods cost. Both are shown because they answer different questions and are easy to confuse.
        </p>
      </Section>

      {editing && (
        <CostDialog
          product={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load(period);
          }}
        />
      )}
    </div>
  );
}

/**
 * Set the cost of one product.
 *
 * Asking for a reason is not bureaucracy: a cost that changed with no explanation is the single most
 * common reason a shopkeeper later cannot explain a margin, and the audit screen flags these.
 */
function CostDialog({
  product,
  onClose,
  onSaved,
}: {
  product: ProductProfit;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [cost, setCost] = useState(String((product.current_cost_cents ?? 0) / 100));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parseMoneyInput(cost);
    if (cents === null || cents < 0) return setError("Enter the cost per unit.");
    if (!reason.trim()) return setError("Say where this cost comes from.");
    setBusy(true);
    const { error: err } = await getSupabase().rpc("set_product_cost", {
      p_product: product.product_id,
      p_pack_size: null,
      p_cost_cents: cents,
      p_reason: reason.trim(),
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  }

  return (
    <Dialog
      title={`Cost of ${product.name}`}
      onClose={onClose}
      onConfirm={() => void save()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving..." : "Save cost"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        <p className="text-sm text-muted">
          The cost of one unit of this product. Selling at {formatMoney(Number(product.unit_price_cents ?? 0))} with
          this cost gives a profit of{" "}
          {formatMoney(Number(product.unit_price_cents ?? 0) - (parseMoneyInput(cost) ?? 0))} per unit.
        </p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Cost per unit (LKR)</span>
          <input
            className="field"
            data-autofocus
            value={cost}
            onChange={(e) => setCost(e.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Where does this come from?</span>
          <input
            className="field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Supplier invoice 4471, 12 Aug"
          />
        </label>
        <p className="text-xs text-muted">
          This changes the cost from now on. Sales already made keep the cost they were sold at, so past
          reports do not move.
        </p>
      </div>
    </Dialog>
  );
}
