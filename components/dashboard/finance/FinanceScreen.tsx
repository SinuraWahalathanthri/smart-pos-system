"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, TrendingDown, TrendingUp } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/money";
import {
  financeWarnings,
  formatPercent,
  isEmptyPeriod,
  monthPeriod,
  percentChange,
  previousPeriod,
  type FinanceSummary,
  type Period,
} from "@/lib/finance";
import { centsToDecimal, downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import {
  Empty,
  ErrorNote,
  EstimateNotice,
  Loading,
  Money,
  PeriodLabel,
  Section,
  Stat,
  Table,
} from "./FinanceUI";

/**
 * The shop's money on one screen: what was sold, what came in, what the goods cost, what was spent,
 * and what that leaves.
 *
 * The order of the statement is the point. A shopkeeper reading top to bottom sees revenue, then the
 * deductions that reach net sales, then the cost of the goods, then overheads, then profit — the same
 * way an accountant would read it. Nothing is combined that the reader cannot undo.
 */
export function FinanceScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? <FinanceBody /> : <NotAllowed what="the shop's finances" role={ctx?.role} />}
    </DashboardShell>
  );
}

function FinanceBody() {
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [summary, setSummary] = useState<FinanceSummary | null>(null);
  const [prior, setPrior] = useState<FinanceSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    setError(null);
    const prev = previousPeriod(p);
    const sb = getSupabase();
    const [current, before] = await Promise.all([
      sb.rpc("finance_summary", { p_from: p.from, p_to: p.to }),
      sb.rpc("finance_summary", { p_from: prev.from, p_to: prev.to }),
    ]);
    setLoading(false);
    if (current.error) return setError(current.error.message);
    setSummary(current.data as FinanceSummary);
    // A missing comparison period is not an error: it just means there is nothing to compare with.
    setPrior((before.error ? null : before.data) as FinanceSummary | null);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const warnings = useMemo(() => (summary ? financeWarnings(summary) : []), [summary]);

  function exportStatement() {
    if (!summary) return;
    const rows = [
      { label: "Gross sales", current: summary.gross_sales_cents, before: prior?.gross_sales_cents },
      { label: "Less discounts", current: -summary.discounts_cents, before: prior ? -prior.discounts_cents : undefined },
      { label: "Less refunds", current: -summary.refunds_cents, before: prior ? -prior.refunds_cents : undefined },
      { label: "Net sales", current: summary.net_sales_cents, before: prior?.net_sales_cents },
      { label: "Less cost of goods sold", current: -summary.cogs_cents, before: prior ? -prior.cogs_cents : undefined },
      { label: "Gross profit", current: summary.gross_profit_cents, before: prior?.gross_profit_cents },
      {
        label: "Less operating expenses",
        current: -summary.operating_expenses_cents,
        before: prior ? -prior.operating_expenses_cents : undefined,
      },
      { label: "Net profit", current: summary.net_profit_cents, before: prior?.net_profit_cents },
      { label: "Cash collected", current: summary.collected_cents, before: prior?.collected_cents },
      { label: "Receivables (customers owe)", current: summary.receivables_cents, before: prior?.receivables_cents },
      { label: "Payables (shop owes)", current: summary.payables_cents, before: prior?.payables_cents },
      { label: "Inventory at cost", current: summary.inventory_value_cents, before: prior?.inventory_value_cents },
    ];
    const csv = toCsv(rows, [
      { header: "Line", value: (r) => r.label },
      { header: "This period (LKR)", value: (r) => centsToDecimal(r.current) },
      { header: "Previous period (LKR)", value: (r) => centsToDecimal(r.before) },
    ]);
    downloadCsv(exportFilename("profit-and-loss", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Finance</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker period={period} onChange={setPeriod} />
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportStatement}
            disabled={!summary}
          >
            <Download size={15} /> Export
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}
      {loading && !summary && <Loading />}

      {summary && (
        <>
          <EstimateNotice warnings={warnings} />

          {isEmptyPeriod(summary) ? (
            <div className="rounded-xl border border-border bg-surface">
              <Empty>
                No sales, expenses or purchases in {period.label}.{" "}
                {summary.inventory_value_cents > 0 && "Stock on hand is still valued below."}
              </Empty>
            </div>
          ) : (
            <ProfitStatement summary={summary} prior={prior} />
          )}

          {!isEmptyPeriod(summary) && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat
                label="Cash collected"
                value={summary.collected_cents}
                hint={
                  summary.credit_settled_cents > 0
                    ? `includes ${formatMoney(summary.credit_settled_cents)} of credit settled`
                    : "money actually received"
                }
                tone="muted"
              />
              <Stat
                label="Customers owe"
                value={summary.receivables_cents}
                hint="open credit tabs, all time"
                tone="muted"
              />
              <Stat
                label="Shop owes"
                value={summary.payables_cents + summary.unpaid_expenses_cents}
                hint={`suppliers ${formatMoney(summary.payables_cents)}, expenses ${formatMoney(summary.unpaid_expenses_cents)}`}
                tone="muted"
              />
              <Stat
                label="Stock at cost"
                value={summary.inventory_value_cents}
                hint={summary.uncosted_products > 0 ? `${summary.uncosted_products} uncosted` : "all stock costed"}
                tone="muted"
              />
            </div>
          )}

          <Section title="Where the numbers came from">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Rule term="Revenue">
                What was sold, counted on the day of the sale. A bill did not have to be paid to count.
              </Rule>
              <Rule term="Refunds">
                Reversed on the day the money went back, so a closed month is never rewritten.
              </Rule>
              <Rule term="Cost of goods sold">
                The cost recorded when each item was sold, not today&apos;s purchase price.
              </Rule>
              <Rule term="Purchases">
                Stock bought is not an expense. It shows as money owed and becomes a cost when the goods
                are sold, so it is deliberately absent from the profit lines above.
              </Rule>
              <Rule term="Capital purchases">
                Equipment and vehicles are kept apart from running costs, so a large purchase does not
                make a month look like a loss.
              </Rule>
              <Rule term="VAT">
                Recorded per sale line and per bill. The <em>Tax records</em> screen prepares the figures
                for your accountant; it does not decide what is owed.
              </Rule>
            </dl>
          </Section>
        </>
      )}
    </div>
  );
}

