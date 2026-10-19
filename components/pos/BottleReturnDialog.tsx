"use client";

import { useEffect, useState } from "react";
import { Droplets, Loader2, Undo2 } from "lucide-react";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import { usePos } from "@/lib/store";
import { Dialog, Button } from "../ui/Dialog";

type Bottled = { product_id: string; name: string; bottles_out: number };

/**
 * Register bottles coming back, at the counter.
 *
 * Only reachable once a customer is attached - a bottle belongs to a person, not to a bill, which is
 * what lets the dashboard say who still has them. The shop's rule: handing the bottle back costs
 * nothing; keeping it and paying the deposit settles the loan instead.
 */
export function BottleReturnDialog({ onClose }: { onClose: () => void }) {
  const notify = usePos((s) => s.notify);
  const customerId = usePos((s) => s.customerId);
  const customerName = usePos((s) => s.customerName);

  const [rows, setRows] = useState<Bottled[]>([]);
  const [outstanding, setOutstanding] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!customerId) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const sb = getSupabase();
    const [{ data: count }, { data: products }] = await Promise.all([
      sb.rpc("customer_bottles_outstanding", { p_customer: customerId }),
      sb.from("products").select("id, name").eq("is_returnable_bottle", true).is("archived_at", null),
    ]);
    setOutstanding(typeof count === "number" ? count : 0);
    setRows(((products as { id: string; name: string }[] | null) ?? []).map((p) => ({ product_id: p.id, name: p.name, bottles_out: 0 })));
    setLoading(false);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId]);

  async function act(fn: "return_bottles" | "charge_bottle_fee", productId: string) {
    if (!customerId) return;
    setBusy(true);
    setError(null);
    const { data, error: err } = await getSupabase().rpc(fn, {
      p_customer: customerId,
      p_product: productId,
      ...(fn === "return_bottles" ? { p_qty: 1, p_with_sale: true } : { p_qty: 1 }),
    });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    const left = (data as { outstanding?: number } | null)?.outstanding ?? 0;
    notify(
      fn === "return_bottles"
        ? `Bottle returned${left > 0 ? ` - ${left} still out` : ""}`
        : `Deposit charged${left > 0 ? ` - ${left} still out` : ""}`,
      "success",
    );
    setOutstanding(left);
  }

  if (!isConnected()) {
    return (
      <Dialog title="Bottles" onClose={onClose} onConfirm={onClose} width="max-w-sm">
        <p className="text-sm text-muted">Bottle returns need a database connection.</p>
      </Dialog>
    );
  }

  if (!customerId) {
    return (
      <Dialog title="Bottles" onClose={onClose} onConfirm={onClose} width="max-w-sm">
        <p className="text-sm text-muted">
          Attach the customer first (F8). Bottles belong to a person, so the shop can tell who still has them.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Bottles - ${customerName ?? "customer"}`}
      onClose={onClose}
      width="max-w-md"
      footer={<Button variant="primary" onClick={onClose} keycap="Enter">Done</Button>}
    >
      <div className="space-y-3">
        <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2">
          <Droplets size={18} className={outstanding > 0 ? "text-warning" : "text-muted"} />
          <p className="text-sm">
            {loading ? (
              "Checking..."
            ) : outstanding > 0 ? (
              <>
                <span className="font-semibold">{outstanding}</span> bottle{outstanding === 1 ? "" : "s"} still with this
                customer
              </>
            ) : (
              "No bottles outstanding."
            )}
          </p>
        </div>

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        {loading ? (
          <p className="text-sm text-muted">Loading...</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">
            No returnable products in the catalogue yet. Mark one as bottled under Products.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((r) => (
              <li key={r.product_id} className="flex items-center justify-between gap-2 px-3 py-2">
                <span className="text-sm">{r.name}</span>
                <div className="flex gap-1">
                  <button
                    disabled={busy || outstanding < 1}
                    onClick={() => void act("return_bottles", r.product_id)}
                    className="flex items-center gap-1 rounded-lg bg-success-soft px-2 py-1 text-xs text-success disabled:opacity-40"
                  >
                    {busy ? <Loader2 className="animate-spin" size={12} /> : <Undo2 size={12} />} Bottle back
                  </button>
                  <button
                    disabled={busy || outstanding < 1}
                    onClick={() => void act("charge_bottle_fee", r.product_id)}
                    className="rounded-lg bg-warning-soft px-2 py-1 text-xs text-warning disabled:opacity-40"
                  >
                    Charge deposit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="text-xs text-muted">
          Bottle back costs nothing. Charge deposit keeps the bottle with the customer and takes the fee instead.
        </p>
      </div>
    </Dialog>
  );
}
