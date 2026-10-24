/**
 * CSV export for the finance screens.
 *
 * Deliberately small and dependency-free: an accountant wants a file Excel opens with the numbers
 * intact, and a shop counter should not need a spreadsheet library to produce one.
 *
 * Two rules that matter more than they look:
 *   - Money is written as a decimal number with two places and no thousands separator, so Excel
 *     treats it as a number rather than as text.
 *   - A leading =, +, -, or @ is escaped with a quote. Without this, a payee named "=HYPERLINK(...)"
 *     becomes a live formula when the file is opened, which is a real spreadsheet-injection attack.
 */

type Primitive = string | number | boolean | null | undefined;

/** One CSV cell, quoted only when it has to be, and never allowed to start a formula. */
export function csvCell(value: Primitive): string {
  if (value === null || value === undefined) return "";
  let text = typeof value === "string" ? value : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

/** Cents as a plain decimal: 150075 -> "1500.75". Never with a symbol or separators. */
export function centsToDecimal(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

export interface CsvColumn<T> {
  header: string;
  value: (row: T) => Primitive;
}

export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const head = columns.map((c) => csvCell(c.header)).join(",");
  const body = rows.map((row) => columns.map((c) => csvCell(c.value(row))).join(","));
  // A BOM so Excel on Windows reads the rupee sign and any Sinhala/Tamil text as UTF-8.
  return `\uFEFF${[head, ...body].join("\r\n")}\r\n`;
}

/** Trigger a download in the browser. Kept separate so the CSV builders stay testable. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** A filename that sorts chronologically and survives every filesystem. */
export function exportFilename(prefix: string, from: string, to: string): string {
  const safePrefix = prefix.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");
  return `${safePrefix}-${from}_to_${to}.csv`;
}
