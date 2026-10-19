import { formatMoney } from "./money";
import type { SaleRecord } from "./types";

/**
 * The invoice, frozen at the moment of sale.
 *
 * Stored as a document rather than re-derived on demand: an invoice is evidence, and a reprint next
 * month must say what the customer was handed, not what today's product names and prices happen to
 * be. Everything the reader needs (shop, customer, points, tab, lines, payments) is snapshotted here.
 */
export interface InvoiceDoc {
  version: 1;
  saleId: string;
  receiptNo: number;
  issuedAt: string;
  shop: { name: string; address?: string; phone?: string; vatNo?: string };
  customer: {
    id?: string;
    name?: string;
    phone?: string;
    pointsBefore: number;
    pointsEarned: number;
    pointsAfter: number;
    creditBefore: number;
    creditAfter: number;
    creditLimit: number;
  } | null;
  cashier: string;
  lines: { name: string; label?: string; qty: number; unitPrice: number; total: number; voided?: string }[];
  subtotal: number;
  discount: number;
  total: number;
  payments: { method: string; amount: number }[];
  bottlesReturned: number;
}

export interface InvoiceCustomerInput {
  id?: string;
  name?: string;
  phone?: string;
  pointsBefore?: number;
  creditBefore?: number;
  creditLimit?: number;
}

export function buildInvoice(
  sale: SaleRecord,
  opts: {
    shop: { name: string; address?: string; phone?: string; vatNo?: string };
    customer?: InvoiceCustomerInput | null;
    /** Points and tab as the server now holds them, after this sale. */
    after?: { points?: number; creditCents?: number } | null;
  },
): InvoiceDoc {
  const c = sale.customerId ? (opts.customer ?? { id: sale.customerId, name: sale.customerName }) : null;
  const pointsBefore = c?.pointsBefore ?? 0;
  const creditBefore = c?.creditBefore ?? 0;
  const pointsAfter = opts.after?.points ?? pointsBefore;
  const creditAfter = opts.after?.creditCents ?? creditBefore;

  return {
    version: 1,
    saleId: sale.id,
    receiptNo: sale.receiptNo,
    issuedAt: new Date(sale.createdAt).toISOString(),
    shop: opts.shop,
    customer: c
      ? {
          id: c.id,
          name: c.name ?? sale.customerName,
          phone: c.phone,
          pointsBefore,
          pointsEarned: Math.max(0, pointsAfter - pointsBefore),
          pointsAfter,
          creditBefore,
          creditAfter,
          creditLimit: c.creditLimit ?? 0,
        }
      : null,
    cashier: sale.cashierName,
    lines: [
      ...sale.lines.map((l) => ({
        name: l.name,
        label: l.label,
        qty: l.qty,
        unitPrice: l.unitPrice,
        total: l.lineTotal,
      })),
      ...sale.voidedLines.map((l) => ({
        name: l.name,
        label: l.label,
        qty: l.qty,
        unitPrice: l.unitPrice,
        total: l.qty * l.unitPrice,
        voided: l.reason,
      })),
    ],
    subtotal: sale.subtotal,
    discount: sale.discount,
    total: sale.total,
    payments: sale.payments.map((p) => ({ method: p.method, amount: p.amount })),
    bottlesReturned: sale.bottlesReturned,
  };
}

