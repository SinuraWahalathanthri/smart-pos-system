"use client";

import { useState } from "react";
import { roundQty } from "@/lib/bill";
import { unitLabel } from "@/lib/business";
import { formatMoney, lineTotal } from "@/lib/money";
import type { Product } from "@/lib/types";
import { Button, Dialog } from "../ui/Dialog";

/** Amounts a cashier reaches for most, per unit. Anything else is typed. */
const QUICK: Record<string, number[]> = {
  kg: [0.25, 0.5, 1, 2],
  g: [100, 250, 500],
  l: [0.5, 1, 2, 5],
  ml: [100, 250, 500],
  m: [1, 2, 5, 10],
  cm: [10, 50, 100],
  ft: [1, 5, 10],
  yd: [1, 2, 5],
  sqft: [10, 50, 100],
  hr: [0.5, 1, 2],
};

/**
 * Ring up a measured item (0030): "0.75 kg of rice", "2.5 m of cable". The price on the product is
 * per unit, so the line is amount × price and the bill shows the unit beside the amount.
 *
 * A scale that types into the field (most USB scales act as a keyboard) works here unchanged.
 */
export function MeasureDialog({
  product,
  onAdd,
  onClose,
}: {
  product: Product;
  onAdd: (qty: number) => void;
  onClose: () => void;
}) {
  const unit = product.unit ?? "kg";
  const [value, setValue] = useState("");
  const amount = roundQty(Number(value));
  const valid = Number.isFinite(amount) && amount > 0;

  function commit() {
    if (valid) onAdd(amount);
  }

  return (
    <Dialog
      title={product.name}
      onClose={onClose}
      onConfirm={commit}
      width="max-w-md"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">
            Cancel
          </Button>
          <Button variant="primary" onClick={commit} keycap="Enter" disabled={!valid}>
            Add to bill
          </Button>
        </>
      }
    >
      <p className="mb-2 text-sm text-muted">
        {formatMoney(product.price)} per {unitLabel(unit)}. How much?
      </p>
      <div className="flex items-center gap-2">
        <input
          data-autofocus
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1").slice(0, 9))}
          inputMode="decimal"
          aria-label={`Amount in ${unitLabel(unit)}`}
          placeholder="0.000"
          className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-3 text-center text-3xl font-bold outline-none"
        />
        <span className="w-14 text-lg font-semibold text-muted">{unitLabel(unit)}</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {(QUICK[unit] ?? [1, 2, 5]).map((q) => (
          <Button key={q} variant="secondary" onClick={() => setValue(String(q))}>
            {q} {unitLabel(unit)}
          </Button>
        ))}
      </div>
      <div className="mt-4 flex items-center justify-between rounded-xl bg-surface-2 px-4 py-3">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Line price</span>
        <span className="num text-2xl font-bold" aria-live="polite">
          {valid ? formatMoney(lineTotal(product.price, amount)) : "—"}
        </span>
      </div>
      {product.trackStock !== false && valid && amount > product.stock && (
        <p className="mt-2 text-sm font-medium text-warning">
          Stock shows {product.stock} {unitLabel(unit)}. You can still sell it, but check the shelf.
        </p>
      )}
    </Dialog>
  );
}
