"use client";

import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Receipt, Search } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { permissions, useShop } from "./useShop";

type Receipt = {
  id: string;
  receipt_no: number;
  created_at: string;
  cashier_name: string | null;
  customer_id: string | null;
  customer_name: string | null;
  item_count: number;
  subtotal_cents: number;
  discount_cents: number;
  total_cents: number;
  points_earned: number;
  status: "completed" | "voided" | "refunded";
};

type ReceiptLine = {
  name: string;
  label: string | null;
  qty: number | string;
  unit_price_cents: number | string;
  line_total_cents: number | string;
  kind: string;
  status: "active" | "voided";
  void_reason: string | null;
};

type Range = "today" | "7d" | "30d" | "all";

const RANGES: { key: Range; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All" },
];

function rangeStart(range: Range): string | null {
  if (range === "all") return null;
  const d = new Date();
  if (range === "today") d.setHours(0, 0, 0, 0);
  if (range === "7d") d.setDate(d.getDate() - 7);
  if (range === "30d") d.setDate(d.getDate() - 30);
  return d.toISOString();
}

/**
 * Every receipt the shop has issued.
 *
 * The ledger is append-only, so this is a read-only view: a mistake is corrected by a void at the
 * till, never by editing history here. Points are shown per receipt because that is the number a
 * customer will ask about.
 */
export function ReceiptsScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);

  return (
    <DashboardShell>
      {can.viewAnalytics ? <ReceiptList currency={ctx?.store?.currency ?? "LKR"} /> : <NotAllowed what="receipts" role={ctx?.role} />}
    </DashboardShell>
  );
}

function ReceiptList({ currency }: { currency: string }) {
  const [rows, setRows] = useState<Receipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<Range>("30d");
  const [query, setQuery] = useState("");
  const [openId, setOpenId] = useState<string | null>(null);
  const [lines, setLines] = useState<ReceiptLine[]>([]);
  const [linesLoading, setLinesLoading] = useState(false);

  useEffect(() => {
    let stale = false;
    void (async () => {
      setLoading(true);
      setError(null);
      const { data, error: err } = await getSupabase().rpc("sale_history", {
        p_from: rangeStart(range),
        p_to: null,
        p_query: query.trim() || null,
        p_limit: 100,
        p_offset: 0,
      });
      if (stale) return;
      setLoading(false);
      if (err) {
        setError(err.message);
        return;
      }
      setRows((data as Receipt[] | null) ?? []);
    })();
    return () => {
      stale = true;
    };
  }, [range, query]);

  const totals = useMemo(
    () => ({
      count: rows.length,
      revenue: rows.reduce((a, r) => a + Number(r.total_cents), 0),
      points: rows.reduce((a, r) => a + Number(r.points_earned), 0),
    }),
    [rows],
  );

  async function toggle(r: Receipt) {
    if (openId === r.id) {
      setOpenId(null);
      return;
    }
    setOpenId(r.id);
    setLinesLoading(true);
    const { data } = await getSupabase().rpc("sale_detail", { p_sale: r.id });
    setLinesLoading(false);
    setLines((data as ReceiptLine[] | null) ?? []);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Receipts</h1>
          <p className="text-sm text-muted">Every completed order, newest first.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-border p-0.5">
            {RANGES.map((r) => (
              <button
                key={r.key}
                onClick={() => setRange(r.key)}
                className={`rounded-md px-2.5 py-1 text-sm ${range === r.key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-2"}`}
              >
                {r.label}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-2.5 text-muted" size={16} />
            <input
              className="field pl-8"
              placeholder="Receipt no. or customer"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      </div>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Receipts" value={String(totals.count)} />
        <Stat label={`Revenue (${currency})`} value={formatMoney(totals.revenue)} />
        <Stat label="Points awarded" value={String(totals.points)} />
      </div>

      {loading ? (
        <p className="text-sm text-muted">Loading receipts...</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <Receipt className="mx-auto mb-2 text-muted" size={22} />
          <p className="text-sm text-muted">
            {query.trim() ? "No receipt matches that search." : "No receipts in this period yet."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2"></th>
                <th className="px-3 py-2">Receipt</th>
                <th className="px-3 py-2">When</th>
                <th className="px-3 py-2">Customer</th>
                <th className="px-3 py-2">Cashier</th>
                <th className="px-3 py-2 text-right">Items</th>
                <th className="px-3 py-2 text-right">Points</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Row key={r.id} r={r} open={openId === r.id} lines={lines} linesLoading={linesLoading} onToggle={() => void toggle(r)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="num mt-1 text-lg font-semibold">{value}</p>
    </div>
  );
}

function Row({
  r,
  open,
  lines,
  linesLoading,
  onToggle,
}: {
  r: Receipt;
  open: boolean;
  lines: ReceiptLine[];
  linesLoading: boolean;
  onToggle: () => void;
}) {
  const voided = r.status !== "completed";
  return (
    <>
      <tr className={`cursor-pointer border-t border-border hover:bg-surface-2 ${voided ? "opacity-60" : ""}`} onClick={onToggle}>
        <td className="px-3 py-2 text-muted">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
        <td className="px-3 py-2 font-mono">
          #{r.receipt_no}
          {voided && <span className="ml-1 text-xs text-danger">(voided)</span>}
        </td>
        <td className="px-3 py-2 text-muted">
          {new Date(r.created_at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}
        </td>
        <td className="px-3 py-2">{r.customer_name ?? <span className="text-muted">Walk-in</span>}</td>
        <td className="px-3 py-2 text-muted">{r.cashier_name ?? "-"}</td>
        <td className="px-3 py-2 text-right font-mono">{r.item_count}</td>
        <td className="px-3 py-2 text-right font-mono">{Number(r.points_earned) || "-"}</td>
        <td className="px-3 py-2 text-right font-mono font-medium">{formatMoney(Number(r.total_cents))}</td>
      </tr>
      {open && (
        <tr className="border-t border-border bg-surface-2">
          <td colSpan={8} className="px-4 py-3">
            {linesLoading ? (
              <p className="text-sm text-muted">Loading lines...</p>
            ) : lines.length === 0 ? (
              <p className="text-sm text-muted">No lines recorded.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-xs uppercase text-muted">
                  <tr>
                    <th className="py-1">Item</th>
                    <th className="py-1 text-right">Qty</th>
                    <th className="py-1 text-right">Unit</th>
                    <th className="py-1 text-right">Line</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={i} className={l.status === "voided" ? "text-muted line-through" : ""}>
                      <td className="py-1">
                        {l.name}
                        {l.label ? ` (${l.label})` : ""}
                        {l.status === "voided" && l.void_reason ? ` - ${l.void_reason}` : ""}
                      </td>
                      <td className="py-1 text-right font-mono">{Number(l.qty)}</td>
                      <td className="py-1 text-right font-mono">{formatMoney(Number(l.unit_price_cents))}</td>
                      <td className="py-1 text-right font-mono">{formatMoney(Number(l.line_total_cents))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {Number(r.discount_cents) > 0 && (
              <p className="mt-2 text-xs text-muted">Discount applied: {formatMoney(Number(r.discount_cents))}</p>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
