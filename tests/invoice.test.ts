import { describe, expect, it } from "vitest";
import { buildInvoice, invoiceFilename, invoiceHtml } from "../lib/invoice";
import type { SaleRecord } from "../lib/types";

const sale: SaleRecord = {
  id: "11111111-1111-1111-1111-111111111111",
  receiptNo: 10042,
  createdAt: Date.parse("2026-10-17T09:30:00+05:30"),
  cashierId: "c1",
  cashierName: "Nimal",
  lines: [
    { productId: "p1", name: "Chilli Powder", label: "100 g", qty: 2, unitPrice: 24000, taxRate: 18, lineTotal: 48000, taxAmount: 7322, kind: "item" },
    { productId: "p2", name: "Turmeric", qty: 1, unitPrice: 11000, taxRate: 18, lineTotal: 11000, taxAmount: 1678, kind: "item" },
  ],
  voidedLines: [
    { productId: "p3", name: "Cinnamon", qty: 1, unitPrice: 9000, reason: "Wrong item", by: "Nimal" },
  ],
  subtotal: 59000,
  discount: 0,
  total: 59000,
  taxIncluded: 9000,
  bottlesReturned: 0,
  bottleFeeCharged: 0,
  customerId: "cust-1",
  customerName: "Sandya Perera",
  payments: [{ method: "cash", amount: 59000, tendered: 60000, change: 1000 }],
  syncStatus: "synced",
};

const shop = { name: "Spice House", address: "12 Main St, Kandy", phone: "0812345678" };

describe("the invoice for a sale", () => {
  it("records the customer and the points this order earned", () => {
    const inv = buildInvoice(sale, {
      shop,
      customer: { id: "cust-1", name: "Sandya Perera", phone: "0771234567", pointsBefore: 12, creditBefore: 0, creditLimit: 50000 },
      after: { points: 17, creditCents: 0 },
    });
    expect(inv.customer).toBeTruthy();
    expect(inv.customer!.pointsBefore).toBe(12);
    expect(inv.customer!.pointsAfter).toBe(17);
    expect(inv.customer!.pointsEarned).toBe(5);
    expect(inv.customer!.phone).toBe("0771234567");
  });

  it("shows the tab growing when the sale went on credit", () => {
    const inv = buildInvoice(
      { ...sale, payments: [{ method: "credit", amount: 59000 }] },
      { shop, customer: { id: "cust-1", name: "Sandya Perera", pointsBefore: 0, creditBefore: 10000, creditLimit: 50000 }, after: { points: 5, creditCents: 69000 } },
    );
    expect(inv.customer!.creditBefore).toBe(10000);
    expect(inv.customer!.creditAfter).toBe(69000);
  });

  it("marks a walk-in as having no account", () => {
    const inv = buildInvoice({ ...sale, customerId: undefined, customerName: undefined }, { shop });
    expect(inv.customer).toBeNull();
  });

  it("keeps the customer name that was on the sale even without a snapshot", () => {
    const inv = buildInvoice(sale, { shop });
    expect(inv.customer!.name).toBe("Sandya Perera");
    // no snapshot means no point/tab history to claim
    expect(inv.customer!.pointsBefore).toBe(0);
    expect(inv.customer!.pointsAfter).toBe(0);
  });

  it("never reports negative points when a refund shrinks the balance", () => {
    const inv = buildInvoice(sale, { shop, customer: { id: "cust-1", name: "X", pointsBefore: 10 }, after: { points: 4 } });
    expect(inv.customer!.pointsEarned).toBe(0);
  });

  it("renders the frozen figures, the void line and the shop details", () => {
    const inv = buildInvoice(sale, { shop, customer: { id: "cust-1", name: "Sandya Perera", pointsBefore: 12 }, after: { points: 17 } });
    const html = invoiceHtml(inv);
    expect(html).toContain("Spice House");
    expect(html).toContain("Receipt 10042");
    expect(html).toContain("Sandya Perera");
    expect(html).toContain("Chilli Powder");
    expect(html).toContain("Wrong item");        // the void reason is evidence, not decoration
    expect(html).toContain("+5 points");
    expect(html).toContain("17 points");
    // LKR formatting, not raw cents
    expect(html).not.toContain("59000");
  });

  it("says Walk-in for a sale without a customer", () => {
    const html = invoiceHtml(buildInvoice({ ...sale, customerId: undefined, customerName: undefined }, { shop }));
    expect(html).toContain("Walk-in");
    expect(html).not.toContain("points</b>");
  });

  it("escapes a name that would otherwise inject markup", () => {
    const html = invoiceHtml(
      buildInvoice({ ...sale, customerName: "<script>alert(1)</script>" }, { shop, customer: { id: "x", name: "<script>alert(1)</script>" } }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("names the download after the receipt and the day", () => {
    const inv = buildInvoice(sale, { shop });
    expect(invoiceFilename(inv)).toBe("receipt-10042-2026-10-17.html");
  });
});
