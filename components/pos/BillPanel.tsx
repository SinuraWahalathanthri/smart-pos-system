"use client";

import { useEffect, useMemo, useRef } from "react";
import { Pause, PackageOpen, Trash2 } from "lucide-react";
import { computeBill } from "@/lib/bill";
import { formatMoney } from "@/lib/money";
import { usePos } from "@/lib/store";
import { Button } from "../ui/Dialog";

export function BillPanel({
  embedded = false,
  onVoid,
}: {
  /** Inside a sheet: no border or rounding, and the list scrolls within the sheet. */
  embedded?: boolean;
  /** Touch removal. Routed to the same supervisor-approved path as F8, never a direct delete. */
  onVoid?: (lineId: string) => void;
} = {}) {
  const lines = usePos((s) => s.lines);
  const deposits = usePos((s) => s.deposits);
  const removeDeposit = usePos((s) => s.removeDeposit);
  const discount = usePos((s) => s.discount);
  const selectedId = usePos((s) => s.selectedId);
  const lastAddedId = usePos((s) => s.lastAddedId);
  const select = usePos((s) => s.select);
  const openDialog = usePos((s) => s.openDialog);
  const customerName = usePos((s) => s.customerName);
  const customerId = usePos((s) => s.customerId);
  const customerPoints = usePos((s) => s.customerPoints);
  const customerCredit = usePos((s) => s.customerCredit);
  const customerLimit = usePos((s) => s.customerLimit);
  const customerBottles = usePos((s) => s.customerBottles);

  const bill = useMemo(
    () => computeBill({ lines, deposits, discount }),
    [lines, deposits, discount],
  );
  const itemCount = lines.filter((l) => !l.voided).reduce((n, l) => n + l.qty, 0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [selectedId, lines.length]);

  // Position numbers for item rows only (voided and deposit rows are not numbered).
  const numbers = useMemo(() => {
    let n = 0;
    return bill.rows.map((r) => (r.kind === "item" ? ++n : 0));
  }, [bill.rows]);

  return (
    <section
      aria-label="Bill"
      className={
        embedded
          ? "flex min-h-0 flex-1 flex-col"
          : "flex min-h-0 flex-col rounded-xl border border-border bg-surface"
      }
    >
      <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
        <div>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted">
            {embedded ? "Items" : "Current bill"}
          </h2>
          <p className="text-sm text-muted">
            {itemCount} item{itemCount === 1 ? "" : "s"} &middot; {customerName ?? "Walk-in"}
          </p>
        </div>
        <Button variant="ghost" className="min-h-9 shrink-0 whitespace-nowrap px-2 text-xs" onClick={() => openDialog({ type: "held" })}>
          <Pause size={14} /> Held bills
        </Button>
      </div>

      {customerId && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-primary-soft px-4 py-2 text-xs text-primary">
          <span className="font-semibold">{customerName}</span>
          <span>{customerPoints} point{customerPoints === 1 ? "" : "s"}</span>
          <span>
            Tab {formatMoney(customerCredit)}
            {customerLimit > 0 && ` of ${formatMoney(customerLimit)}`}
          </span>
          {customerBottles > 0 && (
            <span className="font-semibold text-warning">
              {customerBottles} bottle{customerBottles === 1 ? "" : "s"} out
            </span>
          )}
        </div>
      )}
      <div ref={listRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto" aria-live="polite">
        {bill.rows.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted">
            <PackageOpen size={36} strokeWidth={1.4} />
            <p className="font-medium text-text">Scan an item or pick one from the grid</p>
            <p className="text-sm">Spices: choose a product, then a pack size.</p>
          </div>
        ) : (
          <ul>
            {bill.rows.map((r, i) => {
              const selected = r.line && r.line.id === selectedId && r.kind === "item";
              return (
                <li
                  key={r.key}
                  data-selected={selected ? "true" : "false"}
                  onClick={() => r.kind === "item" && select(r.key)}
                  className={`grid cursor-default items-center gap-x-2 border-b border-border/60 px-3 py-2 ${
                    onVoid || r.kind === "deposit" ? "grid-cols-[1.6rem_1fr_auto_2rem]" : "grid-cols-[1.6rem_1fr_auto]"
                  } ${
                    selected ? "bg-primary-soft" : ""
                  } ${r.line && r.line.id === lastAddedId ? "flash-in" : ""}`}
                >
                  <span className="text-center text-xs text-muted">
                    {selected ? "▶" : r.kind === "item" ? numbers[i] : r.kind === "deposit" ? "" : "×"}
                  </span>
                  <div className={`min-w-0 ${r.kind === "voided" ? "line-through opacity-60" : ""}`}>
                    <p className={`truncate text-[17px] font-medium ${r.kind === "deposit" ? "text-warning" : ""}`}>
                      {r.name}
                      {r.label && <span className="ml-1.5 rounded bg-surface-2 px-1.5 py-0.5 text-sm font-semibold">{r.label}</span>}
                    </p>
                    <p className="num text-xs text-muted">
                      {r.qty} × {formatMoney(r.unitPrice, false)}
                      {r.kind === "voided" && r.note && <span className="ml-2 font-semibold text-danger no-underline">Voided: {r.note}</span>}
                      {r.kind === "deposit" && <span className="ml-2">Customer keeps the bottle</span>}
                    </p>
                  </div>
                  <span className={`num text-[17px] font-semibold ${r.kind === "voided" ? "text-muted line-through" : ""}`}>
                    {formatMoney(r.total, false)}
                  </span>
                  {/* Touch replacement for Del/F8. Only on live item rows, and only where the screen
                      passed a handler, so a cashier without approval rights cannot reach it. */}
                  {onVoid && r.kind === "item" && r.line && !r.line.voided && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onVoid(r.line!.id);
                      }}
                      aria-label={`Remove ${r.name} from the bill`}
                      className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted active:bg-danger-soft active:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                  {/* Nothing has been paid yet, so a deposit comes off without a supervisor - and
                      leaving it off leaves the bottle owed, which is the safe direction. */}
                  {r.kind === "deposit" && r.depositProductId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeDeposit(r.depositProductId!);
                      }}
                      aria-label={`Take one ${r.name} off the bill`}
                      className="-mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted active:bg-danger-soft active:text-danger"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="border-t border-border px-4 pb-4 pt-3">
        <dl className="num space-y-0.5 text-sm text-muted">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{formatMoney(bill.subtotal)}</dd>
          </div>
          {bill.discount > 0 && (
            <div className="flex justify-between text-success">
              <dt>Discount</dt>
              <dd>-{formatMoney(bill.discount)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt>VAT included</dt>
            <dd>{formatMoney(bill.taxIncluded)}</dd>
          </div>
        </dl>
        <div className="mt-1 flex items-baseline justify-between">
          <span className="text-sm font-bold uppercase tracking-wider text-muted">Total</span>
          <span className="num text-[44px] font-bold leading-none" aria-label={`Total ${formatMoney(bill.total)}`}>
            {formatMoney(bill.total)}
          </span>
        </div>
        <div className="mt-3 flex gap-2">
          <Button variant="primary" className="h-14 flex-1 text-lg" keycap="F12" disabled={bill.total <= 0 && lines.length === 0} onClick={() => openDialog({ type: "pay" })}>
            Pay
          </Button>
        </div>
      </div>
    </section>
  );
}
