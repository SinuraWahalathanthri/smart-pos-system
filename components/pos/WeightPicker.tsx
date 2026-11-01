"use client";

import { useState } from "react";
import { Minus, Plus } from "lucide-react";
import { PACK_LOW_STOCK } from "@/lib/config";
import { formatMoney, lineTotal } from "@/lib/money";
import { usePos } from "@/lib/store";
import type { PackSize, Product } from "@/lib/types";
import { Button, Dialog, Keycap } from "../ui/Dialog";

interface Props {
  product: Product;
  onAdd: (pack: PackSize, qty: number) => void;
  onClose: () => void;
}

/**
 * Pick one of a product's options: a packet size for a weighted product, or a size/colour for a
 * variant one (0030). Number keys choose, +/- change the quantity, Enter adds.
 *
 * A variant product with two axes (Size × Colour) also gets a row of chips per axis, so a cashier
 * can tap "M" then "Black" instead of hunting through eighteen tiles.
 */
export function WeightPicker({ product, onAdd, onClose }: Props) {
  const startQty = usePos.getState().pendingQty;
  const variant = product.saleMode === "variant";
  const all = product.packSizes;
  const axes = variant ? axesOf(all) : [];
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const sizes = all.filter((s) => Object.entries(chosen).every(([k, v]) => s.attributes?.[k] === v));
  const firstInStock = sizes.findIndex((s) => s.stock > 0);
  const defaultIdx = variant ? Math.max(0, firstInStock) : Math.max(0, sizes.findIndex((s) => s.weightG === 250));
  const [picked, setIdx] = useState(defaultIdx);
  const idx = Math.min(picked, Math.max(0, sizes.length - 1));
  const [qty, setQty] = useState(startQty);
  const pack = sizes[idx];
  const noun = variant ? "option" : "pack size";
  const qtyLabel = variant ? "Quantity" : "Packets";

  function choose(axis: string, value: string) {
    setChosen((c) => (c[axis] === value ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== axis)) : { ...c, [axis]: value }));
    setIdx(0);
  }

  function commit() {
    if (pack) onAdd(pack, qty);
  }

  function onKey(e: React.KeyboardEvent): boolean {
    if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (i < sizes.length) {
        setIdx(i);
        e.preventDefault();
      }
      return true;
    }
    if (e.key === "ArrowLeft") return (setIdx((i) => Math.max(0, i - 1)), e.preventDefault(), true);
    if (e.key === "ArrowRight") return (setIdx((i) => Math.min(sizes.length - 1, i + 1)), e.preventDefault(), true);
    if (e.key === "ArrowUp" || e.key === "+" || e.key === "=") return (setQty((q) => Math.min(99, q + 1)), e.preventDefault(), true);
    if (e.key === "ArrowDown" || e.key === "-") return (setQty((q) => Math.max(1, q - 1)), e.preventDefault(), true);
    return false;
  }

  return (
    <Dialog
      title={product.name}
      onClose={onClose}
      onConfirm={commit}
      onKey={onKey}
      width="max-w-2xl"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">
            Cancel
          </Button>
          <Button variant="primary" onClick={commit} keycap="Enter" data-autofocus>
            Add to bill
          </Button>
        </>
      }
    >
      <div className="mb-3 flex items-center gap-3">
        <div
          className="grid h-14 w-14 place-items-center rounded-lg text-xl font-bold"
          style={{ background: `${product.color}22`, color: product.color }}
        >
          {product.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join("")}
        </div>
        <div>
          <p className="text-sm font-semibold uppercase tracking-wider text-muted">Choose {noun}</p>
          <p className="text-xs text-muted">
            Press 1–{Math.min(9, sizes.length)} · ←/→ to move · ↑/↓ or +/− for {qtyLabel.toLowerCase()}
          </p>
        </div>
      </div>

      {axes.length > 1 && (
        <div className="mb-3 space-y-2">
          {axes.map((a) => (
            <div key={a.name} className="flex flex-wrap items-center gap-1.5">
              <span className="w-16 text-xs font-semibold uppercase tracking-wider text-muted">{a.name}</span>
              {a.values.map((v) => (
                <button
                  key={v}
                  type="button"
                  aria-pressed={chosen[a.name] === v}
                  onClick={() => choose(a.name, v)}
                  className={`rounded-full border px-3 py-1 text-sm font-medium ${
                    chosen[a.name] === v ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface-2 hover:border-muted"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
      {sizes.length === 0 && <p className="mb-2 text-sm text-muted">No option matches. Tap a chip again to clear it.</p>}

      <div role="radiogroup" aria-label={variant ? "Option" : "Pack size"} className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
        {sizes.map((s, i) => {
          const out = s.stock <= 0;
          const low = !out && s.stock <= PACK_LOW_STOCK;
          return (
            <button
              key={s.id}
              type="button"
              role="radio"
              aria-checked={i === idx}
              onClick={() => setIdx(i)}
              className={`relative flex flex-col items-center gap-0.5 rounded-xl border-2 px-2 py-3 transition ${
                i === idx ? "border-primary bg-primary-soft" : "border-border bg-surface-2 hover:border-muted"
              } ${out ? "opacity-60" : ""}`}
            >
              {i < 9 && <Keycap className="absolute left-1.5 top-1.5">{i + 1}</Keycap>}
              <span className={`mt-3 text-center font-bold ${variant ? "text-base" : "text-xl"}`}>{s.label}</span>
              <span className="num text-base font-semibold">{formatMoney(s.price, false)}</span>
              <span
                className={`num text-xs font-semibold ${out ? "text-danger" : low ? "text-warning" : "text-muted"}`}
              >
                {out ? "Out of stock" : low ? `LOW ${s.stock}` : `${s.stock} in stock`}
              </span>
              {s.barcode ? <span className="font-mono text-[9px] text-muted">▌▌▌ barcoded</span> : <span className="h-3" />}
            </button>
          );
        })}
      </div>

      <div className="mt-4 flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-muted">{qtyLabel}</span>
          <Button variant="secondary" className="h-10 w-10 !px-0" aria-label="Fewer" onClick={() => setQty((q) => Math.max(1, q - 1))}>
            <Minus size={16} />
          </Button>
          <span className="num w-10 text-center text-2xl font-bold">{qty}</span>
          <Button variant="secondary" className="h-10 w-10 !px-0" aria-label="More" onClick={() => setQty((q) => Math.min(99, q + 1))}>
            <Plus size={16} />
          </Button>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted">Line price</p>
          <p className="num text-2xl font-bold" aria-live="polite">
            {pack ? `${pack.label} × ${qty} = ${formatMoney(lineTotal(pack.price, qty))}` : "—"}
          </p>
        </div>
      </div>
      {pack && pack.stock <= 0 && (
        <p className="mt-2 text-sm font-medium text-warning">Stock shows 0 for this {noun}. You can still sell it, but check the shelf.</p>
      )}
    </Dialog>
  );
}

/** The axes a variant product's options use, with their values in first-seen order. */
function axesOf(options: PackSize[]): { name: string; values: string[] }[] {
  const map = new Map<string, string[]>();
  for (const o of options) {
    for (const [k, v] of Object.entries(o.attributes ?? {})) {
      const vals = map.get(k) ?? [];
      if (!vals.includes(v)) vals.push(v);
      map.set(k, vals);
    }
  }
  return [...map.entries()].map(([name, values]) => ({ name, values }));
}
