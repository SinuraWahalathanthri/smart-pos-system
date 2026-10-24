import type { Cents } from "./money";

/**
 * Finance vocabulary shared by the dashboard screens.
 *
 * Every figure here is produced by a SQL function (migrations 0021-0024); nothing in this file
 * recalculates money that Postgres has already decided. What it does hold is the shape of the
 * responses, the period arithmetic a screen needs to offer "this month" and "last month", and the
 * small amount of formatting that turns a number into a sentence a shopkeeper can read.
 */

export type ExpenseKind = "operating" | "capital";
export type ExpenseStatus = "unpaid" | "partial" | "paid" | "void";
export type PurchaseStatus = "unpaid" | "partial" | "paid" | "void";
export type CostMethod = "moving_average" | "latest";
export type PaymentMethod = "cash" | "card" | "credit" | "bank" | "cheque";

export interface FinanceSummary {
  from: string;
  to: string;
  currency: string;

  gross_sales_cents: Cents;
  discounts_cents: Cents;
  refunds_cents: Cents;
  net_sales_cents: Cents;
  cancelled_bills: number;
  refunded_bills: number;
  bill_count: number;

  collected_cents: Cents;
  collected_at_till_cents: Cents;
  credit_settled_cents: Cents;

  cogs_cents: Cents;
  unknown_cost_lines: number;

  gross_profit_cents: Cents;
  operating_expenses_cents: Cents;
  capital_expenses_cents: Cents;
  net_profit_cents: Cents;

  output_vat_cents: Cents;
  input_vat_expenses_cents: Cents;
  input_vat_purchases_cents: Cents;

  receivables_cents: Cents;
  payables_cents: Cents;
  unpaid_expenses_cents: Cents;
  inventory_value_cents: Cents;
  uncosted_products: number;

  purchases_cents: Cents;
  unpaid_purchases_cents: Cents;
  purchase_count: number;
  expense_count: number;
  line_revenue_cents: Cents;

  /** True when some cost is missing, so gross profit is a floor rather than a fact. */
  is_estimate: boolean;
  vat_registered: boolean;
  vat_rate_pct: number;
  cost_method: CostMethod;
}

export interface ProductProfit {
  product_id: string;
  name: string;
  sku: string | null;
  category: string | null;
  unit_price_cents: Cents | null;
  unit_cost_cents: Cents | null;
  current_cost_cents: Cents | null;
  gross_profit_per_unit_cents: Cents | null;
  margin_pct: number | null;
  markup_pct: number | null;
  qty_sold: number;
  revenue_cents: Cents;
  /** Null for a supervisor: cost never reaches a browser that may not see it. */
  cogs_cents: Cents | null;
  gross_profit_cents: Cents | null;
  units_refunded: number;
  refunded_cents: Cents;
  cost_known: boolean;
  stock_on_hand: number;
  is_below_cost: boolean;
}

export interface Expense {
  id: string;
  voucher_no: number;
  kind: ExpenseKind;
  category: string;
  description: string;
  amount_cents: Cents;
  tax_cents: Cents;
  expense_on: string;
  due_on: string | null;
  status: ExpenseStatus;
  paid_cents: Cents;
  payment_method: PaymentMethod | null;
  payee: string | null;
  reference: string | null;
  is_recurring: boolean;
  recurrence_rule: string | null;
  voided_at: string | null;
  has_receipt: boolean;
  created_at: string;
}

export interface ExpenseCategoryRow {
  category: string;
  kind: ExpenseKind;
  total_cents: Cents;
  paid_cents: Cents;
  unpaid_cents: Cents;
  entry_count: number;
  share_pct: number;
}

export interface ExpenseCategoryChange {
  category: string;
  current_cents: Cents;
  previous_cents: Cents;
  change_cents: Cents;
  change_pct: number | null;
}

export interface ExpenseTrendPoint {
  bucket: string;
  operating_cents: Cents;
  capital_cents: Cents;
  entry_count: number;
}

