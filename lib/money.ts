/** Money is held as integer cents (1.00 = 100) so arithmetic never drifts. */
export type Cents = number;

/**
 * The shop's currency code, shown in front of amounts. It used to be the literal "LKR", so a shop in
 * the UK or India saw rupees on every bill. useShop() and the till set it from the shop as soon as it
 * loads, and it is remembered so the next start (offline included) shows the right code at once.
 */
const CURRENCY_KEY = "pos-currency";
let currencyCode = "LKR";
try {
  const saved = typeof window !== "undefined" ? window.localStorage.getItem(CURRENCY_KEY) : null;
  if (saved && /^[A-Z]{3}$/.test(saved)) currencyCode = saved;
} catch {
  /* storage blocked: keep the default */
}

export function setCurrency(code: string | null | undefined): void {
  if (!code || !/^[A-Z]{3}$/.test(code) || code === currencyCode) return;
  currencyCode = code;
  try {
    window.localStorage.setItem(CURRENCY_KEY, code);
  } catch {
    /* storage blocked */
  }
}

export const currentCurrency = () => currencyCode;

export const toCents = (rupees: number): Cents => Math.round(rupees * 100);

export function formatMoney(cents: Cents, withSymbol = true): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const rupees = Math.floor(abs / 100);
  const rest = String(abs % 100).padStart(2, "0");
  const grouped = rupees.toLocaleString("en-US");
  return `${sign}${withSymbol ? currencyCode + " " : ""}${grouped}.${rest}`;
}

/** Tax contained in a tax-inclusive gross amount. */
export function taxInside(gross: Cents, ratePct: number): Cents {
  if (ratePct <= 0) return 0;
  return Math.round((gross * ratePct) / (100 + ratePct));
}

export function lineTotal(unitPrice: Cents, qty: number): Cents {
  return Math.round(unitPrice * qty);
}

/** Parse what a cashier types into a money field: "1,500", "1500.5", "250", "Rs. 250", "£2.50". */
export function parseMoneyInput(input: string): Cents | null {
  const cleaned = input.replace(/[,\s]|Rs\.?|[A-Z]{3}|[$£€₹¥]/gi, "");
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
