"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Ban, Check, Download, Plus, Search } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import {
  describeDue,
  describeExpenseStatus,
  monthPeriod,
  previousPeriod,
  type Expense,
  type ExpenseCategoryChange,
  type ExpenseCategoryRow,
  type ExpenseKind,
  type PaymentMethod,
  type Period,
} from "@/lib/finance";
import { centsToDecimal, downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { Button, Dialog } from "@/components/ui/Dialog";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import { Empty, ErrorNote, Loading, Money, PeriodLabel, Section, ShareBar, Table } from "./FinanceUI";
import { MonthPicker } from "./FinanceScreen";

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "bank", label: "Bank transfer" },
  { value: "cheque", label: "Cheque" },
  { value: "card", label: "Card" },
];

/**
 * The expense book.
 *
 * Two things this screen deliberately does not do. It does not let an expense be deleted — a wrong
 * entry is voided with a reason and stays visible, because an expense that can disappear is not a
 * record. And it does not present "paid" as a checkbox: money paid is a payment, and the status is
 * derived from the payments, so an entry cannot claim to be settled when the bank shows otherwise.
 */
export function ExpensesScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? <ExpenseBook canWrite={can.viewAnalytics} /> : <NotAllowed what="expenses" role={ctx?.role} />}
    </DashboardShell>
  );
}

type Filter = { query: string; category: string; status: string };

