import { describe, expect, it } from "vitest";
import { LedgerEngine } from "../../lib/ldd/engine";
import { MemoryLedgerStore } from "../../lib/ldd/memory-store";
import { onHand, saleTotals, taxInside, emptyState, reduce, type PosState } from "../../lib/ldd/pos-reducer";
import { checkInvariants, errorsOnly, formatViolations, POS_INVARIANTS } from "../../lib/ldd/invariants";
import { stateDigest } from "../../lib/ldd/ledger";
import { POS_EVENTS } from "../../lib/ldd/pos-events";
import type { LedgerEvent } from "../../lib/ldd/types";

const STREAM = "store:11111111-1111-4111-8111-111111111111";
const P_CHILLI = "22222222-2222-4222-8222-222222222222";
const P_MILK = "44444444-4444-4444-8444-444444444444";
const P_BISCUIT = "55555555-5555-4555-8555-555555555555";
const CAT = "33333333-3333-4333-8333-333333333333";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const CASHIER = "77777777-7777-4777-8777-777777777777";
const SUPERVISOR = "88888888-8888-4888-8888-888888888888";

function makeEngine() {
  let n = 0;
  let ms = Date.parse("2026-10-17T09:00:00.000Z");
  const store = new MemoryLedgerStore();
  const engine = new LedgerEngine({
    store,
    stream: STREAM,
    events: POS_EVENTS,
    clock: () => new Date((ms += 1000)),
    newId: () => `evt-${++n}`,
  });
  return { engine, store };
}

async function seedCatalogue(engine: LedgerEngine) {
  await engine.execute({
    type: "product.registered",
    commandId: "reg-chilli",
    stream: STREAM,
    actor: "owner",
    payload: { productId: P_CHILLI, sku: "CHL-250", name: "Chilli Powder 250 g", categoryId: CAT, unitGrams: 250 },
  });
  await engine.execute({
    type: "product.registered",
    commandId: "reg-milk",
    stream: STREAM,
    actor: "owner",
    payload: { productId: P_MILK, sku: "MILK-GLASS", name: "Fresh Milk (glass bottle)", categoryId: CAT, unitGrams: null },
  });
  await engine.execute({
    type: "product.priced",
    commandId: "price-chilli",
    stream: STREAM,
    actor: "owner",
    payload: { productId: P_CHILLI, packSizeId: null, priceCents: 45_000, taxRateBp: 1800, reason: "opening price" },
  });
  await engine.execute({
    type: "product.priced",
    commandId: "price-milk",
    stream: STREAM,
    actor: "owner",
    payload: { productId: P_MILK, packSizeId: null, priceCents: 25_000, taxRateBp: 0, reason: "opening price" },
  });
  for (const [id, cmd] of [
    ["recv-chilli", { productId: P_CHILLI, packSizeId: null, qty: 20, unitCostCents: 30_000, batchNo: "C-01", expiresOn: "2027-03-01", supplierRef: null }],
    ["recv-milk", { productId: P_MILK, packSizeId: null, qty: 12, unitCostCents: 20_000, batchNo: "M-01", expiresOn: "2026-11-01", supplierRef: null }],
  ] as const) {
    await engine.execute({
      type: "stock.received",
      commandId: id,
      stream: STREAM,
      actor: "owner",
      payload: cmd as never,
    });
  }
}

const saleOf = (over: Record<string, unknown> = {}) => ({
  saleId: "99999999-9999-4999-8999-999999999999",
  receiptNo: 10001,
  deviceId: DEVICE,
  cashierId: CASHIER,
  shiftId: null,
  lines: [
    {
      lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      productId: P_CHILLI,
      packSizeId: null,
      qty: 2,
      unitPriceCents: 45_000,
      taxRateBp: 1800,
      kind: "item" as const,
    },
  ],
  discountCents: 0,
  tenderedCents: 90_000,
  method: "cash" as const,
  occurredAt: "2026-10-17T09:05:00.000Z",
  ...over,
});

