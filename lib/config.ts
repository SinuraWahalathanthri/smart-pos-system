/** Shop-level defaults. These become rows in the Supabase `settings` table in the next phase. */
export const SHOP_NAME = "My Spice Shop";
export const CURRENCY = "LKR";
/** Discount (percent of the bill) a cashier may give without a supervisor. */
export const CASHIER_DISCOUNT_LIMIT_PCT = 5;
/** Keep selling when stock shows zero? Counts are rarely perfect, so the default is yes with a warning. */
export const ALLOW_SELL_OUT_OF_STOCK = true;
/** Stock level at or below which a spice pack size is flagged LOW. */
export const PACK_LOW_STOCK = 3;
