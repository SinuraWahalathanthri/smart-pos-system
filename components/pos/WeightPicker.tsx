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

/** Pick a branded pack size for a spice. Number keys choose, +/- change packets, Enter adds. */
export function WeightPicker({ product, onAdd, onClose }: Props) {
  const startQty = usePos.getState().pendingQty;
  const sizes = product.packSizes;
  const defaultIdx = Math.max(0, sizes.findIndex((s) => s.weightG === 250));
  const [idx, setIdx] = useState(defaultIdx);
  const [qty, setQty] = useState(startQty);
  const pack = sizes[idx];

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
          <p className="text-sm font-semibold uppercase tracking-wider text-muted">Choose pack size</p>
          <p className="text-xs text-muted">Press 1–{sizes.length} · ←/→ to move · ↑/↓ or +/− for packets</p>
        </div>
      </div>

      <div role="radiogroup" aria-label="Pack size" className="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-2">
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
              <Keycap className="absolute left-1.5 top-1.5">{i + 1}</Keycap>
              <span className="mt-3 text-xl font-bold">{s.label}</span>
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
          <span className="text-sm font-semibold text-muted">Packets</span>
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
        <p className="mt-2 text-sm font-medium text-warning">Stock shows 0 for this size. You can still sell it, but check the shelf.</p>
      )}
    </Dialog>
  );
}
