import { describe, expect, it } from "vitest";
import { addLine, BOTTLE_FEE, computeBill, voidQty } from "../lib/bill";
import { ean13CheckDigit, isValidEan13, makeEan13 } from "../lib/barcode";
import { evaluate } from "../lib/calc";
import { formatMoney, parseMoneyInput, priceForWeight, taxInside, toCents } from "../lib/money";
import type { BillLine, BillSnapshot } from "../lib/types";

const milk = {
  productId: "milk",
  name: "Fresh Milk (glass bottle)",
  qty: 1,
  unitPrice: toCents(250),
  taxRate: 0,
  returnableBottle: true,
};
const biscuit = { productId: "marie", name: "Marie Biscuit", qty: 1, unitPrice: toCents(120), taxRate: 18 };

const snap = (lines: BillLine[], extra: Partial<BillSnapshot> = {}): BillSnapshot => ({
  lines,
  bottlesReturned: 0,
  feeWaived: 0,
  discount: 0,
  ...extra,
});

describe("money", () => {
  it("formats with grouping and two decimals", () => {
    expect(formatMoney(123456)).toBe("LKR 1,234.56");
    expect(formatMoney(5, false)).toBe("0.05");
    expect(formatMoney(-250)).toBe("-LKR 2.50");
  });
  it("parses cashier input", () => {
    expect(parseMoneyInput("1,500")).toBe(150000);
    expect(parseMoneyInput("99.5")).toBe(9950);
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("12.345")).toBeNull();
    expect(parseMoneyInput("abc")).toBeNull();
  });
  it("extracts tax from a tax-inclusive price", () => {
    // 118.00 incl. 18% VAT -> 18.00 tax
    expect(taxInside(11800, 18)).toBe(1800);
    expect(taxInside(11800, 0)).toBe(0);
  });
  it("prices an arbitrary weight from a per-kg price", () => {
    expect(priceForWeight(toCents(1800), 250)).toBe(toCents(450));
    expect(priceForWeight(toCents(1800), 375)).toBe(toCents(675));
  });
});

describe("bill", () => {
  it("merges repeat scans into one line", () => {
    let lines: BillLine[] = [];
    lines = addLine(lines, biscuit).lines;
    lines = addLine(lines, biscuit).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].qty).toBe(2);
  });
  it("keeps different pack sizes of one spice on separate lines", () => {
    const curry = { productId: "curry", name: "Curry Powder", qty: 1, taxRate: 0 };
    let lines: BillLine[] = [];
    lines = addLine(lines, { ...curry, packSizeId: "250", label: "250 g", unitPrice: 45000 }).lines;
    lines = addLine(lines, { ...curry, packSizeId: "500", label: "500 g", unitPrice: 88000 }).lines;
    expect(lines).toHaveLength(2);
  });
  it("adds the LKR 100 fee for a milk bottle with no empty returned", () => {
    const bill = computeBill(snap(addLine([], milk).lines));
    expect(bill.feeCount).toBe(1);
    expect(bill.total).toBe(toCents(250) + BOTTLE_FEE);
    expect(bill.rows.some((r) => r.kind === "bottle_fee")).toBe(true);
  });
  it("charges the fee only on bottles without an empty (3 milks, 2 empties -> LKR 850)", () => {
    const lines = addLine([], { ...milk, qty: 3 }).lines;
    const bill = computeBill(snap(lines, { bottlesReturned: 2 }));
    expect(bill.total).toBe(toCents(850));
  });
  it("charges no fee when the empty is returned", () => {
    const bill = computeBill(snap(addLine([], milk).lines, { bottlesReturned: 1 }));
    expect(bill.total).toBe(toCents(250));
    expect(bill.rows.some((r) => r.kind === "bottle_fee")).toBe(false);
  });
  it("lets a supervisor waive the fee", () => {
    const bill = computeBill(snap(addLine([], milk).lines, { feeWaived: 1 }));
    expect(bill.total).toBe(toCents(250));
  });
  it("includes the tax contained in tax-inclusive prices", () => {
    const bill = computeBill(snap(addLine([], { ...biscuit, unitPrice: 11800 }).lines));
    expect(bill.total).toBe(11800);
    expect(bill.taxIncluded).toBe(1800);
  });
  it("caps the discount at the subtotal", () => {
    const bill = computeBill(snap(addLine([], biscuit).lines, { discount: 999999 }));
    expect(bill.total).toBe(0);
  });
});

describe("void", () => {
  it("removes one of two and keeps a struck-through record", () => {
    let lines: BillLine[] = [];
    lines = addLine(lines, { ...biscuit, qty: 2 }).lines;
    const id = lines[0].id;
    lines = voidQty(lines, id, 1, "Double scan", "Kamal", 1);
    const bill = computeBill(snap(lines));
    expect(bill.total).toBe(toCents(120));
    expect(bill.rows.filter((r) => r.kind === "voided")).toHaveLength(1);
    expect(lines.find((l) => !l.voided)?.qty).toBe(1);
  });
  it("removes a whole line", () => {
    let lines = addLine([], biscuit).lines;
    lines = voidQty(lines, lines[0].id, 5, "Wrong item", "Kamal", 1);
    expect(computeBill(snap(lines)).total).toBe(0);
  });
  it("drops the bottle fee when the milk itself is voided", () => {
    let lines = addLine([], milk).lines;
    lines = voidQty(lines, lines[0].id, 1, "Wrong item", "Kamal", 1);
    expect(computeBill(snap(lines)).total).toBe(0);
  });
});

describe("barcode", () => {
  it("computes EAN-13 check digits", () => {
    expect(ean13CheckDigit("400638133393")).toBe(1); // 4006381333931
    expect(isValidEan13("4006381333931")).toBe(true);
    expect(isValidEan13("4006381333932")).toBe(false);
  });
  it("makes valid in-store codes", () => {
    const code = makeEan13("200", 42);
    expect(code).toHaveLength(13);
    expect(isValidEan13(code)).toBe(true);
  });
});

describe("calculator", () => {
  it("respects precedence and parentheses", () => {
    expect(evaluate("2+3*4")).toBe(14);
    expect(evaluate("(2+3)*4")).toBe(20);
    expect(evaluate("1500-1040")).toBe(460);
    expect(evaluate("0.1+0.2")).toBe(0.3);
    expect(evaluate("-5+10")).toBe(5);
  });
  it("rejects bad input", () => {
    expect(() => evaluate("5/0")).toThrow();
    expect(() => evaluate("2+")).toThrow();
    expect(() => evaluate("2$3")).toThrow();
  });
});