const METHOD_LABEL: Record<string, string> = {
  cash: "Cash",
  card: "Card",
  qr: "QR / transfer",
  credit: "On account (tab)",
};

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A one-page A4 document the browser can print or save as PDF, with no external assets. */
export function invoiceHtml(inv: InvoiceDoc): string {
  const when = new Date(inv.issuedAt).toLocaleString();
  const rows = inv.lines
    .map(
      (l) => `<tr${l.voided ? ' class="void"' : ""}>
      <td>${esc(l.name)}${l.label ? ` <span class="muted">${esc(l.label)}</span>` : ""}${
        l.voided ? ` <span class="voidtag">void: ${esc(l.voided)}</span>` : ""
      }</td>
      <td class="num">${l.qty}</td>
      <td class="num">${formatMoney(l.unitPrice)}</td>
      <td class="num">${l.voided ? "—" : formatMoney(l.total)}</td>
    </tr>`,
    )
    .join("");

  const pays = inv.payments
    .map((p) => `<tr><td>${esc(METHOD_LABEL[p.method] ?? p.method)}</td><td class="num">${formatMoney(p.amount)}</td></tr>`)
    .join("");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>Receipt ${inv.receiptNo}</title>
<style>
  * { box-sizing: border-box; }
  body { font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif; color: #1a1a1a; margin: 0; padding: 28px; }
  .sheet { max-width: 720px; margin: 0 auto; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  .muted { color: #666; }
  .head { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #1a1a1a; padding-bottom: 12px; }
  .head .meta { text-align: right; font-size: 12px; }
  .parties { display: flex; gap: 40px; margin: 16px 0 18px; }
  .parties h2 { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #666; margin: 0 0 4px; }
  table { width: 100%; border-collapse: collapse; }
  th { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: #666; text-align: left;
       border-bottom: 1px solid #ccc; padding: 6px 0; }
  td { padding: 6px 0; border-bottom: 1px solid #eee; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .totals { margin-left: auto; width: 280px; margin-top: 12px; }
  .totals td { border: 0; padding: 4px 0; }
  .grand td { border-top: 2px solid #1a1a1a; font-weight: 700; font-size: 15px; padding-top: 8px; }
  .void td { text-decoration: line-through; color: #999; }
  .voidtag { font-size: 10px; color: #b00; text-decoration: none; }
  .points { margin-top: 20px; border: 1px solid #1a1a1a; border-radius: 8px; padding: 12px 14px; }
  .points b { font-size: 15px; }
  .foot { margin-top: 24px; font-size: 11px; color: #666; border-top: 1px solid #eee; padding-top: 10px; }
  .badge { display: inline-block; border: 1px solid #1a1a1a; border-radius: 999px; padding: 1px 9px; font-size: 11px; }
  @media print { body { padding: 0; } .sheet { max-width: none; } @page { margin: 16mm; } }
</style></head>
<body><div class="sheet">

  <div class="head">
    <div>
      <h1>${esc(inv.shop.name)}</h1>
      ${inv.shop.address ? `<div class="muted">${esc(inv.shop.address)}</div>` : ""}
      ${inv.shop.phone ? `<div class="muted">${esc(inv.shop.phone)}</div>` : ""}
      ${inv.shop.vatNo ? `<div class="muted">VAT ${esc(inv.shop.vatNo)}</div>` : ""}
    </div>
    <div class="meta">
      <div><strong>Receipt ${inv.receiptNo}</strong></div>
      <div class="muted">${esc(when)}</div>
      <div class="muted">Served by ${esc(inv.cashier)}</div>
    </div>
  </div>

  <div class="parties">
    <div>
      <h2>Customer</h2>
      ${
        inv.customer
          ? `<div><strong>${esc(inv.customer.name ?? "—")}</strong></div>
             ${inv.customer.phone ? `<div class="muted">${esc(inv.customer.phone)}</div>` : ""}
             <div class="muted">${inv.customer.pointsAfter} points${
               inv.customer.creditAfter > 0 ? ` &middot; ${formatMoney(inv.customer.creditAfter)} on account` : ""
             }</div>`
          : `<div><strong>Walk-in</strong></div><div class="muted">No customer account</div>`
      }
    </div>
    <div>
      <h2>Payment</h2>
      <table>${pays}</table>
    </div>
  </div>

  <table>
    <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td class="num">${formatMoney(inv.subtotal)}</td></tr>
    ${inv.discount > 0 ? `<tr><td>Discount</td><td class="num">-${formatMoney(inv.discount)}</td></tr>` : ""}
    <tr class="grand"><td>Total</td><td class="num">${formatMoney(inv.total)}</td></tr>
  </table>

  ${
    inv.customer
      ? `<div class="points">
           <span class="badge">${inv.customer.pointsEarned > 0 ? `+${inv.customer.pointsEarned} point${inv.customer.pointsEarned === 1 ? "" : "s"}` : "No points this order"}</span>
           <div style="margin-top:6px">
             Balance: <b>${inv.customer.pointsAfter} points</b>
           </div>
           ${
             inv.customer.creditLimit > 0
               ? `<div class="muted" style="margin-top:4px">
                    Credit: ${formatMoney(inv.customer.creditAfter)} outstanding of ${formatMoney(inv.customer.creditLimit)} limit
                  </div>`
               : ""
           }
         </div>`
      : ""
  }

  <div class="foot">
    ${inv.bottlesReturned > 0 ? `${inv.bottlesReturned} bottle(s) returned. ` : ""}
    Points accrue at LKR 100 spent = 1 point. Thank you.
  </div>

</div></body></html>`;
}

/** Human-readable name for a stored invoice, used as the download filename. */
export function invoiceFilename(inv: InvoiceDoc): string {
  const day = inv.issuedAt.slice(0, 10);
  return `receipt-${inv.receiptNo}-${day}.html`;
}
