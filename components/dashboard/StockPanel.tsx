"use client";

import { useEffect, useState } from "react";
import { ArrowDownUp, Loader2, SlidersHorizontal } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import type { Category } from "./ProductsScreen";

type PackOption = { id: string; label: string; packets_on_hand: number | string };

type Movement = {
  id: string;
  created_at: string;
  type: string;
  qty_change: number | string;
  pack_label: string | null;
  unit_cost_cents: number | string | null;
  reason: string | null;
  by_name: string | null;
};

type Mode = "receive" | "correct";

/** Why stock left (or turned up) other than through a sale. The first word lands in the ledger. */
const CORRECTIONS = [
  { key: "Damaged", direction: -1 },
  { key: "Expired", direction: -1 },
  { key: "Lost or stolen", direction: -1 },
  { key: "Used in the shop", direction: -1 },
  { key: "Count correction", direction: 0 },
] as const;

const whole = (v: string) => v.replace(/[^0-9]/g, "");
const digits = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");

/**
 * Receive stock into a product, correct it, and show why its count is what it is.
 *
 * Stock is never typed over: receiving posts one `purchase` movement and a correction posts one
 * `adjustment` through adjust_stock(), so the ledger stays the only source of truth for
 * stock_on_hand / packets_on_hand. A correction needs a reason because it is the one movement with
 * no sale or bill behind it - the audit trail is the only explanation it will ever have.
 */
