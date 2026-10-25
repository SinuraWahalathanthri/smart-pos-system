"use client";

import { useState } from "react";
import { Minus, Plus, ScanLine } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { playCue } from "@/lib/sound";
import { usePos } from "@/lib/store";
import type { BillLine, Product } from "@/lib/types";
import { useShake } from "@/lib/useShake";
import { Button, Dialog } from "../ui/Dialog";

const REASONS = ["Wrong item", "Double scan", "Customer changed mind", "Price issue"];

function barcodeOf(line: BillLine, products: Product[]): string | undefined {
  const p = products.find((x) => x.id === line.productId);
  if (!p) return undefined;
  return line.packSizeId ? p.packSizes.find((s) => s.id === line.packSizeId)?.barcode : p.barcode;
}

/**
 * Keels-style removal, step two (the supervisor has already approved):
 * scan the offending item's barcode (or press Enter to remove the selected line), pick a reason,
 * and the line is struck through, never silently deleted.
 */
export function VoidDialog({ lineId, approver, products, onClose }: { lineId: string; approver: string; products: Product[]; onClose: () => void }) {
  const lines = usePos((s) => s.lines);
  const { voidLine, notify } = usePos.getState();

  const [targetId, setTargetId] = useState(lineId);
  const [scan, setScan] = useState("");
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState(REASONS[0]);
  const [shakeRef, shake] = useShake<HTMLDivElement>();

  const target = lines.find((l) => l.id === targetId && !l.voided);

  function retarget(id: string) {
    setTargetId(id);
    setQty(1);
  }

  function confirm() {
    const code = scan.trim();
    if (code) {
      const hit = lines.find((l) => !l.voided && barcodeOf(l, products) === code);
      if (!hit) {
        setScan("");
        shake();
        playCue("error");
        notify("That barcode isn't on this bill. Spice packs without a barcode: press Enter to remove the highlighted line.", "error");
        return;
      }
      setScan("");
      if (hit.qty === 1) {
        // Scan-to-remove: one unit, removed at once (the Keels counter flow).
        voidLine(hit.id, 1, reason, approver);
        playCue("attention");
        notify(`Removed ${hit.name}${hit.label ? " " + hit.label : ""} (${reason})`, "success");
        onClose();
        return;
      }
      retarget(hit.id);
      playCue("ok");
      notify(`${hit.name}: choose how many to remove, then press Enter`, "info");
      return;
    }
    if (!target) {
      notify("Select a line to remove", "warn");
      return;
    }
    voidLine(target.id, qty, reason, approver);
    playCue("attention");
    notify(`Removed ${qty} × ${target.name}${target.label ? " " + target.label : ""} (${reason})`, "success");
    onClose();
  }

  return (
    <Dialog
      title="Remove item from bill"
      onClose={onClose}
      onConfirm={confirm}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">
            Cancel
          </Button>
          <Button variant="danger" onClick={confirm} keycap="Enter" disabled={!target && scan.trim() === ""}>
            {scan.trim() ? "Find item" : "Remove"}
          </Button>
        </>
      }
    >
      <p className="mb-3 text-sm text-muted">
        Approved by <strong className="text-text">{approver}</strong>. Scan the item to remove, or press Enter to remove the highlighted line.
      </p>

      <div ref={shakeRef}>
        <div className="flex items-center gap-2 rounded-xl border-2 border-primary px-3">
          <ScanLine size={20} className="text-primary" />
          <input
            data-autofocus
            value={scan}
            onChange={(e) => setScan(e.target.value)}
            placeholder="Scan the item's barcode…"
            aria-label="Scan item to remove"
            autoComplete="off"
            className="h-12 min-w-0 flex-1 bg-transparent text-lg outline-none"
          />
        </div>
      </div>

      <ul className="mt-3 max-h-44 overflow-y-auto rounded-lg border border-border">
        {lines.filter((l) => !l.voided).map((l) => (
          <li key={l.id}>
            <button
              type="button"
              onClick={() => retarget(l.id)}
              className={`flex w-full items-center justify-between px-3 py-2 text-left ${l.id === targetId ? "bg-danger-soft text-danger" : "hover:bg-surface-2"}`}
            >
              <span className="truncate font-medium">
                {l.name} {l.label && <span className="text-sm opacity-80">{l.label}</span>}
              </span>
              <span className="num shrink-0 text-sm">
                {l.qty} × {formatMoney(l.unitPrice, false)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {target && (
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="text-sm font-semibold text-muted">
            Reason
            <select
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 h-11 w-full rounded-lg border border-border bg-surface px-2 text-base font-medium text-text"
            >
              {REASONS.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
          <div className="text-sm font-semibold text-muted">
            Quantity to remove
            <div className="mt-1 flex items-center gap-2">
              <Button className="h-11 w-11 !px-0" aria-label="Fewer" disabled={qty <= 1} onClick={() => setQty((q) => Math.max(1, q - 1))}>
                <Minus size={16} />
              </Button>
              <span className="num w-10 text-center text-xl font-bold text-text">{qty}</span>
              <Button className="h-11 w-11 !px-0" aria-label="More" disabled={qty >= target.qty} onClick={() => setQty((q) => Math.min(target.qty, q + 1))}>
                <Plus size={16} />
              </Button>
              <span className="text-xs">of {target.qty}</span>
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
