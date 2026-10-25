import { beforeEach, describe, expect, it, vi } from "vitest";
import { addLine, computeBill } from "../lib/bill";
import { availableToSettle, eventLabel, toShopTotals, totalsFromEvents } from "../lib/bottles";
import { buildSale } from "../lib/checkout";
import { toSalePayload } from "../lib/sync/mappers";
import type { BillSnapshot, SaleRecord } from "../lib/types";

// The store persists to localStorage; this test runs in node, so give it one before importing.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});
const { usePos } = await import("../lib/store");

/**
 * A deposit is money, so at the till it is a line on the bill (0027). These pin the till's half:
 * the deposit is in the total, never under a discount, sent with the bottle it settles, and never
 * carried over to the next customer.
 */

const MILK = "11111111-1111-4111-8111-111111111111";
const chilli = { productId: "chilli", name: "Chilli Powder", qty: 1, unitPrice: 45000, taxRate: 0 };
const deposit = { productId: MILK, name: "Fresh Milk", qty: 1, unitPrice: 10000 };
const snap = (over: Partial<BillSnapshot> = {}): BillSnapshot => ({ lines: [], discount: 0, ...over });

describe("a deposit on the bill", () => {
  it("is part of the subtotal and the total, with no tax", () => {
    const bill = computeBill(snap({ lines: addLine([], chilli).lines, deposits: [deposit] }));
    expect(bill.subtotal).toBe(55000);
    expect(bill.total).toBe(55000);
    expect(bill.depositTotal).toBe(10000);
    expect(bill.taxIncluded).toBe(0);
    expect(bill.rows.map((r) => r.kind)).toEqual(["item", "deposit"]);
  });

  it("is never eaten by a discount, which is on the goods only", () => {
    const bill = computeBill(snap({ lines: addLine([], chilli).lines, deposits: [deposit], discount: 999999 }));
    expect(bill.discount).toBe(45000);
    expect(bill.total).toBe(10000);
  });

  it("can stand alone: a customer may come in only to pay for a bottle they keep", () => {
    const bill = computeBill(snap({ deposits: [{ ...deposit, qty: 2 }] }));
    expect(bill.total).toBe(20000);
  });

  it("is sent as a bottle_fee line naming the bottle it settles", () => {
    const { sale } = buildSale(
      snap({ lines: addLine([], chilli).lines, deposits: [deposit], customerId: "c1" }),
      { id: "u1", name: "Nimal" },
      { method: "cash", tendered: 60000 },
    );
    const fee = sale.lines.find((l) => l.kind === "bottle_fee")!;
    expect(fee).toMatchObject({ productId: MILK, qty: 1, unitPrice: 10000, lineTotal: 10000, taxAmount: 0 });
    expect(sale.bottleFeeCharged).toBe(10000);
    expect(sale.payments[0].amount).toBe(55000);

    const payload = toSalePayload({ ...sale, receiptNo: 1, syncStatus: "pending" } as SaleRecord);
    const lines = payload.lines as { kind: string; product_id: string | null }[];
    expect(lines.find((l) => l.kind === "bottle_fee")!.product_id).toBe(MILK);
  });

  it("still sends an older till's placeholder fee line with no product", () => {
    const legacy = {
      id: "s1", receiptNo: 1, createdAt: 0, cashierId: "u1", cashierName: "Nimal", voidedLines: [],
      subtotal: 10000, discount: 0, total: 10000, taxIncluded: 0, bottlesReturned: 0, bottleFeeCharged: 10000,
      payments: [{ method: "cash", amount: 10000 }], syncStatus: "pending",
      lines: [{ productId: "bottle-fee", name: "Bottle not returned", qty: 1, unitPrice: 10000, taxRate: 0, lineTotal: 10000, taxAmount: 0, kind: "bottle_fee" }],
    } as SaleRecord;
    expect((toSalePayload(legacy).lines as { product_id: string | null }[])[0].product_id).toBeNull();
  });
});

describe("the till's store", () => {
  beforeEach(() => {
    usePos.getState().clearBill();
    usePos.getState().attachCustomer({ id: "amara", name: "Amara" });
  });

  it("adds one deposit per tap and takes them off one at a time", () => {
    const s = usePos.getState();
    s.addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    s.addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    expect(usePos.getState().deposits).toEqual([{ productId: MILK, name: "Fresh Milk", unitPrice: 10000, qty: 2 }]);
    s.removeDeposit(MILK);
    s.removeDeposit(MILK);
    expect(usePos.getState().deposits).toEqual([]);
  });

  it("drops deposits when the bill moves to another customer, who owes none of them", () => {
    usePos.getState().addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    usePos.getState().attachCustomer({ id: "nimal", name: "Nimal" });
    expect(usePos.getState().deposits).toEqual([]);
  });

  it("keeps deposits when the same customer is attached again", () => {
    usePos.getState().addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    usePos.getState().attachCustomer({ id: "amara", name: "Amara" });
    expect(usePos.getState().deposits).toHaveLength(1);
  });

  it("puts deposits in the snapshot that payment and hold are built from", () => {
    usePos.getState().addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    expect(computeBill(usePos.getState().snapshot()).total).toBe(10000);
  });

  it("clears deposits with the bill", () => {
    usePos.getState().addDeposit({ productId: MILK, name: "Fresh Milk", unitPrice: 10000 });
    usePos.getState().clearBill();
    expect(usePos.getState().deposits).toEqual([]);
  });
});

describe("what a product row may offer", () => {
  it("never offers more than the customer owes in total", () => {
    // A same-sale return with no product leaves the row reading 2 while the customer owes 1.
    expect(availableToSettle({ product_id: MILK, outstanding: 2 }, 1, {})).toBe(1);
    expect(availableToSettle({ product_id: MILK, outstanding: 2 }, 0, {})).toBe(0);
  });

  it("counts deposits already on the bill as settled", () => {
    expect(availableToSettle({ product_id: MILK, outstanding: 2 }, 2, { [MILK]: 1 })).toBe(1);
    expect(availableToSettle({ product_id: MILK, outstanding: 2 }, 2, { [MILK]: 2 })).toBe(0);
    // A deposit for another bottle still uses up the customer's total.
    expect(availableToSettle({ product_id: MILK, outstanding: 1 }, 1, { other: 1 })).toBe(0);
  });
});

describe("the bottle book after a refund", () => {
  it("nets a reversal row out of the totals", () => {
    const t = totalsFromEvents([{ event: "sold", qty: 2 }, { event: "sold", qty: -2 }]);
    expect(t).toMatchObject({ sent_out: 0, outstanding: 0 });
  });

  it("labels a reversal so the feed does not read like a second sale", () => {
    expect(eventLabel({ event: "sold", qty: -1 })).toBe("Bottle out (reversed)");
    expect(eventLabel({ event: "sold", qty: 1 })).toBe("Bottle out");
  });

  it("reads the shop totals row, whatever shape PostgREST hands back", () => {
    expect(toShopTotals([{ sent_out: 5, returned: "2", outstanding: 3, customers_owing: 1 }])).toMatchObject({
      sent_out: 5, returned: 2, charged: 0, outstanding: 3, customers_owing: 1, walk_in_out: 0,
    });
    expect(toShopTotals(null).sent_out).toBe(0);
  });
});