function ExpenseBook({ canWrite }: { canWrite: boolean }) {
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [rows, setRows] = useState<Expense[]>([]);
  const [breakdown, setBreakdown] = useState<ExpenseCategoryRow[]>([]);
  const [changes, setChanges] = useState<ExpenseCategoryChange[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [filter, setFilter] = useState<Filter>({ query: "", category: "", status: "" });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Expense | "new" | null>(null);
  const [paying, setPaying] = useState<Expense | null>(null);
  const [voiding, setVoiding] = useState<Expense | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const sb = getSupabase();
    const [list, byCategory, change, cats] = await Promise.all([
      sb.rpc("expense_list", { p_from: p.from, p_to: p.to, p_limit: 500 }),
      sb.rpc("expense_breakdown", { p_from: p.from, p_to: p.to }),
      sb.rpc("expense_category_change", { p_from: p.from, p_to: p.to }),
      sb.from("expense_categories").select("name").order("sort_order"),
    ]);
    setLoading(false);
    if (list.error) return setError(list.error.message);
    setError(null);
    setRows((list.data as Expense[] | null) ?? []);
    setBreakdown((byCategory.data as ExpenseCategoryRow[] | null) ?? []);
    setChanges((change.data as ExpenseCategoryChange[] | null) ?? []);
    setCategories(((cats.data as { name: string }[] | null) ?? []).map((c) => c.name));
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const visible = useMemo(() => {
    const needle = filter.query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter.category && r.category !== filter.category) return false;
      if (filter.status && r.status !== filter.status) return false;
      if (!needle) return true;
      return [r.description, r.payee ?? "", r.reference ?? "", r.category, String(r.voucher_no)]
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [rows, filter]);

  const totals = useMemo(() => {
    const live = visible.filter((r) => !r.voided_at);
    return {
      count: live.length,
      amount: live.reduce((n, r) => n + Number(r.amount_cents), 0),
      outstanding: live.reduce((n, r) => n + (Number(r.amount_cents) - Number(r.paid_cents)), 0),
      operating: live.filter((r) => r.kind === "operating").reduce((n, r) => n + Number(r.amount_cents), 0),
    };
  }, [visible]);

  const largest = breakdown.reduce((n, r) => Math.max(n, Number(r.total_cents)), 0);
  const significant = changes.filter((c) => Math.abs(Number(c.change_cents)) > 0 && c.change_pct !== null).slice(0, 4);

  function exportRows() {
    const csv = toCsv(visible, [
      { header: "Voucher", value: (r) => r.voucher_no },
      { header: "Date", value: (r) => r.expense_on },
      { header: "Category", value: (r) => r.category },
      { header: "Description", value: (r) => r.description },
      { header: "Payee", value: (r) => r.payee },
      { header: "Reference", value: (r) => r.reference },
      { header: "Type", value: (r) => r.kind },
      { header: "Amount (LKR)", value: (r) => centsToDecimal(r.amount_cents) },
      { header: "Tax (LKR)", value: (r) => centsToDecimal(r.tax_cents) },
      { header: "Paid (LKR)", value: (r) => centsToDecimal(r.paid_cents) },
      { header: "Outstanding (LKR)", value: (r) => centsToDecimal(r.amount_cents - r.paid_cents) },
      { header: "Status", value: (r) => describeExpenseStatus(r.status) },
      { header: "Method", value: (r) => r.payment_method },
    ]);
    downloadCsv(exportFilename("expenses", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Expenses</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker period={period} onChange={setPeriod} />
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportRows}
            disabled={visible.length === 0}
          >
            <Download size={15} /> Export
          </button>
          {canWrite && (
            <Button variant="primary" onClick={() => setEditing("new")}>
              <Plus size={16} /> Add expense
            </Button>
          )}
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Operating expenses</p>
          <p className="mt-1 text-2xl font-semibold">
            <Money cents={totals.operating} />
          </p>
          <p className="mt-1 text-xs text-muted">running costs only, which is what reduces profit</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Entries</p>
          <p className="mt-1 text-2xl font-semibold">{totals.count}</p>
          <p className="mt-1 text-xs text-muted">{formatMoney(totals.amount)} in total, including capital</p>
        </div>
        <div className="rounded-xl border border-border bg-surface p-4">
          <p className="text-xs uppercase tracking-wide text-muted">Still unpaid</p>
          <p className={`mt-1 text-2xl font-semibold ${totals.outstanding > 0 ? "text-warning" : ""}`}>
            <Money cents={totals.outstanding} />
          </p>
          <p className="mt-1 text-xs text-muted">money the shop still owes</p>
        </div>
      </div>

      {breakdown.length > 0 && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Section title="By category">
            <div className="space-y-3">
              {breakdown.map((r) => (
                <div key={`${r.category}-${r.kind}`}>
                  <div className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="flex items-center gap-2">
                      {r.category}
                      {r.kind === "capital" && (
                        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                          capital
                        </span>
                      )}
                    </span>
                    <span className="tabular-nums text-muted">
                      {formatMoney(r.total_cents)} · {r.share_pct}%
                    </span>
                  </div>
                  <div className="mt-1">
                    <ShareBar value={Number(r.total_cents)} max={largest} tone={r.kind === "capital" ? "danger" : "primary"} />
                  </div>
                </div>
              ))}
            </div>
          </Section>

          <Section title={`Compared with ${previousPeriod(period).from} to ${previousPeriod(period).to}`}>
            {significant.length === 0 ? (
              <Empty>Nothing changed enough to be worth flagging.</Empty>
            ) : (
              <ul className="space-y-2 text-sm">
                {significant.map((c) => (
                  <li key={c.category} className="flex items-baseline justify-between gap-2">
                    <span>{c.category}</span>
                    <span
                      className={`tabular-nums ${Number(c.change_cents) > 0 ? "text-danger" : "text-success"}`}
                    >
                      {Number(c.change_cents) > 0 ? "+" : "−"}
                      {formatMoney(Math.abs(Number(c.change_cents)))} ({c.change_pct}%)
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <p className="mt-3 text-xs text-muted">
              Measured against the period of the same length immediately before this one, so a change is not
              just the calendar moving.
            </p>
          </Section>
        </div>
      )}

      <Section
        title="Expense book"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="relative">
              <Search className="pointer-events-none absolute left-2 top-2.5 text-muted" size={14} />
              <input
                className="field w-56 pl-7"
                placeholder="Search description, payee..."
                value={filter.query}
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                aria-label="Search expenses"
              />
            </label>
            <select
              className="field w-auto"
              value={filter.category}
              onChange={(e) => setFilter((f) => ({ ...f, category: e.target.value }))}
              aria-label="Filter by category"
            >
              <option value="">All categories</option>
              {[...new Set(rows.map((r) => r.category))].sort().map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <select
              className="field w-auto"
              value={filter.status}
              onChange={(e) => setFilter((f) => ({ ...f, status: e.target.value }))}
              aria-label="Filter by status"
            >
              <option value="">Any status</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Part paid</option>
              <option value="paid">Paid</option>
            </select>
          </div>
        }
      >
        {loading ? (
          <Loading what="expenses" />
        ) : visible.length === 0 ? (
          <Empty>
            {rows.length === 0
              ? `No expenses recorded for ${period.label}. Add rent, electricity, wages and anything else the shop pays for.`
              : "No expenses match this search."}
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2 pr-3 font-medium">#</th>
                <th className="py-2 pr-3 font-medium">Date</th>
                <th className="py-2 pr-3 font-medium">Description</th>
                <th className="py-2 pr-3 font-medium">Category</th>
                <th className="py-2 pr-3 text-right font-medium">Amount</th>
                <th className="py-2 pr-3 text-right font-medium">Outstanding</th>
                <th className="py-2 pr-3 font-medium">Status</th>
                <th className="py-2 text-right font-medium">Actions</th>
              </tr>
            }
          >
            {visible.map((r) => {
              const owed = Number(r.amount_cents) - Number(r.paid_cents);
              return (
                <tr key={r.id} className={r.voided_at ? "opacity-50" : ""}>
                  <td className="py-2 pr-3 text-muted">{r.voucher_no}</td>
                  <td className="py-2 pr-3 whitespace-nowrap">{r.expense_on}</td>
                  <td className="py-2 pr-3">
                    <span className={r.voided_at ? "line-through" : ""}>{r.description}</span>
                    {r.payee && <span className="ml-2 text-xs text-muted">{r.payee}</span>}
                    {r.has_receipt && (
                      <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] uppercase text-muted">
                        receipt
                      </span>
                    )}
                  </td>
                  <td className="py-2 pr-3">
                    {r.category}
                    {r.kind === "capital" && <span className="ml-1 text-[10px] uppercase text-muted">cap</span>}
                  </td>
                  <td className="py-2 pr-3 text-right">
                    <Money cents={r.amount_cents} />
                  </td>
                  <td className={`py-2 pr-3 text-right ${owed > 0 ? "text-warning" : "text-muted"}`}>
                    {owed > 0 ? <Money cents={owed} /> : "—"}
                    {r.due_on && owed > 0 && <div className="text-[11px]">{describeDue(r.due_on)}</div>}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        r.status === "paid"
                          ? "bg-success/15 text-success"
                          : r.status === "void"
                            ? "bg-surface-2 text-muted"
                            : "bg-warning/15 text-warning"
                      }`}
                    >
                      {describeExpenseStatus(r.status)}
                    </span>
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    {!r.voided_at && canWrite && (
                      <>
                        {owed > 0 && (
                          <button
                            className="rounded p-1.5 text-muted hover:bg-surface-2"
                            title="Record a payment"
                            onClick={() => setPaying(r)}
                          >
                            <Check size={15} />
                          </button>
                        )}
                        <button
                          className="rounded p-1.5 text-muted hover:bg-surface-2"
                          title="Edit"
                          onClick={() => setEditing(r)}
                        >
                          Edit
                        </button>
                        <button
                          className="rounded p-1.5 text-danger hover:bg-surface-2"
                          title="Void"
                          onClick={() => setVoiding(r)}
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
        <ExpenseDialog
          expense={editing === "new" ? null : editing}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load(period);
          }}
        />
      )}

      {paying && (
        <PaymentDialog
          expense={paying}
          onClose={() => setPaying(null)}
          onSaved={async () => {
            setPaying(null);
            await load(period);
          }}
        />
      )}

      {voiding && (
        <VoidDialog
          title={`Void expense ${voiding.voucher_no}?`}
          onClose={() => setVoiding(null)}
          onConfirm={async (reason) => {
            const { error: err } = await getSupabase().rpc("void_expense", {
              p_expense: voiding.id,
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

/**
 * Add or edit one expense.
 *
 * Editing is limited on purpose: once money has been paid against an expense, the amount is locked,
 * because changing it would contradict money already recorded. The server enforces this too, so the
 * disabled field here is only explaining the rule rather than being it.
 */
function ExpenseDialog({
  expense,
  categories,
  onClose,
  onSaved,
}: {
  expense: Expense | null;
  categories: string[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ExpenseKind>(expense?.kind ?? "operating");
  const [category, setCategory] = useState(expense?.category ?? "");
  const [description, setDescription] = useState(expense?.description ?? "");
  const [amount, setAmount] = useState(expense ? String(expense.amount_cents / 100) : "");
  const [tax, setTax] = useState(expense?.tax_cents ? String(expense.tax_cents / 100) : "");
  const [expenseOn, setExpenseOn] = useState(expense?.expense_on ?? new Date().toISOString().slice(0, 10));
  const [dueOn, setDueOn] = useState(expense?.due_on ?? "");
  const [payee, setPayee] = useState(expense?.payee ?? "");
  const [reference, setReference] = useState(expense?.reference ?? "");
  const [notes, setNotes] = useState("");
  const [method, setMethod] = useState<PaymentMethod>(expense?.payment_method ?? "cash");
  const [paidNow, setPaidNow] = useState("");
  const [recurring, setRecurring] = useState(expense?.is_recurring ?? false);
  const [rule, setRule] = useState(expense?.recurrence_rule ?? "monthly");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const locked = !!expense && Number(expense.paid_cents) > 0;

  async function save() {
    const amountCents = parseMoneyInput(amount);
    if (amountCents === null || amountCents <= 0) return setError("Enter the amount.");
    if (!category.trim()) return setError("Choose or type a category.");
    if (!description.trim()) return setError("Describe what this expense was for.");
    const taxCents = tax.trim() === "" ? 0 : (parseMoneyInput(tax) ?? -1);
    if (taxCents < 0) return setError("Enter the tax amount, or leave it blank.");
    const paidCents = paidNow.trim() === "" ? 0 : (parseMoneyInput(paidNow) ?? -1);
    if (paidCents < 0) return setError("Enter what was paid, or leave it blank.");

    setBusy(true);
    const { error: err } = await getSupabase().rpc("save_expense", {
      p_expense: {
        ...(expense ? { id: expense.id } : {}),
        kind,
        category: category.trim(),
        description: description.trim(),
        amount_cents: amountCents,
        tax_cents: taxCents,
        expense_on: expenseOn,
        due_on: dueOn || null,
        payee: payee.trim() || null,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
        payment_method: method,
        paid_cents: paidCents,
        is_recurring: recurring,
        recurrence_rule: recurring ? rule : null,
      },
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  }

  return (
    <Dialog
      title={expense ? `Edit expense ${expense.voucher_no}` : "Add an expense"}
      onClose={onClose}
      onConfirm={() => void save()}
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Saving..." : expense ? "Save changes" : "Add expense"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}

        <div className="flex gap-2">
          {(["operating", "capital"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className={`flex-1 rounded-lg border px-3 py-2 text-left text-sm ${
                kind === k ? "border-primary bg-primary-soft" : "border-border bg-surface-2"
              }`}
            >
              <span className="font-medium capitalize">{k === "capital" ? "Capital purchase" : "Running cost"}</span>
              <span className="block text-xs text-muted">
                {k === "capital"
                  ? "Equipment, a vehicle, a freezer — kept out of monthly profit"
                  : "Rent, wages, electricity — reduces this month's profit"}
              </span>
            </button>
          ))}
        </div>

        <Field label="What was it for?">
          <input
            className="field"
            data-autofocus
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="April shop rent"
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Category">
            <input
              className="field"
              list="expense-categories"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Rent"
            />
            <datalist id="expense-categories">
              {categories.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Amount (LKR)" hint={locked ? "Locked: money has already been paid against this expense." : undefined}>
            <input
              className="field"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={locked}
              inputMode="decimal"
              placeholder="40000.00"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date of the expense">
            <input className="field" type="date" value={expenseOn} onChange={(e) => setExpenseOn(e.target.value)} />
          </Field>
          <Field label="VAT included (LKR)" hint="Only if the bill shows tax separately.">
            <input className="field" value={tax} onChange={(e) => setTax(e.target.value)} inputMode="decimal" />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Paid to">
            <input className="field" value={payee} onChange={(e) => setPayee(e.target.value)} placeholder="Landlord" />
          </Field>
          <Field label="Reference">
            <input
              className="field"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Invoice or cheque number"
            />
          </Field>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Payment method">
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due on" hint="Leave blank if not on terms.">
            <input className="field" type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </Field>
          {!expense && (
            <Field label="Paid now (LKR)" hint="Leave blank if unpaid.">
              <input className="field" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} inputMode="decimal" />
            </Field>
          )}
        </div>

        <Field label="Notes">
          <textarea
            className="field"
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            data-no-enter
          />
        </Field>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} />
          This is a regular bill
        </label>
        {recurring && (
          <Field label="How often" hint="A new expense is added on each cycle. This one stays as it is.">
            <select className="field" value={rule} onChange={(e) => setRule(e.target.value)}>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
              <option value="quarterly">Every quarter</option>
              <option value="yearly">Every year</option>
            </select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

function PaymentDialog({
  expense,
  onClose,
  onSaved,
}: {
  expense: Expense;
  onClose: () => void;
  onSaved: () => void;
}) {
  const owed = Number(expense.amount_cents) - Number(expense.paid_cents);
  const [amount, setAmount] = useState(String(owed / 100));
  const [method, setMethod] = useState<PaymentMethod>("cash");
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    const cents = parseMoneyInput(amount);
    if (cents === null || cents <= 0) return setError("Enter what was paid.");
    setBusy(true);
    const { error: err } = await getSupabase().rpc("pay_expense", {
      p_expense: expense.id,
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
      title={`Pay ${expense.description}`}
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
        <p className="text-sm text-muted">
          {formatMoney(owed)} is still owed on voucher {expense.voucher_no}. Payments are recorded
          separately, so this expense keeps its full amount in the accounts.
        </p>
        <Field label="Amount paid (LKR)">
          <input className="field" data-autofocus value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Method">
            <select className="field" value={method} onChange={(e) => setMethod(e.target.value as PaymentMethod)}>
              {METHODS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Paid on">
            <input className="field" type="date" value={on} onChange={(e) => setOn(e.target.value)} />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

/** A reason is required, so a reversal can always be explained to whoever asks later. */
function VoidDialog({
  title,
  onClose,
  onConfirm,
}: {
  title: string;
  onClose: () => void;
  onConfirm: (reason: string) => Promise<string | null>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!reason.trim()) return setError("Say why this is being voided.");
    setBusy(true);
    const message = await onConfirm(reason.trim());
    setBusy(false);
    if (message) setError(message);
  }

  return (
    <Dialog
      title={title}
      tone="danger"
      onClose={onClose}
      onConfirm={() => void go()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={busy}>
            {busy ? "Voiding..." : "Void it"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        <p className="text-sm text-muted">
          Voiding keeps the entry and its history, but removes it from every report. Nothing is deleted.
        </p>
        <Field label="Why?">
          <input
            className="field"
            data-autofocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Entered against the wrong month"
          />
        </Field>
      </div>
    </Dialog>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export { VoidDialog };