describe("projection", () => {
  it("folds catalogue and stock from events", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    const state = await engine.state();

    expect(Object.keys(state.products)).toHaveLength(2);
    expect(onHand(state, P_CHILLI)).toBe(20);
    expect(onHand(state, P_MILK)).toBe(12);
    expect(state.products[P_CHILLI].prices[""]).toEqual({ priceCents: 45_000, taxRateBp: 1800 });
  });

  it("removes stock when a sale completes", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");

    const state = await engine.state();
    expect(onHand(state, P_CHILLI)).toBe(18);
    expect(state.receipts[10001]).toBe("99999999-9999-4999-8999-999999999999");
  });

  it("is deterministic: replaying the same events yields an identical digest", async () => {
    const { engine, store } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");

    const first = await engine.state();
    const events = await store.readStream(STREAM);
    const replay = events.reduce(reduce, emptyState());

    expect(stateDigest(replay)).toBe(stateDigest(first));
  });

  it("is order-stable when the fold is repeated from a snapshot", async () => {
    const { engine, store } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");

    const events = await store.readStream(STREAM);
    const cut = 4;
    const headState = events.slice(0, cut).reduce(reduce, emptyState());
    const tailState = events.slice(cut).reduce(reduce, headState);

    expect(stateDigest(tailState)).toBe(stateDigest(await engine.state()));
  });

  it("does not count the same command twice", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    const state = await engine.state();
    const event = (await engine.history())[0];

    // Feed the identical event back through the reducer.
    const again = reduce(state, event);
    expect(stateDigest(again)).toBe(stateDigest(state));
  });

  it("refuses to project an event it does not understand", () => {
    const bogus: LedgerEvent = {
      seq: 1,
      id: "x",
      type: "stock.teleported",
      version: 1,
      stream: STREAM,
      at: "2026-10-17T09:00:00.000Z",
      recordedAt: "2026-10-17T09:00:00.000Z",
      actor: "owner",
      commandId: "teleport-1",
      payload: {},
      prevHash: "",
      hash: "",
    };
    expect(() => reduce(emptyState(), bogus)).toThrow(/no handler/);
  });

  it("rejects a sale that would drive stock below zero", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await expect(
      engine.sell(saleOf({ saleId: "99999999-9999-4999-8999-999999999998", receiptNo: 10002, lines: [saleOf().lines[0], { ...saleOf().lines[0], lineId: "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2", qty: 500 }] }), "cashier"),
    ).rejects.toThrow(/only 20 on hand|has 20 on hand/);
  });

  it("rejects a duplicate receipt number", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    await expect(
      engine.sell(saleOf({ saleId: "99999999-9999-4999-8999-999999999997" }), "cashier"),
    ).rejects.toThrow(/receipt 10001 is already issued/);
  });

  it("rejects a duplicate SKU at registration", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await expect(
      engine.execute({
        type: "product.registered",
        commandId: "reg-dup",
        stream: STREAM,
        actor: "owner",
        payload: { productId: P_BISCUIT, sku: "CHL-250", name: "Copycat", categoryId: CAT, unitGrams: null },
      }),
    ).rejects.toThrow(/already in use/);
  });
});

describe("derived money", () => {
  it("computes tax inside a tax-inclusive price", () => {
    // LKR 1,000.00 at 18% inclusive contains 152.54 of tax.
    expect(taxInside(100_000, 1800)).toBe(15_254);
  });

  it("computes totals from active lines only", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    const sale = (await engine.state()).sales["99999999-9999-4999-8999-999999999999"];
    const t = saleTotals(sale);

    expect(t.subtotalCents).toBe(90_000);
    expect(t.totalCents).toBe(90_000);
    expect(t.taxIncludedCents).toBe(13_729); // 2 x (45000 - round(45000*10000/11800))
    expect(t.changeCents).toBe(0);
    expect(t.activeLineCount).toBe(1);
  });

  it("excludes voided quantity from the total", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    await engine.execute({
      type: "sale.line_voided",
      commandId: "void-1",
      stream: STREAM,
      actor: "cashier",
      payload: {
        saleId: "99999999-9999-4999-8999-999999999999",
        lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        qty: 1,
        reason: "double_scan",
        approvedByStaffId: SUPERVISOR,
      },
    });

    const state = await engine.state();
    const sale = state.sales["99999999-9999-4999-8999-999999999999"];
    expect(saleTotals(sale).totalCents).toBe(45_000);
    expect(onHand(state, P_CHILLI)).toBe(19); // one came back
  });

  it("applies a discount without going negative", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf({ discountCents: 500_000, tenderedCents: 90_000 }), "cashier");
    const sale = (await engine.state()).sales["99999999-9999-4999-8999-999999999999"];
    const t = saleTotals(sale);
    expect(t.discountCents).toBe(90_000); // clamped to the gross
    expect(t.totalCents).toBe(0);
  });
});

