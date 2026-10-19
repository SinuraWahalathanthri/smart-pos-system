/** Money is held as integer cents (LKR 1.00 = 100) so arithmetic never drifts. */
export type Cents = number;

export const toCents = (rupees: number): Cents => Math.round(rupees * 100);

export function formatMoney(cents: Cents, withSymbol = true): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const rupees = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = rupees.toLocaleString("en-US");
  return `${sign}${withSymbol ? "LKR " : ""}${grouped}.${rest}`;
}

/** Tax contained in a tax-inclusive gross amount. */
export function taxInside(gross: Cents, ratePct: number): Cents {
  if (ratePct <= 0) return 0;
  return Math.round((gross * ratePct) / (100 + ratePct));
}

export function lineTotal(unitPrice: Cents, qty: number): Cents {
  return Math.round(unitPrice * qty);
}

/** Parse what a cashier types into a money field: "1,500", "1500.5", "250". */
export function parseMoneyInput(input: string): Cents | null {
  const cleaned = input.replace(/[,\s]|LKR|Rs\.?/gi, "");
  if (cleaned === "" || !/^\d*\.?\d{0,2}$/.test(cleaned) || cleaned === ".") return null;
  return toCents(Number(cleaned));
}

/** Round to a step in cents, e.g. step 100 = nearest rupee. */
export function roundToStep(cents: Cents, step: Cents): Cents {
  if (step <= 1) return cents;
  return Math.round(cents / step) * step;
}

/** Price for an arbitrary weight, from a per-kg price (used only by the optional custom-weight mode). */
export function priceForWeight(pricePerKg: Cents, grams: number, roundStep: Cents = 100): Cents {
  return roundToStep(Math.round((pricePerKg * grams) / 1000), roundStep);
}