export function StockPanel({
  product,
  weighted,
  currency,
  onClose,
  onDone,
}: {
  product: { id: string; name: string };
  weighted: boolean;
  currency: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [mode, setMode] = useState<Mode>("receive");
  const [packs, setPacks] = useState<PackOption[]>([]);
  const [unitsOnHand, setUnitsOnHand] = useState<number | null>(null);
  const [moves, setMoves] = useState<Movement[]>([]);
  const [packSize, setPackSize] = useState("");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [supplier, setSupplier] = useState("");
  const [note, setNote] = useState("");
  const [why, setWhy] = useState<(typeof CORRECTIONS)[number]["key"]>("Damaged");
  const [countUp, setCountUp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const sb = getSupabase();
    const [{ data: sizes }, { data: history }, { data: prod }] = await Promise.all([
      weighted
        ? sb
            .from("pack_sizes")
            .select("id, label, weight_g, packets_on_hand")
            .eq("product_id", product.id)
            .eq("is_active", true)
            .order("weight_g")
        : Promise.resolve({ data: [] }),
      sb.rpc("product_movements", { p_product: product.id, p_limit: 25 }),
      sb.from("products").select("stock_on_hand").eq("id", product.id).maybeSingle(),
    ]);
    const rows = (sizes as PackOption[] | null) ?? [];
    setPacks(rows);
    setPackSize((cur) => cur || rows[0]?.id || "");
    setUnitsOnHand(prod ? Number((prod as { stock_on_hand: number | string }).stock_on_hand) : null);
    setMoves((history as Movement[] | null) ?? []);
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [product.id]);

  const onHand = weighted ? Number(packs.find((p) => p.id === packSize)?.packets_on_hand ?? 0) : (unitsOnHand ?? 0);
  const qtyNum = Number(qty || "0");
  const missingPack = weighted && !packSize;
  const direction = CORRECTIONS.find((c) => c.key === why)?.direction ?? -1;
  const removing = mode === "correct" && (direction < 0 || (direction === 0 && !countUp));
  const tooMany = removing && qtyNum > onHand;
  const valid = qtyNum > 0 && !missingPack && !tooMany;

  function reset() {
    setQty("");
    setCost("");
    setSupplier("");
    setNote("");
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const { error: err } =
      mode === "receive"
        ? await sb.rpc("receive_stock", {
            p_product: product.id,
            p_pack_size: weighted ? packSize : null,
            p_qty: qtyNum,
            p_unit_cost_cents: cost ? Math.round(Number(cost) * 100) : null,
            p_supplier: supplier.trim() || null,
            p_note: note.trim() || null,
          })
        : await sb.rpc("adjust_stock", {
            p_product: product.id,
            p_pack_size: weighted ? packSize : null,
            p_qty_change: removing ? -qtyNum : qtyNum,
            p_reason: [why, note.trim()].filter(Boolean).join(": "),
            p_token: null,
          });
    setBusy(false);
    if (err) {
      setError(err.message);
      return;
    }
    reset();
    await load();
    onDone();
  }

  const unit = weighted ? "packets" : "units";

  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Stock — {product.name}</h2>
        <div className="flex items-center gap-3">
          <div className="flex rounded-lg border border-border p-0.5 text-sm">
            {(
              [
                ["receive", "Receive"],
                ["correct", "Correct"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setMode(key);
                  setError(null);
                  reset();
                }}
                className={`rounded-md px-2.5 py-1 ${mode === key ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-2"}`}
              >
                {label}
              </button>
            ))}
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted hover:text-text">
            Close
          </button>
        </div>
      </div>

      <form onSubmit={submit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {weighted && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Packet size</span>
              <select className="field" value={packSize} onChange={(e) => setPackSize(e.target.value)}>
                {packs.length === 0 && <option value="">No packet sizes yet</option>}
                {packs.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label} ({Number(p.packets_on_hand)} on hand)
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode === "correct" && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">What happened</span>
              <select className="field" value={why} onChange={(e) => setWhy(e.target.value as typeof why)}>
                {CORRECTIONS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.key}
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode === "correct" && direction === 0 && (
            <label className="block">
              <span className="mb-1 block text-sm font-medium">The shelf has</span>
              <select className="field" value={countUp ? "more" : "fewer"} onChange={(e) => setCountUp(e.target.value === "more")}>
                <option value="fewer">Fewer than the system says</option>
                <option value="more">More than the system says</option>
              </select>
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-sm font-medium">
              {mode === "receive"
                ? weighted
                  ? "Packets received"
                  : "Quantity received"
                : removing
                  ? `${weighted ? "Packets" : "Quantity"} to remove`
                  : `${weighted ? "Packets" : "Quantity"} to add`}
            </span>
            <input
              className="field font-mono"
              inputMode="numeric"
              autoFocus
              value={qty}
              onChange={(e) => setQty(whole(e.target.value))}
              placeholder="0"
            />
            {mode === "correct" && (
              <span className={`mt-1 block text-xs ${tooMany ? "text-danger" : "text-muted"}`}>
                {onHand} {unit} on hand
                {qtyNum > 0 && !tooMany && ` → ${removing ? onHand - qtyNum : onHand + qtyNum} after this`}
                {tooMany && " - you cannot remove more than that"}
              </span>
            )}
          </label>

          {mode === "receive" && (
            <>
              <label className="block">
                <span className="mb-1 block text-sm font-medium">Unit cost ({currency}, optional)</span>
                <input
                  className="field font-mono"
                  inputMode="decimal"
                  value={cost}
                  onChange={(e) => setCost(digits(e.target.value))}
                  placeholder="Optional"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium">Supplier (optional)</span>
                <input
                  className="field"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                  placeholder="e.g. Kandy market"
                  maxLength={80}
                />
              </label>
            </>
          )}

          <label className="block sm:col-span-2">
            <span className="mb-1 block text-sm font-medium">Note (optional)</span>
            <input
              className="field"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === "receive" ? "e.g. Weekly run" : "e.g. Rats got into the sack"}
              maxLength={120}
            />
          </label>
        </div>

        {missingPack && <p className="text-sm text-danger">This product has no packet sizes. Add them in Edit first.</p>}
        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={!valid || busy}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="animate-spin" size={14} />
          ) : mode === "receive" ? (
            <ArrowDownUp size={14} />
          ) : (
            <SlidersHorizontal size={14} />
          )}{" "}
          {mode === "receive" ? "Receive stock" : "Save correction"}
        </button>
      </form>

      <div>
        <h3 className="mb-2 text-sm font-medium">Recent movements</h3>
        {moves.length === 0 ? (
          <p className="text-sm text-muted">No movements yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-1.5">When</th>
                  <th className="px-3 py-1.5">Type</th>
                  <th className="px-3 py-1.5">Packet</th>
                  <th className="px-3 py-1.5 text-right">Change</th>
                  <th className="px-3 py-1.5 text-right">Unit cost</th>
                  <th className="px-3 py-1.5">Detail</th>
                </tr>
              </thead>
              <tbody>
                {moves.map((m) => {
                  const change = Number(m.qty_change);
                  return (
                    <tr key={m.id} className="border-t border-border">
                      <td className="px-3 py-1.5 text-muted">
                        {new Date(m.created_at).toLocaleString(undefined, {
                          dateStyle: "short",
                          timeStyle: "short",
                        })}
                      </td>
                      <td className="px-3 py-1.5 capitalize">{m.type.replace(/_/g, " ")}</td>
                      <td className="px-3 py-1.5 text-muted">{m.pack_label ?? "-"}</td>
                      <td className={`px-3 py-1.5 text-right font-mono ${change < 0 ? "text-danger" : "text-success"}`}>
                        {change > 0 ? `+${change}` : change}
                      </td>
                      <td className="px-3 py-1.5 text-right font-mono text-muted">
                        {m.unit_cost_cents == null ? "-" : formatMoney(Number(m.unit_cost_cents))}
                      </td>
                      <td className="px-3 py-1.5 text-muted">
                        {[m.reason, m.by_name].filter(Boolean).join(" · ") || "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