describe("voids and refunds", () => {
  it("returns voided stock and blocks over-voiding", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");

    const voidCmd = {
      type: "sale.line_voided",
      commandId: "void-1",
      stream: STREAM,
      actor: "cashier",
      payload: {
        saleId: "99999999-9999-4999-8999-999999999999",
        lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        qty: 2,
        reason: "wrong_item" as const,
        approvedByStaffId: SUPERVISOR,
      },
    };
    await engine.execute(voidCmd);
    expect(onHand(await engine.state(), P_CHILLI)).toBe(20);

    await expect(
      engine.execute({ ...voidCmd, commandId: "void-2", payload: { ...voidCmd.payload, qty: 1 } }),
    ).rejects.toThrow(/only 0 unit\(s\) remain active/);
  });

  it("requires an approving supervisor for a void", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    await expect(
      engine.execute({
        type: "sale.line_voided",
        commandId: "void-nosup",
        stream: STREAM,
        actor: "cashier",
        payload: {
          saleId: "99999999-9999-4999-8999-999999999999",
          lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          qty: 1,
          reason: "wrong_item",
          approvedByStaffId: "",
        },
      }),
    ).rejects.toThrow(/supervisor/);
  });

  it("restocks only when the refund says the goods are resellable", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");

    const refund = (restock: boolean, id: string) => ({
      type: "sale.refunded",
      commandId: id,
      stream: STREAM,
      actor: "supervisor",
      payload: {
        refundId: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        saleId: "99999999-9999-4999-8999-999999999999",
        lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        qty: 1,
        restock,
        reason: "damaged" as const,
        approvedByStaffId: SUPERVISOR,
      },
    });

    await engine.execute(refund(false, "refund-damaged"));
    expect(onHand(await engine.state(), P_CHILLI)).toBe(18); // damaged: not restocked

    await engine.execute(refund(true, "refund-resellable"));
    expect(onHand(await engine.state(), P_CHILLI)).toBe(19);
  });

  it("cannot refund more than remains unrefunded", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    await engine.execute({
      type: "sale.refunded",
      commandId: "refund-1",
      stream: STREAM,
      actor: "supervisor",
      payload: {
        refundId: "bbbbbbb1-bbbb-4bbb-8bbb-bbbbbbbbbbb1",
        saleId: "99999999-9999-4999-8999-999999999999",
        lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
        qty: 2,
        restock: true,
        reason: "customer_return",
        approvedByStaffId: SUPERVISOR,
      },
    });
    await expect(
      engine.execute({
        type: "sale.refunded",
        commandId: "refund-2",
        stream: STREAM,
        actor: "supervisor",
        payload: {
          refundId: "bbbbbbb2-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
          saleId: "99999999-9999-4999-8999-999999999999",
          lineId: "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
          qty: 1,
          restock: true,
          reason: "customer_return",
          approvedByStaffId: SUPERVISOR,
        },
      }),
    ).rejects.toThrow(/only 0 unit\(s\) are refundable/);
  });
});

