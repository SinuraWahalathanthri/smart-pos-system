"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Download, Save } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/money";
import type { CostMethod, FinanceSettings, Period, TaxSummary } from "@/lib/finance";
import { monthPeriod, quarterPeriod, yearPeriod } from "@/lib/finance";
import { centsToDecimal, downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import { ErrorNote, Loading, Money, PeriodLabel, Section, Table } from "./FinanceUI";

/**
 * Records for an accountant, and the shop settings those records depend on.
 *
 * This screen is deliberately careful about what it claims. It prepares figures — output tax from the
 * sale lines, input tax from supplier bills and expenses — and it shows the difference. It does not
 * call that difference "payable", because whether it is payable, carried forward or refunded depends
 * on the shop's registration and on rules this application does not encode. Getting that wrong
 * silently would be worse than not offering it at all.
 *
 * The settings at the bottom exist because the alternative was hardcoding a VAT rate, which would
 * quietly produce wrong figures for every shop on a different rate.
 */
export function TaxScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? (
        <TaxRecords isOwner={ctx?.role === "owner"} onShopChanged={ctx?.store ? undefined : undefined} />
      ) : (
        <NotAllowed what="tax records" role={ctx?.role} />
      )}
    </DashboardShell>
  );
}

type RangeKey = "this-month" | "last-quarter" | "this-year" | "custom";

