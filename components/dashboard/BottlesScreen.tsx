"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Droplets, Search, Undo2 } from "lucide-react";
import {
  byMostOwed,
  emptyShopTotals,
  eventLabel,
  matchesQuery,
  returnedPct,
  toShopTotals,
  type BottleEvent,
  type CustomerBottles,
  type ShopBottleTotals,
} from "@/lib/bottles";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { ReturnBottlesForm } from "../bottles/ReturnBottlesForm";
import { Button, Dialog } from "../ui/Dialog";
import { DashboardShell } from "./DashboardShell";
import { useShop } from "./useShop";

/**
 * Bottles, by customer.
 *
 * Every role sees this: the cashier is the person a bottle is handed to, and a count they cannot
 * check is a count that quietly goes wrong. The server decides nothing by role here for the same
 * reason - `customer_bottle_summary`, `bottle_totals` and `bottle_events` are per-shop, not per-role.
 *
 * Returns only. A deposit is money, so it is taken on a bill at the till (F7), where it lands in the
 * sale, its payments and the drawer.
 *
 * The three numbers that matter are "out", "back" and "still owing". A bottle that was charged for
 * counts as settled (the shop has the deposit instead of the bottle), which is why it appears with
 * the returns rather than the outstanding column.
 */
export function BottlesScreen() {
  const { ctx } = useShop();
  const fee = ctx?.store?.bottle_fee_cents ?? 0;
  return (
    <DashboardShell>
      <BottleBook fee={fee} />
    </DashboardShell>
  );
}

interface Loaded {
  rows: CustomerBottles[];
  events: BottleEvent[];
  totals: ShopBottleTotals;
}

