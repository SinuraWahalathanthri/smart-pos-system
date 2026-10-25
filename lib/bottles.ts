import type { Cents } from "./money";

/**
 * Bottles are a loan tied to a person, not to a bill.
 *
 * The shop hands out a returnable bottle without taking the deposit. The customer owes the bottle
 * back; the deposit is only taken if they keep it, and then as a line on a bill at the till. Every row below therefore counts BOTTLES, and
 * `outstanding` is the same rule the database uses (`customer_bottles_outstanding`):
 *
 *     given out - returned - charged
 *
 * `waived` is reported but never subtracted: waiving the fee forgives the money, not the bottle.
 */
export interface BottleTotals {
  sent_out: number;
  returned: number;
  charged: number;
  waived: number;
  outstanding: number;
}

export interface CustomerBottles extends BottleTotals {
  customer_id: string;
  name: string;
  phone: string | null;
  /** What the outstanding bottles are worth at the shop's deposit, in cents. */
  worth_cents: Cents;
  last_out_at: string | null;
  last_return_at: string | null;
}

/** customer_bottles_by_product() reports no waivers: a waiver was per bill, never per product. */
export interface ProductBottles extends Omit<BottleTotals, "waived"> {
  product_id: string;
  name: string;
}

/** bottle_totals(): the whole shop and every customer, not one page of the list. */
export interface ShopBottleTotals extends BottleTotals {
  customers_owing: number;
  /** Bottles sold with no customer attached. Counted apart: there is no one to chase. */
  walk_in_out: number;
}

export function emptyShopTotals(): ShopBottleTotals {
  return { ...emptyTotals(), customers_owing: 0, walk_in_out: 0 };
}

/** The RPC returns one row (an array, through PostgREST). Anything missing reads as zero. */
export function toShopTotals(data: unknown): ShopBottleTotals {
  const row = (Array.isArray(data) ? data[0] : data) as Partial<Record<keyof ShopBottleTotals, unknown>> | null | undefined;
  const out = emptyShopTotals();
  if (!row) return out;
  for (const k of Object.keys(out) as (keyof ShopBottleTotals)[]) {
    const n = Number(row[k] ?? 0);
    out[k] = Number.isFinite(n) ? n : 0;
  }
  return out;
}

export type BottleEventName =
  | "sold"
  | "returned_with_purchase"
  | "returned_later"
  | "fee_charged"
  | "fee_waived"
  | "fee_refunded"
  | "collected_by_dairy";

export interface BottleEvent {
  id: string;
  customer_id: string | null;
  customer_name: string | null;
  product_name: string | null;
  event: BottleEventName;
  qty: number;
  amount_cents: Cents;
  created_at: string;
}

export const BOTTLE_EVENT_LABEL: Record<BottleEventName, string> = {
  sold: "Bottle out",
  returned_with_purchase: "Returned at the sale",
  returned_later: "Returned later",
  fee_charged: "Deposit kept",
  fee_waived: "Fee waived",
  fee_refunded: "Deposit refunded",
  collected_by_dairy: "Collected by dairy",
};

/**
 * What a movement was, for the feed. A negative row is a reversal written when a sale is refunded
 * or cancelled: the ledger is append-only, so undoing a row means adding its opposite.
 */
export function eventLabel(e: Pick<BottleEvent, "event" | "qty">): string {
  const label = BOTTLE_EVENT_LABEL[e.event] ?? e.event;
  return e.qty < 0 ? `${label} (reversed)` : label;
}

/** Events that take a bottle out of the shop, and those that settle the loan. */
const ADDS: BottleEventName[] = ["sold"];
const SETTLES: BottleEventName[] = ["returned_with_purchase", "returned_later", "fee_charged"];

export function emptyTotals(): BottleTotals {
  return { sent_out: 0, returned: 0, charged: 0, waived: 0, outstanding: 0 };
}

/**
 * Local recomputation of an RPC's numbers, used by tests and as a guard against a stale server
 * payload. It deliberately mirrors the SQL rather than inventing a second definition.
 */
export function totalsFromEvents(events: Pick<BottleEvent, "event" | "qty">[]): BottleTotals {
  const out = emptyTotals();
  for (const e of events) {
    if (ADDS.includes(e.event)) out.sent_out += e.qty;
    else if (SETTLES.includes(e.event)) {
      if (e.event === "fee_charged") out.charged += e.qty;
      else out.returned += e.qty;
    } else if (e.event === "fee_waived") out.waived += e.qty;
  }
  out.outstanding = Math.max(0, out.sent_out - out.returned - out.charged);
  return out;
}

/** The deposit value of what is still out. */
export function bottleWorth(outstanding: number, feeCents: Cents): Cents {
  return Math.max(0, Math.round(outstanding)) * Math.max(0, Math.round(feeCents));
}

/**
 * Shop-wide totals across customers. Walk-in bottles (no customer attached) are excluded: they
 * cannot be attributed, and showing them in a per-customer total would invent an owner.
 */
export function sumTotals(rows: BottleTotals[]): BottleTotals {
  return rows.reduce(
    (acc, r) => ({
      sent_out: acc.sent_out + r.sent_out,
      returned: acc.returned + r.returned,
      charged: acc.charged + r.charged,
      waived: acc.waived + r.waived,
      outstanding: acc.outstanding + r.outstanding,
    }),
    emptyTotals(),
  );
}

/** "% returned", for the owner's view. Charged bottles count as settled, not as still lost. */
export function returnedPct(t: BottleTotals): number {
  const settled = t.returned + t.charged;
  if (t.sent_out <= 0) return 0;
  return Math.min(100, Math.round((settled / t.sent_out) * 100));
}

/** Who to chase first: most bottles, then the one who has had them longest. */
export function byMostOwed(a: CustomerBottles, b: CustomerBottles): number {
  if (b.outstanding !== a.outstanding) return b.outstanding - a.outstanding;
  const at = a.last_out_at ? Date.parse(a.last_out_at) : 0;
  const bt = b.last_out_at ? Date.parse(b.last_out_at) : 0;
  return at - bt;
}

/** A customer matches a search by name or by the digits of their number. */
export function matchesQuery(row: Pick<CustomerBottles, "name" | "phone">, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (row.name.toLowerCase().includes(q)) return true;
  const digits = q.replace(/\D/g, "");
  return !!digits && (row.phone ?? "").includes(digits);
}

/**
 * How many bottles a product row may still return or pay for.
 *
 * The per-product rows cannot see empties that were never credited to a product (returns taken
 * with an older bill), so a row can say "owing" when the customer owes nothing. The customer's
 * total is the server's rule, and a row may never offer more than it. Deposits already on the bill
 * count as settled, or the same bottle could be handed back and paid for.
 */
export function availableToSettle(
  row: Pick<ProductBottles, "product_id" | "outstanding">,
  customerTotal: number,
  pending: Record<string, number>,
): number {
  const pendingTotal = Object.values(pending).reduce((n, q) => n + q, 0);
  const left = Math.max(0, customerTotal - pendingTotal);
  return Math.max(0, Math.min(row.outstanding - (pending[row.product_id] ?? 0), left));
}
