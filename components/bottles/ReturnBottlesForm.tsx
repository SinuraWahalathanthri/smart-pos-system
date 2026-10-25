"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Droplets, Loader2, Undo2 } from "lucide-react";
import { availableToSettle, type ProductBottles } from "@/lib/bottles";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";

interface Loaded {
  rows: ProductBottles[];
  outstanding: number;
}

async function fetchBottles(customerId: string): Promise<{ data?: Loaded; error?: string }> {
  const sb = getSupabase();
  const [byProduct, outstanding] = await Promise.all([
    sb.rpc("customer_bottles_by_product", { p_customer: customerId }),
    sb.rpc("customer_bottles_outstanding", { p_customer: customerId }),
  ]);
  if (byProduct.error) return { error: byProduct.error.message };
  // Never fall back to 0 here. "Owes nothing" on a failed read is the one wrong answer that hides
  // a bottle debt (customer_bottles_outstanding refuses rather than return 0 for the same reason).
  if (outstanding.error) return { error: outstanding.error.message };
  if (typeof outstanding.data !== "number") return { error: "Could not read this customer's bottle count." };
  return {
    data: {
      rows: (byProduct.data as ProductBottles[] | null) ?? [],
      outstanding: outstanding.data,
    },
  };
}

/**
 * Register bottles coming back from ONE customer, or take the deposit instead.
 *
 * Used by the till (F7) and by the owner's bottle screen, because the shop's rule is the same at
 * both: handing the bottle back costs nothing, keeping it and paying the deposit settles the loan.
 * A return is a count, never a choice of which physical bottle, which is why the buttons work per
 * product row rather than per bottle.
 *
 * Only the till can take a deposit (`onCharge`), because a deposit is money and money has to land
 * on a bill - in the sale, its payments and the drawer. Taking one anywhere else would leave cash in
 * someone's hand that no report knows about.
 *
 * `onChanged` receives the customer's new outstanding total, so a caller showing that number (the
 * bill's bottle badge, the dashboard table) can refresh without a second round trip.
 */
export function ReturnBottlesForm({
  customerId,
  customerName,
  feeCents,
  withSale = false,
  pending = {},
  onCharge,
  onChanged,
}: {
  customerId: string;
  customerName: string | null;
  /** The deposit the bill will charge, so the button shows exactly what is taken. */
  feeCents: number;
  /** True at the counter, where the return happens alongside a bill; false at the office. */
  withSale?: boolean;
  /** Deposits already on the bill, per product. They settle their loans once the bill is paid. */
  pending?: Record<string, number>;
  /** Put one deposit for this product on the bill. Absent at the office. */
  onCharge?: (row: ProductBottles) => void;
  onChanged?: (outstanding: number) => void;
}) {
  const [rows, setRows] = useState<ProductBottles[]>([]);
  const [total, setTotal] = useState(0);
  // Which customer the rows on screen belong to. A different customer shows "loading" rather than
  // the previous person's bottles.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A return reloads the rows; a stale reply must not overwrite a newer one.
  const seq = useRef(0);

  const apply = useCallback((data: Loaded) => {
    setRows(data.rows);
    setTotal(data.outstanding);
  }, []);

  useEffect(() => {
    let stale = false;
    void (async () => {
      const { data, error: err } = await fetchBottles(customerId);
      if (stale) return;
      setLoadedFor(customerId);
      setError(err ?? null);
      if (data) apply(data);
      else {
        // Nothing trustworthy to act on: offer no buttons rather than last customer's numbers.
        setRows([]);
        setTotal(0);
      }
    })();
    return () => {
      stale = true;
    };
  }, [customerId, apply]);

  /** Re-read after a return, so both numbers come from the database. */
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    const { data, error: err } = await fetchBottles(customerId);
    if (mine !== seq.current) return;
    setError(err ?? null);
    if (data) apply(data);
  }, [customerId, apply]);

  async function giveBack(productId: string) {
    setBusy(productId);
    setError(null);
    const { data, error: err } = await getSupabase().rpc("return_bottles", {
      p_customer: customerId,
      p_product: productId,
      p_qty: 1,
      p_with_sale: withSale,
    });
    setBusy(null);
    if (err) {
      setError(err.message);
      return;
    }
    // Reload rather than patch locally: the per-product rows move too, and the database is the
    // authority on both numbers.
    const left = (data as { outstanding?: number } | null)?.outstanding;
    await refresh();
    if (typeof left === "number") onChanged?.(left);
  }

  if (loadedFor !== customerId) {
    return <p className="text-sm text-muted">Loading bottles...</p>;
  }

  const pendingTotal = Object.values(pending).reduce((n, q) => n + q, 0);

  return (
    <div className="space-y-3">
      {error ? (
        <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>
      ) : (
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <Droplets size={18} className={total > 0 ? "text-warning" : "text-muted"} />
          <p className="text-sm">
            {total > 0 ? (
              <>
                <span className="font-semibold">{total}</span> bottle{total === 1 ? "" : "s"} still with{" "}
                {customerName ?? "this customer"}
                {feeCents > 0 && (
                  <span className="text-muted"> &middot; {formatMoney(total * feeCents)} in deposits</span>
                )}
                {pendingTotal > 0 && (
                  <span className="text-warning">
                    {" "}
                    &middot; {pendingTotal} deposit{pendingTotal === 1 ? "" : "s"} on this bill
                  </span>
                )}
              </>
            ) : (
              "No bottles outstanding."
            )}
          </p>
        </div>
      )}

      {rows.length === 0 ? (
        !error && (
          <p className="rounded-lg border border-dashed border-border px-3 py-4 text-sm text-muted">
            No bottles recorded against this customer yet. They appear here once a returnable bottle
            is sold with the customer attached to the bill.
          </p>
        )
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {rows.map((r) => {
            const open = availableToSettle(r, total, pending);
            return (
              <li key={r.product_id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{r.name}</p>
                  <p className="text-xs text-muted">
                    {r.sent_out} out &middot; {r.returned} back &middot; {r.charged} deposit
                    {open > 0 && <span className="font-semibold text-warning"> &middot; {open} owing</span>}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    disabled={busy !== null || open < 1}
                    onClick={() => void giveBack(r.product_id)}
                    className="flex min-h-9 items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-xs font-semibold text-success disabled:opacity-40"
                  >
                    {busy === r.product_id ? <Loader2 className="animate-spin" size={12} /> : <Undo2 size={12} />}
                    Bottle back
                  </button>
                  {onCharge && (
                    <button
                      type="button"
                      disabled={busy !== null || open < 1}
                      onClick={() => onCharge(r)}
                      className="min-h-9 rounded-lg bg-warning-soft px-2 py-1 text-xs font-semibold text-warning disabled:opacity-40"
                    >
                      Keep, add {formatMoney(feeCents, false)} to bill
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <p className="text-xs text-muted">
        {onCharge
          ? "Bottle back costs nothing. Keep puts the deposit on this bill: once it is paid the loan is settled and the bottle stays with the customer. Take it off the bill to undo."
          : "Bottle back costs nothing. To take the deposit instead, add it to the customer's bill at the till (F7), so the money is recorded with a sale."}
      </p>
    </div>
  );
}