describe("bottles", () => {
  it("tracks outstanding bottles and records returns", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(
      saleOf({
        lines: [
          {
            lineId: "ccccccc1-cccc-4ccc-8ccc-ccccccccccc1",
            productId: P_MILK,
            packSizeId: null,
            qty: 3,
            unitPriceCents: 25_000,
            taxRateBp: 0,
            kind: "item" as const,
          },
        ],
        tenderedCents: 75_000,
      }),
      "cashier",
    );

    let state = await engine.state();
    expect(state.bottles.outstanding).toBe(3);

    await engine.execute({
      type: "bottle.returned",
      commandId: "bottle-ret-1",
      stream: STREAM,
      actor: "cashier",
      payload: { productId: P_MILK, saleId: "99999999-9999-4999-8999-999999999999", qty: 2, feeUnitCents: 10_000 },
    });

    state = await engine.state();
    expect(state.bottles.outstanding).toBe(1);
    expect(state.bottles.emptyReturned).toBe(2);
  });

  it("records the fee at the value in force, not a shared constant", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.execute({
      type: "bottle.fee_charged",
      commandId: "fee-1",
      stream: STREAM,
      actor: "cashier",
      payload: {
        productId: P_MILK,
        saleId: "99999999-9999-4999-8999-999999999999",
        qty: 1,
        feeUnitCents: 10_000,
      },
    });
    const state = await engine.state();
    expect(state.bottles.feeChargedCents).toBe(10_000);
    expect(state.bottles.feeCount).toBe(1);
  });
});

describe("invariants", () => {
  it("all hold on a healthy ledger", async () => {
    const { engine } = makeEngine();
    await seedCatalogue(engine);
    await engine.sell(saleOf(), "cashier");
    const violations = checkInvariants(await engine.state());
    expect(errorsOnly(violations)).toEqual([]);
  });

  it("catches negative stock that the fold was told to accept", () => {
    const broken: PosState = { ...emptyState(), stock: { [`${P_CHILLI}|`]: -3 } };
    const v = errorsOnly(checkInvariants(broken));
    expect(v.map((x) => x.invariant)).toContain("stock.non-negative");
  });

  it("catches a stored on-hand column creeping back into state", () => {
    const withColumn = {
      ...emptyState(),
      products: {
        [P_CHILLI]: {
          productId: P_CHILLI,
          sku: "X",
          name: "X",
          categoryId: CAT,
          unitGrams: null,
          prices: {},
          stockOnHand: 99,
        },
      },
    } as unknown as PosState;
    const v = errorsOnly(checkInvariants(withColumn));
    expect(v.map((x) => x.invariant)).toContain("state.no-stored-quantity");
  });

  it("catches a receipt number used twice", () => {
    const base = emptyState();
    const state: PosState = {
      ...base,
      sales: {
        a: { ...fakeSale("a", 1) },
        b: { ...fakeSale("b", 1) },
      },
    };
    const v = errorsOnly(checkInvariants(state));
    expect(v.some((x) => x.invariant === "sale.receipt-unique")).toBe(true);
  });

  it("formats a readable report", () => {
    const text = formatViolations([
      { invariant: "stock.non-negative", severity: "error", message: "x is -1", atSeq: 7 },
    ]);
    expect(text).toContain("stock.non-negative");
    expect(text).toContain("seq 7");
  });

  it("does not throw when an invariant itself throws", () => {
    const v = checkInvariants({}, [
      {
        id: "boom",
        description: "throws",
        severity: "error",
        check() {
          throw new Error("bad predicate");
        },
      },
    ]);
    expect(v[0].message).toMatch(/threw instead/);
  });

  it("the suite is non-empty so a green run means something", () => {
    expect(POS_INVARIANTS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(POS_INVARIANTS.map((i) => i.id)).size).toBe(POS_INVARIANTS.length);
  });
});

function fakeSale(id: string, receiptNo: number) {
  return {
    saleId: id,
    receiptNo,
    deviceId: DEVICE,
    cashierId: CASHIER,
    shiftId: null,
    lines: {},
    lineOrder: [],
    discountCents: 0,
    tenderedCents: 0,
    method: "cash" as const,
    occurredAt: "2026-10-17T09:00:00.000Z",
    recordedAt: "2026-10-17T09:00:00.000Z",
    seq: 1,
  };
}