export interface Purchase {
  id: string;
  received_on: string;
  supplier_id: string;
  /** The supplier's name, as returned by purchases_export. */
  supplier: string;
  supplier_invoice_no: string | null;
  status: PurchaseStatus;
  subtotal_cents: Cents;
  input_vat_cents: Cents;
  additional_cost_cents: Cents;
  total_cents: Cents;
  paid_cents: Cents;
  outstanding_cents: Cents;
  due_on: string | null;
}

export interface TaxSummary {
  from: string;
  to: string;
  shop: {
    name: string;
    address: string | null;
    phone: string | null;
    vat_no: string | null;
    tin: string | null;
    is_vat_registered: boolean;
    vat_rate_pct: number;
    prices_include_tax: boolean;
  };
  output_vat_cents: Cents;
  vat_on_sales_cents: Cents;
  vat_refunded_cents: Cents;
  taxable_sales_cents: Cents;
  zero_rated_sales_cents: Cents;
  input_vat_purchases_cents: Cents;
  input_vat_expenses_cents: Cents;
  input_vat_total_cents: Cents;
  /** A difference, not a liability: what is owed depends on rules this app does not encode. */
  vat_difference_cents: Cents;
  sales_count: number;
  purchase_count: number;
  expense_count: number;
  warnings: string[];
  disclaimer: string;
}

export interface AuditEntry {
  id: string;
  created_at: string;
  action: string;
  /** Nullable in `audit_logs`: an entry may describe an action with no single record behind it. */
  entity: string | null;
  entity_id: string | null;
  actor: string | null;
  approver: string | null;
  reason: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface FinanceAlert {
  code: string;
  /** Always "review": the app has no way to know whether a pattern is a mistake. */
  severity: string;
  headline: string;
  detail: string;
  amount_cents: Cents | null;
  entity: string;
  entity_id: string | null;
  happened_on: string | null;
}

export interface FinanceSettings {
  is_vat_registered: boolean;
  vat_rate_pct: number;
  tin: string | null;
  vat_no: string | null;
  cost_method: CostMethod;
  fiscal_year_start_month: number;
}

// ---------------------------------------------------------------------------------------------
// periods
// ---------------------------------------------------------------------------------------------

export interface Period {
  /** yyyy-mm-dd, inclusive. */
  from: string;
  /** yyyy-mm-dd, inclusive. */
  to: string;
  label: string;
}

const iso = (d: Date) => {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export function monthPeriod(ref: Date = new Date(), offset = 0): Period {
  const start = new Date(ref.getFullYear(), ref.getMonth() + offset, 1);
  const end = new Date(ref.getFullYear(), ref.getMonth() + offset + 1, 0);
  return {
    from: iso(start),
    to: iso(end),
    label: start.toLocaleDateString("en-GB", { month: "long", year: "numeric" }),
  };
}

export function yearPeriod(ref: Date = new Date(), offset = 0): Period {
  const y = ref.getFullYear() + offset;
  return { from: `${y}-01-01`, to: `${y}-12-31`, label: String(y) };
}

export function quarterPeriod(ref: Date = new Date(), offset = 0): Period {
  const q = Math.floor(ref.getMonth() / 3) + offset;
  const start = new Date(ref.getFullYear(), q * 3, 1);
  const end = new Date(start.getFullYear(), start.getMonth() + 3, 0);
  return { from: iso(start), to: iso(end), label: `Q${Math.floor(start.getMonth() / 3) + 1} ${start.getFullYear()}` };
}

export function fiscalYearPeriod(fiscalStartMonth: number, ref: Date = new Date(), offset = 0): Period {
  const startMonth = Math.min(Math.max(fiscalStartMonth, 1), 12) - 1;
  const startYear = ref.getMonth() >= startMonth ? ref.getFullYear() : ref.getFullYear() - 1;
  const start = new Date(startYear + offset, startMonth, 1);
  const end = new Date(startYear + offset + 1, startMonth, 0);
  return {
    from: iso(start),
    to: iso(end),
    label: `FY ${start.getFullYear()}/${String((start.getFullYear() + 1) % 100).padStart(2, "0")}`,
  };
}

/** The period immediately before this one, of the same length. Used for every "vs last period". */
export function previousPeriod(p: Period): Period {
  const from = new Date(`${p.from}T00:00:00`);
  const to = new Date(`${p.to}T00:00:00`);
  const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
  const prevTo = new Date(from.getTime() - 86_400_000);
  const prevFrom = new Date(prevTo.getTime() - (days - 1) * 86_400_000);
  return { from: iso(prevFrom), to: iso(prevTo), label: "previous period" };
}

// ---------------------------------------------------------------------------------------------
// percentages and phrasing
// ---------------------------------------------------------------------------------------------

/**
 * A percentage change, or null when there is nothing meaningful to compare against.
 *
 * Returning null rather than 0 or Infinity is the point: a category that had no spend last month has
 * gone up by an undefined amount, and "0%" or "+Infinity%" would both read as a fact.
 */
export function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 1000) / 10;
}