function TaxRecords({ isOwner }: { isOwner: boolean; onShopChanged?: () => void }) {
  const [range, setRange] = useState<RangeKey>("this-month");
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [data, setData] = useState<TaxSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const { data: result, error: err } = await getSupabase().rpc("tax_summary", { p_from: p.from, p_to: p.to });
    setLoading(false);
    if (err) return setError(err.message);
    setError(null);
    setData(result as TaxSummary);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  function chooseRange(key: RangeKey) {
    setRange(key);
    if (key === "this-month") setPeriod(monthPeriod());
    if (key === "last-quarter") setPeriod(quarterPeriod(new Date(), -1));
    if (key === "this-year") setPeriod(yearPeriod());
  }

  function exportRecords() {
    if (!data) return;
    const lines = [
      { label: "VAT on sales", value: data.vat_on_sales_cents },
      { label: "VAT refunded", value: -data.vat_refunded_cents },
      { label: "Net output VAT", value: data.output_vat_cents },
      { label: "Input VAT on purchases", value: data.input_vat_purchases_cents },
      { label: "Input VAT on expenses", value: data.input_vat_expenses_cents },
      { label: "Total input VAT", value: data.input_vat_total_cents },
      { label: "Difference (not a liability)", value: data.vat_difference_cents },
      { label: "Taxable sales", value: data.taxable_sales_cents },
      { label: "Zero-rated sales", value: data.zero_rated_sales_cents },
    ];
    const csv = toCsv(lines, [
      { header: "Item", value: (r) => r.label },
      { header: "Amount (LKR)", value: (r) => centsToDecimal(r.value) },
    ]);
    downloadCsv(exportFilename("vat-records", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Tax records</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Range</span>
            <select
              className="field w-auto"
              value={range}
              onChange={(e) => chooseRange(e.target.value as RangeKey)}
              aria-label="Range"
            >
              <option value="this-month">This month</option>
              <option value="last-quarter">Last quarter</option>
              <option value="this-year">This year</option>
              <option value="custom">Custom dates</option>
            </select>
          </div>
          {range === "custom" && (
            <>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">From</span>
                <input
                  className="field w-auto"
                  type="date"
                  value={period.from}
                  onChange={(e) => setPeriod((p) => ({ ...p, from: e.target.value, label: "Custom" }))}
                  aria-label="From"
                />
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-xs font-medium uppercase tracking-wide text-muted">To</span>
                <input
                  className="field w-auto"
                  type="date"
                  value={period.to}
                  onChange={(e) => setPeriod((p) => ({ ...p, to: e.target.value, label: "Custom" }))}
                  aria-label="To"
                />
              </div>
            </>
          )}
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportRecords}
            disabled={!data}
          >
            <Download size={15} /> Export
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}
      {loading && !data && <Loading what="tax records" />}

      {data && (
        <>
          <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
            <div className="space-y-2">
              <p className="font-medium">These are records, not a tax return.</p>
              <p className="text-muted">{data.disclaimer}</p>
            </div>
          </div>

          {data.warnings.length > 0 && (
            <div className="rounded-xl border border-border bg-surface p-3 text-sm">
              <p className="mb-2 text-xs uppercase tracking-wide text-muted">Check before you file</p>
              <ul className="list-disc space-y-1 pl-5 text-muted">
                {data.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          <Section title="VAT for this period">
            <Table
              head={
                <tr>
                  <th className="py-2 pr-3 font-medium">Item</th>
                  <th className="py-2 pr-3 text-right font-medium">Amount</th>
                  <th className="py-2 font-medium">What it is</th>
                </tr>
              }
            >
              <Row label="VAT charged on sales" value={data.vat_on_sales_cents} note={`${data.sales_count} bills`} />
              {data.vat_refunded_cents !== 0 && (
                <Row label="VAT refunded to customers" value={-data.vat_refunded_cents} note="reversals" />
              )}
              <Row label="Net output VAT" value={data.output_vat_cents} bold />
              <Row label="Input VAT on supplier bills" value={data.input_vat_purchases_cents} note={`${data.purchase_count} bills`} />
              <Row label="Input VAT on expenses" value={data.input_vat_expenses_cents} note={`${data.expense_count} entries`} />
              <Row label="Total input VAT" value={data.input_vat_total_cents} bold />
              <Row
                label="Difference"
                value={data.vat_difference_cents}
                bold
                note="not a liability — see the note below"
              />
            </Table>

            <div className="mt-4 grid gap-3 border-t border-border pt-4 sm:grid-cols-3">
              <Figure label="Taxable sales" cents={data.taxable_sales_cents} />
              <Figure label="Zero-rated sales" cents={data.zero_rated_sales_cents} />
              <Figure label="Shop VAT rate" text={`${data.shop.vat_rate_pct}%`} />
            </div>

            <p className="mt-3 text-xs text-muted">
              The difference above is output VAT less input VAT. Whether it is payable, carried forward or
              refundable depends on your registration and on current rules, so it is left for your accountant
              to determine. Nothing here has been rounded to a filing period.
            </p>
          </Section>

          <Section title="Shop details on the record">
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              <Detail term="Shop" value={data.shop.name} />
              <Detail term="Address" value={data.shop.address ?? "Not set"} />
              <Detail term="VAT number" value={data.shop.vat_no ?? "Not set"} />
              <Detail term="TIN" value={data.shop.tin ?? "Not set"} />
              <Detail term="VAT registered" value={data.shop.is_vat_registered ? "Yes" : "No"} />
              <Detail term="Prices include tax" value={data.shop.prices_include_tax ? "Yes" : "No"} />
            </dl>
          </Section>

          {isOwner && <FinanceSettingsForm current={data} onSaved={() => void load(period)} />}
        </>
      )}
    </div>
  );
}

function Row({ label, value, note, bold }: { label: string; value: number; note?: string; bold?: boolean }) {
  return (
    <tr className={bold ? "font-semibold" : ""}>
      <td className="py-2 pr-3">{label}</td>
      <td className="py-2 pr-3 text-right">
        <Money cents={value} />
      </td>
      <td className="py-2 text-xs text-muted">{note}</td>
    </tr>
  );
}

function Figure({ label, cents, text }: { label: string; cents?: number; text?: string }) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-0.5 font-semibold">{text ?? <Money cents={cents} />}</p>
    </div>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted">{term}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * The shop's financial settings.
 *
 * Owner only, and every change is written to the audit trail by the RPC. The VAT rate starts at 0
 * rather than at any real-world figure: a rate the app guessed would be indistinguishable from one
 * the owner set, and the reports would be quietly wrong.
 */
function FinanceSettingsForm({ current, onSaved }: { current: TaxSummary; onSaved: () => void }) {
  const [registered, setRegistered] = useState(current.shop.is_vat_registered);
  const [rate, setRate] = useState(String(current.shop.vat_rate_pct));
  const [tin, setTin] = useState(current.shop.tin ?? "");
  const [vatNo, setVatNo] = useState(current.shop.vat_no ?? "");
  const [method, setMethod] = useState<CostMethod>("moving_average");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function save() {
    const ratePct = Number(rate);
    if (!Number.isFinite(ratePct) || ratePct < 0 || ratePct >= 100) {
      return setError("Enter the VAT rate as a percentage between 0 and 100.");
    }
    setBusy(true);
    setSaved(false);
    const { error: err } = await getSupabase().rpc("save_finance_settings", {
      p_is_vat_registered: registered,
      p_vat_rate_pct: ratePct,
      p_tin: tin.trim() || null,
      p_vat_no: vatNo.trim() || null,
      p_cost_method: method,
      p_fiscal_year_start_month: null,
    });
    setBusy(false);
    if (err) return setError(err.message);
    setError(null);
    setSaved(true);
    onSaved();
  }

  return (
    <Section title="Shop financial settings">
      <div className="space-y-3">
        {error && <ErrorNote message={error} />}
        {saved && <p className="text-sm text-success">Saved. Reports now use these settings.</p>}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={registered} onChange={(e) => setRegistered(e.target.checked)} />
          The shop is registered for VAT
        </label>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">VAT rate (%)</span>
            <input
              className="field"
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              inputMode="decimal"
              placeholder="18"
            />
            <span className="mt-1 block text-xs text-muted">Set this from your registration certificate.</span>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">VAT number</span>
            <input className="field" value={vatNo} onChange={(e) => setVatNo(e.target.value)} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">TIN</span>
            <input className="field" value={tin} onChange={(e) => setTin(e.target.value)} />
          </label>
        </div>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">How stock cost is worked out</span>
          <select className="field" value={method} onChange={(e) => setMethod(e.target.value as CostMethod)}>
            <option value="moving_average">Moving average — smooths price changes (recommended)</option>
            <option value="latest">Latest price — each delivery resets the cost</option>
          </select>
          <span className="mt-1 block text-xs text-muted">
            Sales already made keep the cost they were sold at, whichever you choose.
          </span>
        </label>

        <div className="flex justify-end">
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-fg disabled:opacity-40"
            onClick={() => void save()}
            disabled={busy}
          >
            <Save size={15} /> {busy ? "Saving..." : "Save settings"}
          </button>
        </div>
      </div>
    </Section>
  );
}

// Re-exported so the other finance screens can reuse the cost helper without duplicating it.
export function formatCost(cents: number | null): string {
  return cents === null ? "—" : formatMoney(cents);
}

export type { FinanceSettings };
