"use client";

import { useEffect, useMemo, useState } from "react";
import { Ban, ChevronDown, ChevronRight, Download, Receipt, Search, Undo2 } from "lucide-react";
import { invoiceFilename, invoiceHtml, type InvoiceDoc } from "@/lib/invoice";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { Button, Dialog } from "../ui/Dialog";
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
  status: "completed" | "cancelled" | "refunded";
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
 * History is never edited here. A receipt is reversed by a refund (the customer brought the goods
 * back: money goes out today, the original month stays as it was) or a cancellation (the bill was a
 * mistake: it leaves every report). Both keep the row and its receipt number. Points are shown per
 * receipt because that is the number a customer will ask about.
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
  const [version, setVersion] = useState(0);
  const [reversing, setReversing] = useState<{ sale: Receipt; mode: "refund" | "cancel" } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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
  }, [range, query, version]);

  const totals = useMemo(
    () => ({
      count: rows.length,
      // A refunded or cancelled receipt stays in the list but is no longer money the shop took.
      revenue: rows.reduce((a, r) => a + (r.status === "completed" ? Number(r.total_cents) : 0), 0),
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
      {notice && <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{notice}</p>}

      {reversing && (
        <ReverseSaleDialog
          sale={reversing.sale}
          mode={reversing.mode}
          lines={openId === reversing.sale.id ? lines : []}
          onClose={() => setReversing(null)}
          onDone={(message) => {
            setReversing(null);
            setNotice(message);
            setOpenId(null);
            setVersion((v) => v + 1);
          }}
        />
      )}

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
                <Row
                  key={r.id}
                  r={r}
                  open={openId === r.id}
                  lines={lines}
                  linesLoading={linesLoading}
                  onToggle={() => void toggle(r)}
                  onReverse={(mode) => {
                    setNotice(null);
                    setReversing({ sale: r, mode });
                  }}
                />
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
  onReverse,
}: {
  r: Receipt;
  open: boolean;
  lines: ReceiptLine[];
  linesLoading: boolean;
  onToggle: () => void;
  onReverse: (mode: "refund" | "cancel") => void;
}) {
  const voided = r.status !== "completed";
  return (
    <>
      <tr className={`cursor-pointer border-t border-border hover:bg-surface-2 ${voided ? "opacity-60" : ""}`} onClick={onToggle}>
        <td className="px-3 py-2 text-muted">{open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</td>
        <td className="px-3 py-2 font-mono">
          #{r.receipt_no}
          {voided && <span className="ml-1 text-xs text-danger">({r.status})</span>}
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
            <div className="mb-2 flex flex-wrap justify-end gap-2">
              {r.status === "completed" && !linesLoading && (
                <>
                  <button
                    onClick={() => onReverse("refund")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-surface"
                  >
                    <Undo2 size={13} /> Refund
                  </button>
                  <button
                    onClick={() => onReverse("cancel")}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-danger/40 px-2.5 py-1 text-xs text-danger hover:bg-surface"
                  >
                    <Ban size={13} /> Cancel sale
                  </button>
                </>
              )}
              <InvoiceButton saleId={r.id} receiptNo={r.receipt_no} />
            </div>
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

/**
 * Download the invoice the till froze at the moment of sale.
 *
 * Fetched on click rather than with the list, because the document is a couple of KB each and the
 * owner is usually only after one receipt. Served as a .html file so it opens in any browser and
 * prints to PDF with Ctrl+P - no server-side renderer, no extra dependency, and it keeps working
 * when the app is installed offline.
 */
function InvoiceButton({ saleId, receiptNo }: { saleId: string; receiptNo: number }) {
  const [busy, setBusy] = useState(false);
  const [missing, setMissing] = useState(false);
  async function download() {
    setBusy(true);
    const { data, error } = await getSupabase().rpc("sale_invoice", { p_sale: saleId });
    setBusy(false);
    const inv = data as InvoiceDoc | null;
    if (error || !inv) {
      setMissing(true);
      return;
    }
    const blob = new Blob([invoiceHtml(inv)], { type: "text/html;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = invoiceFilename(inv);
    a.click();
    URL.revokeObjectURL(url);
  }
  if (missing) {
    return (
      <span className="text-xs text-warning">
        Invoice for #{receiptNo} is not ready yet - it is written once the till syncs this sale.
      </span>
    );
  }
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void download();
      }}
      disabled={busy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1 text-xs hover:bg-surface"
    >
      <Download size={13} /> {busy ? "Preparing..." : "Download invoice"}
    </button>
  );
}

type RefundMethod = "cash" | "card" | "qr";

/**
 * Refund or cancel one receipt, through refund_sale() / void_sale().
 *
 * The two are kept apart because they mean different things to the books. A refund is dated today
 * and leaves the sale in its own month; a cancellation removes the sale from every report, for a
 * bill that should never have been rung up. Both return the goods to stock (a refund may instead
 * write them off as damaged) and both settle the bottles the bill moved.
 *
 * A bill that went on a customer's tab is never refunded in cash: refund_sale() does not touch the
 * credit ledger, so the customer would get money back for a debt they still owe. Cancelling removes
 * the tab entry instead, so that is the only path offered for it.
 */
function ReverseSaleDialog({
  sale,
  mode,
  lines,
  onClose,
  onDone,
}: {
  sale: Receipt;
  mode: "refund" | "cancel";
  lines: ReceiptLine[];
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [method, setMethod] = useState<RefundMethod>("cash");
  const [restock, setRestock] = useState(true);
  const [onCredit, setOnCredit] = useState<boolean | null>(mode === "cancel" ? false : null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "refund") return;
    let stale = false;
    void (async () => {
      const { data, error: err } = await getSupabase().from("payments").select("method").eq("sale_id", sale.id);
      if (stale) return;
      if (err) return setError(err.message);
      const methods = ((data as { method: string }[] | null) ?? []).map((p) => p.method);
      setOnCredit(methods.includes("credit"));
      const paid = methods.find((m): m is RefundMethod => m === "cash" || m === "card" || m === "qr");
      if (paid) setMethod(paid);
    })();
    return () => {
      stale = true;
    };
  }, [mode, sale.id]);

  // What the customer gets back: the item lines, never a bottle deposit (refund_sale() leaves those
  // alone, and the bottle book settles them separately).
  const refundCents = lines
    .filter((l) => l.status === "active" && l.kind === "item")
    .reduce((n, l) => n + Number(l.line_total_cents), 0);

  async function go() {
    if (mode === "refund" && onCredit !== false) return;
    if (!reason.trim()) {
      return setError(mode === "refund" ? "Say why the goods came back." : "Say why this sale is being cancelled.");
    }
    setBusy(true);
    setError(null);
    const sb = getSupabase();
    const { error: err } =
      mode === "refund"
        ? await sb.rpc("refund_sale", { p_sale: sale.id, p_reason: reason.trim(), p_method: method, p_restock: restock })
        : await sb.rpc("void_sale", { p_sale: sale.id, p_reason: reason.trim() });
    setBusy(false);
    if (err) return setError(err.message);
    onDone(
      mode === "refund"
        ? `Receipt #${sale.receipt_no} refunded${refundCents > 0 ? ` - give back ${formatMoney(refundCents)}` : ""}.`
        : `Receipt #${sale.receipt_no} cancelled. It no longer counts in any report.`,
    );
  }

  const blocked = mode === "refund" && onCredit !== false;
  const label = "mb-1 block text-xs font-medium uppercase tracking-wide text-muted";

  return (
    <Dialog
      title={mode === "refund" ? `Refund receipt #${sale.receipt_no}` : `Cancel receipt #${sale.receipt_no}?`}
      tone={mode === "cancel" ? "danger" : "default"}
      onClose={onClose}
      onConfirm={() => void go()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant={mode === "cancel" ? "danger" : "primary"} onClick={() => void go()} disabled={busy || blocked}>
            {busy ? "Saving..." : mode === "refund" ? "Refund" : "Cancel sale"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        {mode === "cancel" ? (
          <p className="text-sm text-muted">
            For a bill rung up by mistake. It is removed from takings and every report, its goods go back into stock,
            and any tab entry or bottle it recorded is reversed. The receipt number is kept and shown as cancelled. If
            the customer brought goods back, use <b>Refund</b> instead.
          </p>
        ) : onCredit === null ? (
          <p className="text-sm text-muted">Checking how this bill was paid...</p>
        ) : onCredit ? (
          <p className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            This bill went on the customer&apos;s tab, so there is no money to give back. Use <b>Cancel sale</b> instead: it
            takes the amount off their tab and returns the goods to stock.
          </p>
        ) : (
          <>
            <p className="text-sm text-muted">
              The whole bill is refunded, dated today. The original sale stays in its own month, so a closed month does
              not change.
            </p>
            <div className="rounded-lg bg-surface-2 px-3 py-2">
              <p className="text-xs uppercase tracking-wide text-muted">Give back</p>
              <p className="num text-lg font-semibold">{formatMoney(refundCents)}</p>
              {lines.some((l) => l.status === "active" && l.kind === "bottle_fee") && (
                <p className="text-xs text-muted">Bottle deposits on this bill are not refunded here.</p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className={label}>Paid back by</span>
                <select className="field" value={method} onChange={(e) => setMethod(e.target.value as RefundMethod)}>
                  <option value="cash">Cash</option>
                  <option value="card">Card</option>
                  <option value="qr">QR / transfer</option>
                </select>
              </label>
              <label className="block">
                <span className={label}>The goods</span>
                <select
                  className="field"
                  value={restock ? "shelf" : "damaged"}
                  onChange={(e) => setRestock(e.target.value === "shelf")}
                >
                  <option value="shelf">Go back on the shelf</option>
                  <option value="damaged">Are damaged - write off</option>
                </select>
              </label>
            </div>
          </>
        )}

        {!blocked && (
          <label className="block">
            <span className={label}>Why?</span>
            <input
              className="field"
              // Mounts after the payment check, so the dialog's own first-focus has already run.
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={mode === "refund" ? "Packet was split" : "Rung up twice"}
            />
          </label>
        )}
      </div>
    </Dialog>
  );
}
