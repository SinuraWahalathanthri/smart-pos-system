import { describe, expect, it } from "vitest";
import { addLine, roundQty, voidQty } from "../lib/bill";
import {
  BUSINESS_PROFILES,
  effectiveFeatures,
  featureOverrides,
  hasOptions,
  isMeasuredUnit,
  variantLabel,
  variantMatrix,
} from "../lib/business";
import { formatMoney, parseMoneyInput, setCurrency } from "../lib/money";
import { tileColor } from "../lib/sync/mappers";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("business profiles", () => {
  it("keeps every feature a pre-0030 shop used when it has no business type", () => {
    const f = effectiveFeatures(null, null);
    expect(f).toMatchObject({ packs: true, bottles: true, production: true, variants: false });
  });

  it("gives a clothing shop variants and no bottles", () => {
    const f = effectiveFeatures("fashion", null);
    expect(f.variants).toBe(true);
    expect(f.bottles).toBe(false);
    expect(f.expiry).toBe(false);
  });

  it("applies owner overrides on top of the type, and stores only the differences", () => {
    const f = effectiveFeatures("grocery", { bottles: true, expiry: false });
    expect(f).toMatchObject({ bottles: true, expiry: false, measured: true });
    expect(featureOverrides("grocery", f)).toEqual({ bottles: true, expiry: false });
    expect(featureOverrides("grocery", effectiveFeatures("grocery", null))).toEqual({});
  });

  it("lists exactly the business types the database accepts", () => {
    const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0030_business_types.sql"), "utf8");
    const list = /function public\.is_business_type[\s\S]*?select p_type in \(([\s\S]*?)\)/.exec(sql)![1];
    const ids = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(BUSINESS_PROFILES.map((p) => p.id).sort()).toEqual(ids);
  });

  it("offers only units the database accepts", async () => {
    const { UNITS } = await import("../lib/business");
    const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0030_business_types.sql"), "utf8");
    const list = /function public\.is_product_unit[\s\S]*?select p_unit in \(([\s\S]*?)\)/.exec(sql)![1];
    const ids = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(UNITS.map((u) => u.id).sort()).toEqual(ids);
    expect(isMeasuredUnit("kg")).toBe(true);
    expect(isMeasuredUnit("pair")).toBe(false);
  });
});

describe("variants", () => {
  it("builds every Size × Colour combination in order", () => {
    const m = variantMatrix([
      { name: "Size", values: ["S", "M"] },
      { name: "Colour", values: ["Black", "White"] },
    ]);
    expect(m.map(variantLabel)).toEqual(["S / Black", "S / White", "M / Black", "M / White"]);
  });

  it("skips an axis with no values instead of producing nothing", () => {
    expect(variantMatrix([{ name: "Size", values: ["S"] }, { name: "Colour", values: [] }]).map(variantLabel)).toEqual(["S"]);
    expect(variantMatrix([{ name: "Size", values: [] }])).toEqual([]);
  });

  it("sends a variant product to the option picker like a packet product", () => {
    expect(hasOptions({ saleMode: "variant" })).toBe(true);
    expect(hasOptions({ saleMode: "weighted" })).toBe(true);
    expect(hasOptions({ saleMode: "measured" })).toBe(false);
  });
});

describe("measured quantities", () => {
  it("keeps three decimals and never drifts", () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    const a = addLine([], { productId: "rice", name: "Rice", qty: 0.1, unitPrice: 45000, taxRate: 0, unit: "kg" });
    const b = addLine(a.lines, { productId: "rice", name: "Rice", qty: 0.2, unitPrice: 45000, taxRate: 0, unit: "kg" });
    expect(b.lines[0].qty).toBe(0.3);
    const v = voidQty(b.lines, b.id, 0.1, "too much", "Sup", 0);
    expect(v.find((l) => !l.voided)!.qty).toBe(0.2);
  });
});

describe("tile colours", () => {
  it("turns the old colour words into the hex the till can tint with", () => {
    expect(tileColor("amber")).toBe("#b45309");
    expect(tileColor("#123abc")).toBe("#123abc");
    expect(tileColor("chartreuse")).toBe("#78716c");
    expect(tileColor(null)).toBe("#78716c");
  });
});

describe("currency", () => {
  it("shows the shop's currency rather than always LKR", () => {
    setCurrency("GBP");
    expect(formatMoney(123456)).toBe("GBP 1,234.56");
    setCurrency("not a code");
    expect(formatMoney(100)).toBe("GBP 1.00");
    setCurrency("LKR");
    expect(formatMoney(100)).toBe("LKR 1.00");
  });

  it("reads what a cashier types with any currency in front", () => {
    expect(parseMoneyInput("Rs. 250")).toBe(25000);
    expect(parseMoneyInput("£2.50")).toBe(250);
    expect(parseMoneyInput("USD 1,000")).toBe(100000);
  });
});