function BottleBook({ fee }: { fee: number }) {
  const [rows, setRows] = useState<CustomerBottles[]>([]);
  const [events, setEvents] = useState<BottleEvent[]>([]);
  const [totals, setTotals] = useState<ShopBottleTotals>(emptyShopTotals());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [onlyOutstanding, setOnlyOutstanding] = useState(true);
  const [editing, setEditing] = useState<CustomerBottles | null>(null);
  const seq = useRef(0);

  /**
   * All reads in one call, outside the component, so the effect does not have to call a state
   * setter synchronously - and so the list, the totals and the feed come from the same moment.
   *
   * The totals are their own query. Adding up the list would only count the customers it shows -
   * by default those still owing, one page of them - and every customer who brought everything
   * back would vanish from "given out" and "came back".
   */
  const fetchBook = useCallback(async (): Promise<{ data?: Loaded; error?: string }> => {
    const sb = getSupabase();
    const [summary, feed, shop] = await Promise.all([
      sb.rpc("customer_bottle_summary", { p_only_outstanding: onlyOutstanding, p_limit: 500 }),
      sb.rpc("bottle_events", { p_limit: 40 }),
      sb.rpc("bottle_totals"),
    ]);
    const failed = summary.error ?? shop.error ?? feed.error;
    if (failed) return { error: failed.message };
    return {
      data: {
        rows: (summary.data as CustomerBottles[] | null) ?? [],
        events: (feed.data as BottleEvent[] | null) ?? [],
        totals: toShopTotals(shop.data),
      },
    };
  }, [onlyOutstanding]);

  const apply = useCallback((data: Loaded) => {
    setRows(data.rows);
    setEvents(data.events);
    setTotals(data.totals);
  }, []);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const { data, error: err } = await fetchBook();
      if (stale) return;
      setLoading(false);
      setError(err ?? null);
      if (data) apply(data);
    })();
    return () => {
      stale = true;
    };
  }, [fetchBook, apply]);

  /** Re-read after a return registered from this screen. */
  const reload = useCallback(async () => {
    const mine = ++seq.current;
    const { data, error: err } = await fetchBook();
    if (mine !== seq.current) return;
    setError(err ?? null);
    if (data) apply(data);
  }, [fetchBook, apply]);

  const shown = useMemo(() => rows.filter((r) => matchesQuery(r, query)).sort(byMostOwed), [rows, query]);
  const owing = totals.customers_owing;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Bottles</h1>
          <p className="text-sm text-muted">
            Returnable bottles are a loan to a customer. Handing one back is free; keeping it means
            the {formatMoney(fee)} deposit is taken instead.
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-2 top-2.5 text-muted" size={16} />
          <input
            className="field pl-8"
            placeholder="Customer or mobile"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Still out" value={String(totals.outstanding)} hint={`${owing} customer${owing === 1 ? "" : "s"}`} tone="warning" />
        <Stat label="Deposits at risk" value={formatMoney(totals.outstanding * fee)} hint="If none came back" />
        <Stat label="Given out" value={String(totals.sent_out)} hint={`${returnedPct(totals)}% settled`} />
        <Stat label="Came back" value={String(totals.returned)} hint={`${totals.charged} deposit${totals.charged === 1 ? "" : "s"} kept`} />
      </div>
      {totals.walk_in_out > 0 && (
        <p className="text-xs text-muted">
          Plus {totals.walk_in_out} bottle{totals.walk_in_out === 1 ? "" : "s"} sold to walk-in customers, which
          cannot be chased because no one was attached to the bill.
        </p>
      )}

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Who has our bottles</h2>
          <label className="flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={onlyOutstanding}
              onChange={(e) => setOnlyOutstanding(e.target.checked)}
              className="h-4 w-4 accent-[var(--primary)]"
            />
            Only customers who still have one
          </label>
        </div>

        {loading ? (
          <p className="text-sm text-muted">Loading bottles...</p>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-6 text-center">
            <Droplets className="mx-auto mb-2 text-muted" size={22} />
            <p className="text-sm text-muted">
              {rows.length === 0
                ? onlyOutstanding
                  ? "Every bottle has come back. Nothing outstanding."
                  : "No bottles have gone out yet."
                : "Nothing matches that search."}
            </p>
            {onlyOutstanding && (
              <button className="mt-2 text-sm text-primary underline" onClick={() => setOnlyOutstanding(false)}>
                Show every customer
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Mobile</th>
                  <th className="px-4 py-2 text-right">Out</th>
                  <th className="px-4 py-2 text-right">Back</th>
                  <th className="px-4 py-2 text-right">Deposit kept</th>
                  <th className="px-4 py-2 text-right">Owing</th>
                  <th className="px-4 py-2 text-right">Worth</th>
                  <th className="px-4 py-2 text-right">Last out</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.customer_id} className="border-t border-border">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2 font-mono text-muted">{r.phone ?? "-"}</td>
                    <td className="px-4 py-2 text-right font-mono">{r.sent_out}</td>
                    <td className="px-4 py-2 text-right font-mono text-success">{r.returned || "-"}</td>
                    <td className="px-4 py-2 text-right font-mono">{r.charged || "-"}</td>
                    <td className="px-4 py-2 text-right font-mono font-semibold text-warning">
                      {r.outstanding || "-"}
                    </td>
                    <td className="px-4 py-2 text-right font-mono">{formatMoney(Number(r.worth_cents))}</td>
                    <td className="px-4 py-2 text-right text-muted">
                      {r.last_out_at ? new Date(r.last_out_at).toLocaleDateString() : "-"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        disabled={r.outstanding < 1}
                        onClick={() => setEditing(r)}
                        className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-xs font-semibold text-success disabled:opacity-40"
                      >
                        <Undo2 size={12} /> Return
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Recent bottle movements</h2>
        {events.length === 0 ? (
          <p className="rounded-xl border border-dashed border-border p-4 text-sm text-muted">
            Nothing recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-4 py-2">When</th>
                  <th className="px-4 py-2">Customer</th>
                  <th className="px-4 py-2">Product</th>
                  <th className="px-4 py-2">What</th>
                  <th className="px-4 py-2 text-right">Bottles</th>
                  <th className="px-4 py-2 text-right">Money</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="px-4 py-2 whitespace-nowrap text-muted">
                      {new Date(e.created_at).toLocaleString()}
                    </td>
                    {/* A walk-in sale has no customer, and pretending otherwise would invent a debtor. */}
                    <td className="px-4 py-2 font-medium">{e.customer_name ?? "Walk-in"}</td>
                    <td className="px-4 py-2 text-muted">{e.product_name ?? "-"}</td>
                    <td className="px-4 py-2">{eventLabel(e)}</td>
                    <td className="px-4 py-2 text-right font-mono">{e.qty}</td>
                    <td className="px-4 py-2 text-right font-mono">
                      {Number(e.amount_cents) !== 0 ? formatMoney(Number(e.amount_cents)) : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {editing && (
        <Dialog
          title={`Bottles - ${editing.name}`}
          onClose={() => setEditing(null)}
          width="max-w-md"
          footer={
            <Button variant="primary" onClick={() => setEditing(null)}>
              Done
            </Button>
          }
        >
          <ReturnBottlesForm
            customerId={editing.customer_id}
            customerName={editing.name}
            feeCents={fee}
            onChanged={() => void reload()}
          />
        </Dialog>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning";
}) {
  return (
    <div className={`rounded-xl border bg-surface p-4 ${tone === "warning" ? "border-warning/40" : "border-border"}`}>
      <div className="flex items-center gap-2 text-xs uppercase text-muted">
        <Droplets size={14} />
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}
