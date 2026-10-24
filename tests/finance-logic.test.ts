import { describe, expect, it } from "vitest";
import {
  describeDue,
  describeExpenseStatus,
  financeWarnings,
  fiscalYearPeriod,
  formatPercent,
  isEmptyPeriod,
  marginPercent,
  markupPercent,
  monthPeriod,
  outstanding,
  percentChange,
  previousPeriod,
  quarterPeriod,
  type FinanceSummary,
} from "../lib/finance";
import { centsToDecimal, csvCell, exportFilename, toCsv } from "../lib/export";

/**
 * The rules a shopkeeper relies on when reading a number.
 *
 * These are the boundaries that are easy to get quietly wrong: a percentage with nothing to compare
 * against, a month that ends on the wrong day, a CSV that Excel executes as a formula.
 */

describe("periods", () => {
  it("covers a whole month, including a leap February", () => {
    expect(monthPeriod(new Date("2024-02-14T12:00:00"))).toEqual({
      from: "2024-02-01",
      to: "2024-02-29",
      label: "February 2024",
    });
    expect(monthPeriod(new Date("2025-02-14T12:00:00")).to).toBe("2025-02-28");
    expect(monthPeriod(new Date("2025-12-31T12:00:00"))).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
  });

  it("steps back a month, and across a year boundary", () => {
    expect(monthPeriod(new Date("2025-01-15T12:00:00"), -1)).toMatchObject({ from: "2024-12-01", to: "2024-12-31" });
    expect(monthPeriod(new Date("2025-12-15T12:00:00"), 1)).toMatchObject({ from: "2026-01-01", to: "2026-01-31" });
  });

  it("gives the previous period the same number of days, not the previous month", () => {
    // March has 31 days, so the comparison window is 31 days ending the day before it starts.
    const p = previousPeriod({ from: "2026-03-01", to: "2026-03-31", label: "March" });
    expect(p).toEqual({ from: "2026-01-29", to: "2026-02-28", label: "previous period" });
  });

  it("handles a single-day period", () => {
    expect(previousPeriod({ from: "2026-05-10", to: "2026-05-10", label: "" })).toMatchObject({
      from: "2026-05-09",
      to: "2026-05-09",
    });
  });

  it("builds quarters and years", () => {
    expect(quarterPeriod(new Date("2026-05-20T12:00:00"))).toMatchObject({ from: "2026-04-01", to: "2026-06-30" });
    expect(quarterPeriod(new Date("2026-02-01T12:00:00"))).toMatchObject({ from: "2026-01-01", to: "2026-03-31" });
    expect(quarterPeriod(new Date("2026-02-01T12:00:00"), -1)).toMatchObject({ from: "2025-10-01", to: "2025-12-31" });
  });

  it("starts a fiscal year in the month the shop chose", () => {
    // April start: May 2026 is in FY 2026/27, February 2026 is still in FY 2025/26.
    expect(fiscalYearPeriod(4, new Date("2026-05-20T12:00:00"))).toMatchObject({ from: "2026-04-01", to: "2027-03-31" });
    expect(fiscalYearPeriod(4, new Date("2026-02-20T12:00:00"))).toMatchObject({ from: "2025-04-01", to: "2026-03-31" });
    expect(fiscalYearPeriod(1, new Date("2026-05-20T12:00:00"))).toMatchObject({ from: "2026-01-01", to: "2026-12-31" });
  });

  it("treats a nonsensical fiscal month as January rather than throwing", () => {
    expect(fiscalYearPeriod(0, new Date("2026-05-20T12:00:00")).from).toBe("2026-01-01");
    // 99 clamps to December. In May 2026 the current December-start year began in Dec 2025.
    expect(fiscalYearPeriod(99, new Date("2026-05-20T12:00:00")).from).toBe("2025-12-01");
  });
});

describe("percentages", () => {
  it("returns null, not zero, when there is nothing to compare against", () => {
    // "0%" would read as "no change", which is a different and false statement.
    expect(percentChange(500, 0)).toBeNull();
    expect(marginPercent(0, 100)).toBeNull();
    expect(markupPercent(1000, 0)).toBeNull();
  });

  it("computes an increase and a decrease", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(50, 100)).toBe(-50);
    expect(percentChange(100, 100)).toBe(0);
  });

  it("survives a negative base without inverting the sign", () => {
    // Going from -100 to -50 is an improvement of 50% of the magnitude, not a -50% fall.
    expect(percentChange(-50, -100)).toBe(50);
  });

  it("keeps margin and markup distinct, because they answer different questions", () => {
    // cost 60, revenue 100: profit 40
    expect(marginPercent(10000, 6000)).toBe(40); // 40 / 100
    expect(markupPercent(10000, 6000)).toBeCloseTo(66.7, 1); // 40 / 60
  });

  it("reports a loss as negative", () => {
    expect(marginPercent(10000, 15000)).toBe(-50);
    expect(markupPercent(10000, 15000)).toBeCloseTo(-33.3, 1);
  });

  it("formats a missing percentage as a dash rather than a number", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
    expect(formatPercent(12.34)).toBe("12.3%");
    expect(formatPercent(12.34, true)).toBe("+12.3%");
    expect(formatPercent(-12.34, true)).toBe("-12.3%");
  });
});