function Rule({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="font-medium">{term}</dt>
      <dd className="text-muted">{children}</dd>
    </div>
  );
}

/**
 * The statement itself.
 *
 * `deduction` rows are shown in brackets and subtracted, so the arithmetic is visible rather than
 * asserted. The comparison column is only rendered when a prior period was actually returned.
 */
function ProfitStatement({ summary, prior }: { summary: FinanceSummary; prior: FinanceSummary | null }) {
  const lines: {
    label: string;
    value: number;
    prior?: number;
    kind?: "total" | "deduction" | "result";
    note?: string;
  }[] = [
    {
      label: "Gross sales",
      value: summary.gross_sales_cents,
      prior: prior?.gross_sales_cents,
      note: `${summary.bill_count} bills`,
    },
    {
      label: "Discounts given",
      value: -summary.discounts_cents,
      prior: prior ? -prior.discounts_cents : undefined,
      kind: "deduction",
    },
    {
      label: "Refunds",
      value: -summary.refunds_cents,
      prior: prior ? -prior.refunds_cents : undefined,
      kind: "deduction",
      note: summary.refunded_bills > 0 ? `${summary.refunded_bills} refunded bills` : undefined,
    },
    { label: "Net sales", value: summary.net_sales_cents, prior: prior?.net_sales_cents, kind: "total" },
    {
      label: "Cost of goods sold",
      value: -summary.cogs_cents,
      prior: prior ? -prior.cogs_cents : undefined,
      kind: "deduction",
      note: summary.unknown_cost_lines > 0 ? `${summary.unknown_cost_lines} lines uncosted` : undefined,
    },
    { label: "Gross profit", value: summary.gross_profit_cents, prior: prior?.gross_profit_cents, kind: "result" },
    {
      label: "Operating expenses",
      value: -summary.operating_expenses_cents,
      prior: prior ? -prior.operating_expenses_cents : undefined,
      kind: "deduction",
      note: `${summary.expense_count} entries`,
    },
    { label: "Net profit", value: summary.net_profit_cents, prior: prior?.net_profit_cents, kind: "result" },
  ];

  return (
    <Section
      title="Profit and loss"
      actions={
        <span className="text-xs text-muted">
          {summary.cost_method === "latest" ? "Costs at latest price" : "Costs at moving average"}
        </span>
      }
    >
      <Table
        head={
          <tr>
            <th className="py-2 pr-4 font-medium">Line</th>
            <th className="py-2 pr-4 text-right font-medium">This period</th>
            <th className="py-2 pr-4 text-right font-medium">Previous</th>
            <th className="py-2 text-right font-medium">Change</th>
          </tr>
        }
      >
        {lines.map((line) => {
          const change = line.prior === undefined ? null : percentChange(line.value, line.prior);
          const isResult = line.kind === "result";
          const isTotal = line.kind === "total";
          return (
            <tr key={line.label} className={isResult ? "font-semibold" : isTotal ? "font-medium" : ""}>
              <td className={`py-2 pr-4 ${line.kind === "deduction" ? "pl-4 text-muted" : ""}`}>
                {line.label}
                {line.note && <span className="ml-2 text-xs text-muted">{line.note}</span>}
              </td>
              <td className="py-2 pr-4 text-right">
                {line.kind === "deduction" && line.value !== 0 ? "(" : ""}
                <Money cents={Math.abs(line.value)} muted={line.kind === "deduction"} />
                {line.kind === "deduction" && line.value !== 0 ? ")" : ""}
                {line.value < 0 && line.kind !== "deduction" && <span className="ml-1 text-xs text-danger">loss</span>}
              </td>
              <td className="py-2 pr-4 text-right text-muted">
                {line.prior === undefined ? "—" : <Money cents={Math.abs(line.prior)} muted />}
              </td>
              <td className="py-2 text-right">
                {change === null ? (
                  <span className="text-muted">—</span>
                ) : (
                  <span
                    className={`inline-flex items-center gap-1 ${
                      // For a cost line, an increase is bad; for a profit line, an increase is good.
                      (change > 0) === (line.kind === "deduction") ? "text-danger" : "text-success"
                    }`}
                  >
                    {change > 0 ? <TrendingUp size={13} /> : <TrendingDown size={13} />}
                    {formatPercent(Math.abs(change))}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </Table>

      <div className="mt-4 grid gap-2 border-t border-border pt-4 text-sm sm:grid-cols-2">
        <p className="text-muted">
          Gross margin{" "}
          <strong className="text-text">
            {summary.net_sales_cents === 0
              ? "—"
              : formatPercent((summary.gross_profit_cents / summary.net_sales_cents) * 100)}
          </strong>{" "}
          of net sales
        </p>
        <p className="text-muted">
          Net margin{" "}
          <strong className="text-text">
            {summary.net_sales_cents === 0
              ? "—"
              : formatPercent((summary.net_profit_cents / summary.net_sales_cents) * 100)}
          </strong>{" "}
          of net sales
        </p>
        {summary.capital_expenses_cents > 0 && (
          <p className="text-muted sm:col-span-2">
            A further <Money cents={summary.capital_expenses_cents} /> of capital purchases is excluded above,
            because equipment is not a running cost.
          </p>
        )}
        {summary.purchases_cents > 0 && (
          <p className="text-muted sm:col-span-2">
            <Money cents={summary.purchases_cents} /> of stock was bought this period. It is not in the
            profit lines: it becomes a cost as the goods are sold.
          </p>
        )}
      </div>
    </Section>
  );
}

/** Month navigation with a visible date range, so a report can never be for a period nobody chose. */
export function MonthPicker({ period, onChange }: { period: Period; onChange: (p: Period) => void }) {
  const current = new Date(`${period.from}T00:00:00`);
  return (
    <div className="flex items-center gap-1">
      <button
        className="rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm"
        aria-label="Previous month"
        onClick={() => onChange(monthPeriod(current, -1))}
      >
        ←
      </button>
      <input
        type="month"
        className="field w-auto"
        value={period.from.slice(0, 7)}
        onChange={(e) => {
          if (!e.target.value) return;
          onChange(monthPeriod(new Date(`${e.target.value}-01T00:00:00`)));
        }}
        aria-label="Report month"
      />
      <button
        className="rounded-lg border border-border bg-surface-2 px-2 py-2 text-sm"
        aria-label="Next month"
        onClick={() => onChange(monthPeriod(current, 1))}
      >
        →
      </button>
    </div>
  );
}
