import { describe, expect, it } from "vitest";
import { buildSale } from "../lib/checkout";
import type { BillLine, BillSnapshot } from "../lib/types";

const line: BillLine = {
  id: "l1",
  productId: "p1",
  name: "Chilli Powder",
  label: "100 g",
  qty: 2,
  unitPrice: 24000,
  taxRate: 18,
  returnableBottle: false,
};

const cashier = { id: "c1", name: "Nimal" };

function snapshot(over: Partial<BillSnapshot> = {}): BillSnapshot {
  return { lines: [line], bottlesReturned: 0, feeWaived: 0, discount: 0, ...over };
}

/**
 * The till's bill panel reads customerId straight from the store, but PaymentDialog builds its own
 * small snapshot before calling buildSale. When that snapshot left the customer out, every sale was
 * written as a walk-in no matter who had been selected at the start of the bill - so these guard the
 * one hand-off where the customer can go missing.
 */
describe("turning the bill into a sale record", () => {
  it("carries the customer onto the sale", () => {
    const { sale } = buildSale(snapshot({ customerId: "cust-1", customerName: "Sandya Perera" }), cashier, { method: "cash" });
    expect(sale.customerId).toBe("cust-1");
    expect(sale.customerName).toBe("Sandya Perera");
  });

  it("leaves a walk-in without a customer", () => {
    const { sale } = buildSale(snapshot(), cashier, { method: "cash" });
    expect(sale.customerId).toBeUndefined();
    expect(sale.customerName).toBeUndefined();
  });

  it("records the credit method and the full amount owed", () => {
    const { sale } = buildSale(snapshot({ customerId: "cust-1" }), cashier, { method: "credit" });
    expect(sale.payments[0].method).toBe("credit");
    expect(sale.payments[0].amount).toBe(sale.total);
    // no cash was handed over, so there is no change to give
    expect(sale.payments[0].tendered).toBeUndefined();
    expect(sale.payments[0].change).toBeUndefined();
  });

  it("computes change only when cash was actually taken", () => {
    const { sale, change } = buildSale(snapshot(), cashier, { method: "cash", tendered: 60000 });
    expect(sale.total).toBe(48000);
    expect(change).toBe(12000);
  });

  it("does not let a credit sale produce change", () => {
    const { change } = buildSale(snapshot(), cashier, { method: "credit", tendered: 60000 });
    expect(change).toBe(0);
  });
});