/** Margin as a share of revenue. Null when nothing was sold, not 0. */
export function marginPercent(revenue: Cents, cogs: Cents): number | null {
  if (revenue === 0) return null;
  return Math.round(((revenue - cogs) / revenue) * 1000) / 10;
}

/** Markup as a share of cost — a different question from margin, so a different function. */
export function markupPercent(revenue: Cents, cogs: Cents): number | null {
  if (cogs === 0) return null;
  return Math.round(((revenue - cogs) / cogs) * 1000) / 10;
}

export function formatPercent(value: number | null, withSign = false): string {
  if (value === null || !Number.isFinite(value)) return "—";
  const sign = withSign && value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

/** "Paid", "Part paid", "Unpaid" — the words a shopkeeper uses, not the enum. */
export function describeExpenseStatus(status: ExpenseStatus): string {
  return { unpaid: "Unpaid", partial: "Part paid", paid: "Paid", void: "Voided" }[status];
}

/** How overdue a bill is, in words. Anything not yet due reads as "due in N days". */
export function describeDue(dueOn: string | null, today: Date = new Date()): string {
  if (!dueOn) return "No due date";
  const due = new Date(`${dueOn}T00:00:00`);
  const days = Math.round((due.getTime() - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) / 86_400_000);
  if (days === 0) return "Due today";
  if (days > 0) return `Due in ${days} day${days === 1 ? "" : "s"}`;
  const late = Math.abs(days);
  return `${late} day${late === 1 ? "" : "s"} overdue`;
}

/** Outstanding money on a bill, floored at zero so a rounding artefact never reads as a credit. */
export function outstanding(total: Cents, paid: Cents): Cents {
  return Math.max(total - paid, 0);
}

/**
 * The warnings a finance screen must show, in one place, so no screen can quietly omit them.
 * An estimate that is presented as a fact is worse than no figure at all.
 */
export function financeWarnings(s: FinanceSummary): string[] {
  const out: string[] = [];
  if (s.unknown_cost_lines > 0) {
    out.push(
      `${s.unknown_cost_lines} sold line${s.unknown_cost_lines === 1 ? "" : "s"} had no recorded cost, so gross profit is understated. Add costs in Products to make it exact.`,
    );
  }
  if (s.uncosted_products > 0) {
    out.push(
      `${s.uncosted_products} product${s.uncosted_products === 1 ? "" : "s"} with stock on hand ${s.uncosted_products === 1 ? "has" : "have"} no cost, so the inventory value excludes ${s.uncosted_products === 1 ? "it" : "them"}.`,
    );
  }
  if (s.cancelled_bills > 0) {
    out.push(
      `${s.cancelled_bills} cancelled bill${s.cancelled_bills === 1 ? "" : "s"} excluded from revenue. A cancellation corrects a keying error; a refund is recorded as its own event.`,
    );
  }
  return out;
}

/** True when a period has no trading at all, so a screen can say so instead of showing zeros. */
export function isEmptyPeriod(s: FinanceSummary): boolean {
  return s.bill_count === 0 && s.expense_count === 0 && s.purchase_count === 0 && s.refunds_cents === 0;
}