describe("money phrasing", () => {
  it("never reports a negative amount owed", () => {
    // A rounding artefact must not read as the shop owing the supplier money.
    expect(outstanding(10000, 12000)).toBe(0);
    expect(outstanding(10000, 4000)).toBe(6000);
  });

  it("describes a due date relative to today", () => {
    const today = new Date("2026-05-10T09:00:00");
    expect(describeDue("2026-05-10", today)).toBe("Due today");
    expect(describeDue("2026-05-11", today)).toBe("Due in 1 day");
    expect(describeDue("2026-05-20", today)).toBe("Due in 10 days");
    expect(describeDue("2026-05-09", today)).toBe("1 day overdue");
    expect(describeDue("2026-04-10", today)).toBe("30 days overdue");
    expect(describeDue(null, today)).toBe("No due date");
  });

  it("uses the words a shopkeeper uses for a status", () => {
    expect(describeExpenseStatus("partial")).toBe("Part paid");
    expect(describeExpenseStatus("unpaid")).toBe("Unpaid");
    expect(describeExpenseStatus("void")).toBe("Voided");
  });
});

describe("warnings", () => {
  const base: FinanceSummary = {
    from: "2026-05-01",
    to: "2026-05-31",
    currency: "LKR",
    gross_sales_cents: 0,
    discounts_cents: 0,
    refunds_cents: 0,
    net_sales_cents: 0,
    cancelled_bills: 0,
    refunded_bills: 0,
    bill_count: 0,
    collected_cents: 0,
    collected_at_till_cents: 0,
    credit_settled_cents: 0,
    cogs_cents: 0,
    unknown_cost_lines: 0,
    gross_profit_cents: 0,
    operating_expenses_cents: 0,
    capital_expenses_cents: 0,
    net_profit_cents: 0,
    output_vat_cents: 0,
    input_vat_expenses_cents: 0,
    input_vat_purchases_cents: 0,
    receivables_cents: 0,
    payables_cents: 0,
    unpaid_expenses_cents: 0,
    inventory_value_cents: 0,
    uncosted_products: 0,
    purchases_cents: 0,
    unpaid_purchases_cents: 0,
    purchase_count: 0,
    expense_count: 0,
    line_revenue_cents: 0,
    is_estimate: false,
    vat_registered: false,
    vat_rate_pct: 0,
    cost_method: "moving_average",
  };

  it("says nothing when every figure is exact", () => {
    expect(financeWarnings(base)).toEqual([]);
  });

  it("says which numbers are unreliable, and why", () => {
    const warnings = financeWarnings({ ...base, unknown_cost_lines: 3, uncosted_products: 2 });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/3 sold lines had no recorded cost/);
    expect(warnings[1]).toMatch(/2 products with stock on hand have no cost/);
  });

  it("uses singular wording for a single item", () => {
    const warnings = financeWarnings({ ...base, unknown_cost_lines: 1, uncosted_products: 1 });
    expect(warnings[0]).toMatch(/1 sold line had/);
    expect(warnings[1]).toMatch(/has no cost/);
  });

  it("explains a cancellation rather than hiding it", () => {
    expect(financeWarnings({ ...base, cancelled_bills: 1 })[0]).toMatch(/cancellation corrects a keying error/);
  });

  it("recognises a period with no trading at all", () => {
    expect(isEmptyPeriod(base)).toBe(true);
    expect(isEmptyPeriod({ ...base, bill_count: 1 })).toBe(false);
    expect(isEmptyPeriod({ ...base, refunds_cents: 100 })).toBe(false);
  });
});

describe("CSV export", () => {
  it("writes money as a plain decimal so a spreadsheet reads it as a number", () => {
    expect(centsToDecimal(150075)).toBe("1500.75");
    expect(centsToDecimal(5)).toBe("0.05");
    expect(centsToDecimal(0)).toBe("0.00");
    expect(centsToDecimal(-150075)).toBe("-1500.75");
    expect(centsToDecimal(null)).toBe("");
  });

  it("stops a cell being executed as a formula", () => {
    // Without the leading quote, opening the file would run this.
    expect(csvCell("=HYPERLINK(\"http://evil\",\"click\")")).toMatch(/^"'=HYPERLINK/);
    expect(csvCell("+1234")).toBe("'+1234");
    expect(csvCell("-50")).toBe("'-50");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
  });

  it("quotes only what has to be quoted", () => {
    expect(csvCell("Rent")).toBe("Rent");
    expect(csvCell("Kandy, Sri Lanka")).toBe('"Kandy, Sri Lanka"');
    expect(csvCell('He said "hi"')).toBe('"He said ""hi"""');
    expect(csvCell("line\nbreak")).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe("");
    expect(csvCell(42)).toBe("42");
  });

  it("builds a file with a BOM and CRLF endings", () => {
    const csv = toCsv(
      [
        { name: "Rent", amount: 400000 },
        { name: "Kandy, LK", amount: 1500 },
      ],
      [
        { header: "Description", value: (r) => r.name },
        { header: "Amount (LKR)", value: (r) => centsToDecimal(r.amount) },
      ],
    );
    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("Description,Amount (LKR)\r\n");
    expect(csv).toContain('"Kandy, LK",15.00\r\n');
    expect(csv.endsWith("\r\n")).toBe(true);
  });

  it("names a file so it sorts chronologically, and sanitises the prefix", () => {
    expect(exportFilename("expenses", "2026-05-01", "2026-05-31")).toBe("expenses-2026-05-01_to_2026-05-31.csv");
    // a path separator in the prefix must not become a directory
    expect(exportFilename("vat records/..", "2026-05-01", "2026-05-31")).toBe(
      "vat-records-..-2026-05-01_to_2026-05-31.csv",
    );
  });
});
