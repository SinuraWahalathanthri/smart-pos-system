"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, Download, Plus } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import {
  describeDue,
  monthPeriod,
  outstanding,
  type PaymentMethod,
  type Period,
  type Purchase,
  type PurchaseStatus,
} from "@/lib/finance";
import { centsToDecimal, downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { Button, Dialog } from "@/components/ui/Dialog";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import { Empty, ErrorNote, Loading, Money, PeriodLabel, Section, Table } from "./FinanceUI";
import { MonthPicker } from "./FinanceScreen";
import { VoidDialog } from "./ExpensesScreen";

type Supplier = { id: string; name: string };

/**
 * Supplier bills: what stock cost, and what is still owed for it.
 *
 * The distinction this screen exists to make is that buying stock is not spending money on overheads.
 * A delivery creates a payable; the cost only reaches profit when the goods are sold. So the totals
 * here are about cash owed to suppliers, not about how the month traded.
 */
export function PurchasesScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? <Purchases canWrite={can.viewAnalytics} /> : <NotAllowed what="purchases" role={ctx?.role} />}
    </DashboardShell>
  );
}

function Purchases({ canWrite }: { canWrite: boolean }) {
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [rows, setRows] = useState<Purchase[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Purchase | "new" | null>(null);
  const [paying, setPaying] = useState<Purchase | null>(null);
  const [voiding, setVoiding] = useState<Purchase | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const sb = getSupabase();
    const [list, sup] = await Promise.all([
      sb.rpc("purchases_export", { p_from: p.from, p_to: p.to }),
      sb.from("suppliers").select("id, name").order("name"),
    ]);
    setLoading(false);
    if (list.error) return setError(list.error.message);
    setError(null);
    setSuppliers((sup.data as Supplier[] | null) ?? []);
    setRows((list.data as Purchase[] | null) ?? []);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const totals = useMemo(
    () => ({
      bought: rows.reduce((n, r) => n + Number(r.total_cents), 0),
      paid: rows.reduce((n, r) => n + Number(r.paid_cents), 0),
      owed: rows.reduce((n, r) => n + outstanding(Number(r.total_cents), Number(r.paid_cents)), 0),
    }),
    [rows],
  );

  function exportRows() {
    const csv = toCsv(rows, [
      { header: "Received on", value: (r) => r.received_on },
      { header: "Supplier", value: (r) => r.supplier },
      { header: "Invoice", value: (r) => r.supplier_invoice_no },
      { header: "Status", value: (r) => r.status },
      { header: "Subtotal (LKR)", value: (r) => centsToDecimal(r.subtotal_cents) },
      { header: "Input VAT (LKR)", value: (r) => centsToDecimal(r.input_vat_cents) },
      { header: "Other costs (LKR)", value: (r) => centsToDecimal(r.additional_cost_cents) },
      { header: "Total (LKR)", value: (r) => centsToDecimal(r.total_cents) },
      { header: "Paid (LKR)", value: (r) => centsToDecimal(r.paid_cents) },
      { header: "Outstanding (LKR)", value: (r) => centsToDecimal(outstanding(r.total_cents, r.paid_cents)) },
      { header: "Due", value: (r) => r.due_on },
    ]);
    downloadCsv(exportFilename("purchases", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Purchases</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker period={period} onChange={setPeriod} />
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportRows}
            disabled={rows.length === 0}
          >
            <Download size={15} /> Export
          </button>
          {canWrite && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> Record a bill
            </Button>
          )}
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Stock bought</p>
          <p className="mt-1 text-xl font-semibold">
            <Money cents={totals.bought} />
          </p>
          <p className="mt-1 text-xs text-muted">this is not an expense; it becomes one as goods sell</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Already paid</p>
          <p className="mt-1 text-xl font-semibold">
            <Money cents={totals.paid} />
          </p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Still owed to suppliers</p>
          <p className={`mt-1 text-xl font-semibold ${totals.owed > 0 ? "text-warning" : ""}`}>
            <Money cents={totals.owed} />
          </p>
        </div>
      </div>

      <Section title="Supplier bills">
        {loading ? (
          <Loading what="purchases" />
        ) : rows.length === 0 ? (
          <Empty>
            No supplier bills for {period.label}. Record one here to track what the shop owes; use Stock on the
            Products screen to move goods onto the shelf.
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2 pr-3 font-medium">Received</th>
                <th className="py-2 pr-3 font-medium">Supplier</th>
                <th className="py-2 pr-3 font-medium">Invoice</th>
                <th className="py-2 pr-3 text-right font-medium">Total</th>
                <th className="py-2 pr-3 text-right font-medium">Outstanding</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            }
          >
            {rows.map((r, i) => {
              const owed = outstanding(Number(r.total_cents), Number(r.paid_cents));
              return (
                <tr key={r.id || `${r.supplier_invoice_no}-${i}`}>
                  <td className="py-2 pr-3 whitespace-nowrap">{r.received_on}</td>
                  <td className="py-2 pr-3">{r.supplier || "—"}</td>
                  <td className="py-2 pr-3 text-muted">{r.supplier_invoice_no ?? "—"}</td>
                  <td className="py-2 pr-3 text-right">
                    <Money cents={r.total_cents} />
                  </td>
                  <td className={`py-2 pr-3 text-right ${owed > 0 ? "text-warning" : "text-muted"}`}>
                    {owed > 0 ? <Money cents={owed} /> : "—"}
                    {r.due_on && owed > 0 && <div className="text-[11px]">{describeDue(r.due_on)}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <StatusChip status={r.status} />
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {canWrite && r.id && (
                      <>
                        {owed > 0 && (
                          <button
                            className="rounded p-1.5 text-muted hover:bg-surface-2"
                            title="Record a payment"
                            onClick={() => setPaying({ ...r, id: r.id })}
                          >
                            <Check size={15} />
                          </button>
                        )}
                        <button
                          className="rounded p-1.5 text-muted hover:bg-surface-2"
                          title="Edit"
                          onClick={() => setEditing({ ...r, id: r.id })}
                        >
                          Edit
                        </button>
                        <button
                          className="rounded p-1.5 text-danger hover:bg-surface-2"
                          title="Void"
                          onClick={() => setVoiding({ ...r, id: r.id })}
                        >
                          <Ban size={15} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      {editing && (
        <PurchaseDialog
          purchase={editing === "new" ? null : editing}
          suppliers={suppliers}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load(period);
          }}
        />
      )}

      {paying && (
        <PurchasePaymentDialog
          purchase={paying}
          onClose={() => setPaying(null)}
          onSaved={async () => {
            setPaying(null);
            await load(period);
          }}
        />
      )}

      {voiding && (
        <VoidDialog
          title={`Void bill ${voiding.supplier_invoice_no ?? ""}?`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            const { error: err } = await getSupabase().rpc("void_purchase", {
              p_purchase: voiding.id,
              p_reason: reason,
            });
            if (err) return err.message;
            setVoiding(null);
            await load(period);
            return null;
          }}
        />
      )}
    </div>
  );
}

function StatusChip({ status }: { status: PurchaseStatus }) {
  const style =
    status === "paid"
      ? "bg-success/15 text-success"
      : status === "void"
        ? "bg-surface-2 text-muted"
        : "bg-warning/15 text-warning";
  return <span className={`rounded px-1.5 py-0.5 text-xs ${style}`}>{status === "partial" ? "Part paid" : status}</span>;
}

function PurchaseDialog({
  purchase,
  suppliers,
  onClose,
  onSaved,
}: {
  purchase: Purchase | null;
  suppliers: Supplier[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [supplierId, setSupplierId] = useState(purchase?.supplier_id ?? suppliers[0]?.id ?? "");
  const [invoiceNo, setInvoiceNo] = useState(purchase?.supplier_invoice_no ?? "");
  const [receivedOn, setReceivedOn] = useState(purchase?.received_on ?? new Date().toISOString().slice(0, 10));
  const [subtotal, setSubtotal] = useState(purchase ? String(purchase.subtotal_cents / 100) : "");
  const [vat, setVat] = useState(purchase?.input_vat_cents ? String(purchase.input_vat_cents / 100) : "");
  const [extra, setExtra] = useState(purchase?.additional_cost_cents ? String(purchase.additional_cost_cents / 100) : "");
  const [extraNote, setExtraNote] = useState("");
  const [dueOn, setDueOn] = useState(purchase?.due_on ?? "");
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [paidNow, setPaidNow] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = !!purchase && Number(purchase.paid_cents) > 0;

  async function save() {
    const sub = parseMoneyInput(subtotal);
    if (sub === null || sub <= 0) return setError("Enter the invoice subtotal.");
    const vatCents = vat.trim() === "" ? 0 : (parseMoneyInput(vat) ?? -1);
    const extraCents = extra.trim() === "" ? 0 : (parseMoneyInput(extra) ?? -1);
    if (vatCents < 0 || extraCents < 0) return setError("Enter the tax and other costs, or leave them blank.");
    const paidCents = paidNow.trim() === "" ? 0 : (parseMoneyInput(paidNow) ?? -1);
    if (paidCents < 0) return setError("Enter what was paid, or leave it blank.");
    if (!supplierId) return setError("Choose a supplier. Add one under Products if the list is empty.");

    setBusy(true);
    const { error: err } = await getSupabase().rpc("save_purchase", {
      p_purchase: {
        ...(purchase ? { id: purchase.id } : {}),
        supplier_id: supplierId,
        supplier_invoice_no: invoiceNo.trim() || null,
        received_on: receivedOn,
        subtotal_cents: sub,
        input_vat_cents: vatCents,
        additional_cost_cents: extraCents,
        additional_cost_note: extraNote.trim() || null,
        total_cents: sub + vatCents + extraCents,
        paid_cents: paidCents,
        due_on: dueOn || null,
        payment_method: method,
      },
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  }

  return (
    <Dialog
      title={purchase ? "Edit supplier bill" : "Record a supplier bill"}
      onClose={onClose}
      onConfirm={() => void save()}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving..." : "Save bill"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        <p className="text-sm text-muted">
          This records what the supplier charged. Moving the goods onto the shelf is done from Products →
          Stock, so stock levels are not changed here.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Supplier</span>
            <select className="field" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
              {suppliers.length === 0 && <option value="">No suppliers yet</option>}
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Their invoice number</span>
            <input className="field" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Goods received on</span>
            <input className="field" type="date" value={receivedOn} onChange={(e) => setReceivedOn(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Payment due</span>
            <input className="field" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Subtotal (LKR)</span>
            <input
              className="field"
              data-autofocus
              value={subtotal}
              onChange={(e) => setSubtotal(e.target.value)}
              disabled={locked}
              inputMode="decimal"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Input VAT (LKR)</span>
            <input className="field" value={vat} onChange={(e) => setVat(e.target.value)} inputMode="decimal" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Freight, duty (LKR)</span>
            <input className="field" value={extra} onChange={(e) => setExtra(e.target.value)} inputMode="decimal" />
          </label>
        </div>

        {Number(extra) > 0 && (
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">What were the extra costs?</span>
            <input
              className="field"
              value={extraNote}
              onChange={(e) => setExtraNote(e.target.value)}
              placeholder="Lorry hire from Kandy"
            />
          </label>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Paid by</span>
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="cheque">Cheque</option>
            </select>
          </label>
          {!purchase && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Paid now (LKR)</span>
              <input className="field" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} inputMode="decimal" />
            </label>
          )}
        </div>

        <p className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
          Freight and duty are added to the cost of the goods rather than treated as an expense, which is why
          they are here and not in the expense book.
        </p>
      </div>
    </Dialog>
  );
}

function PurchasePaymentDialog({
  purchase,
  onClose,
  onSaved,
}: {
  purchase: Purchase;
  onClose: () => void;
  onSaved: () => void;
}) {
  const owed = outstanding(Number(purchase.total_cents), Number(purchase.paid_cents));
  const [amount, setAmount] = useState(String(owed / 100));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parseMoneyInput(amount);
    if (cents === null || cents <= 0) return setError("Enter what was paid.");
    setBusy(true);
    const { error: err } = await getSupabase().rpc("pay_purchase", {
      p_purchase: purchase.id,
      p_amount: cents,
      p_method: method,
      p_paid_on: on,
      p_reference: null,
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  }

  return (
    <Dialog
      title={`Pay ${purchase.supplier || "supplier"}`}
      onClose={onClose}
      onConfirm={() => void save()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving..." : "Record payment"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        <p className="text-sm text-muted">{formatMoney(owed)} is still owed on this bill.</p>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Amount paid (LKR)</span>
          <input className="field" data-autofocus value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Method</span>
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              <option value="cash">Cash</option>
              <option value="bank">Bank transfer</option>
              <option value="cheque">Cheque</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Paid on</span>
            <input className="field" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </label>
        </div>
      </div>
    </Dialog>
  );
}
