import { describe, expect, it } from "vitest";
import {
  byMostOwed,
  bottleWorth,
  matchesQuery,
  returnedPct,
  sumTotals,
  totalsFromEvents,
  type BottleEvent,
  type CustomerBottles,
} from "../lib/bottles";

/**
 * The bottle rule is a loan: a bottle goes out, handing it back is free, and keeping it means the
 * deposit is taken. The arithmetic here is the same rule the SQL uses, so these tests exist to pin
 * the sign of each term - a wrong sign either invents a debt or silently forgives one.
 */

const ev = (event: BottleEvent["event"], qty: number): Pick<BottleEvent, "event" | "qty"> => ({ event, qty });

describe("totals from the ledger", () => {
  it("counts a bottle out only when it was sold", () => {
    expect(totalsFromEvents([ev("sold", 3)])).toMatchObject({ sent_out: 3, outstanding: 3 });
  });

  it("treats a return as settling the loan, whichever path it took", () => {
    expect(totalsFromEvents([ev("sold", 2), ev("returned_later", 1)]).outstanding).toBe(1);
    expect(totalsFromEvents([ev("sold", 2), ev("returned_with_purchase", 1)]).outstanding).toBe(1);
  });

  it("treats a kept deposit as settling the loan too, because the shop has the money", () => {
    const t = totalsFromEvents([ev("sold", 2), ev("fee_charged", 2)]);
    expect(t.charged).toBe(2);
    expect(t.outstanding).toBe(0);
  });

  it("never lets a waiver cancel the bottle, only the money", () => {
    // This is the rule that is easiest to get wrong: waiver forgives the fee, not the loan.
    const t = totalsFromEvents([ev("sold", 2), ev("fee_waived", 2)]);
    expect(t.waived).toBe(2);
    expect(t.outstanding).toBe(2);
  });

  it("clamps at zero rather than reporting a negative debt", () => {
    expect(totalsFromEvents([ev("sold", 1), ev("returned_later", 3)]).outstanding).toBe(0);
  });

  it("ignores a refunded deposit: the bottle came back, the money went out again", () => {
    const t = totalsFromEvents([ev("sold", 1), ev("fee_charged", 1), ev("fee_refunded", 1)]);
    expect(t.outstanding).toBe(0);
  });
});

describe("what the bottles are worth", () => {
  it("values each outstanding bottle at the shop's deposit", () => {
    expect(bottleWorth(3, 10000)).toBe(30000);
  });

  it("is zero when nothing is out, however high the deposit", () => {
    expect(bottleWorth(0, 10000)).toBe(0);
  });

  it("refuses to value a negative count", () => {
    expect(bottleWorth(-2, 10000)).toBe(0);
  });
});

describe("percent settled", () => {
  it("counts a charged deposit as settled, because the bottle is no longer a loss", () => {
    expect(returnedPct({ sent_out: 10, returned: 5, charged: 5, waived: 0, outstanding: 0 })).toBe(100);
  });

  it("is zero for a shop that never had bottles", () => {
    expect(returnedPct({ sent_out: 0, returned: 0, charged: 0, waived: 0, outstanding: 0 })).toBe(0);
  });

  it("never exceeds 100 when a return was registered twice", () => {
    expect(returnedPct({ sent_out: 1, returned: 4, charged: 0, waived: 0, outstanding: 0 })).toBe(100);
  });
});

describe("summing the shop", () => {
  it("adds each column independently", () => {
    const total = sumTotals([
      { sent_out: 2, returned: 1, charged: 0, waived: 0, outstanding: 1 },
      { sent_out: 3, returned: 0, charged: 1, waived: 1, outstanding: 2 },
    ]);
    expect(total).toEqual({ sent_out: 5, returned: 1, charged: 1, waived: 1, outstanding: 3 });
  });

  it("is empty for an empty shop", () => {
    expect(sumTotals([])).toEqual({ sent_out: 0, returned: 0, charged: 0, waived: 0, outstanding: 0 });
  });
});

const debtor = (over: Partial<CustomerBottles>): CustomerBottles => ({
  customer_id: "c",
  name: "A",
  phone: "0771234567",
  sent_out: 1,
  returned: 0,
  charged: 0,
  waived: 0,
  outstanding: 1,
  worth_cents: 10000,
  last_out_at: null,
  last_return_at: null,
  ...over,
});

describe("who to chase first", () => {
  it("puts the biggest debtor at the top", () => {
    const rows = [
      debtor({ customer_id: "small", outstanding: 1 }),
      debtor({ customer_id: "big", outstanding: 4 }),
    ];
    expect(rows.sort(byMostOwed)[0].customer_id).toBe("big");
  });

  it("breaks a tie by who has had the bottle longest", () => {
    const rows = [
      debtor({ customer_id: "recent", last_out_at: "2026-05-01T00:00:00Z" }),
      debtor({ customer_id: "old", last_out_at: "2026-01-01T00:00:00Z" }),
    ];
    expect(rows.sort(byMostOwed)[0].customer_id).toBe("old");
  });
});

describe("searching the bottle book", () => {
  it("matches on part of a name, ignoring case", () => {
    expect(matchesQuery({ name: "Amara Perera", phone: "0771234567" }, "amar")).toBe(true);
  });

  it("matches the last digits of a number, the way a cashier asks for it", () => {
    expect(matchesQuery({ name: "Amara Perera", phone: "0771234567" }, "4567")).toBe(true);
  });

  it("ignores the punctuation people type into a number", () => {
    expect(matchesQuery({ name: "Amara", phone: "0771234567" }, "077-123")).toBe(true);
  });

  it("shows everything for an empty query", () => {
    expect(matchesQuery({ name: "Amara", phone: null }, "   ")).toBe(true);
  });

  it("does not match a customer with no number on a digits-only query", () => {
    expect(matchesQuery({ name: "Amara", phone: null }, "077")).toBe(false);
  });
});
