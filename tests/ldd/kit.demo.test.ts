/**
 * The LDD kit, demonstrated end to end and asserted at every step.
 *
 * This is a test rather than a script on purpose: it runs under the project's own test runner, so
 * the demo and the guarantee are the same artefact. `npm run ldd` prints the report below; CI fails
 * if any assertion breaks.
 */

import { describe, expect, it } from "vitest";
import { LedgerEngine } from "../../lib/ldd/engine";
import { MemoryLedgerStore } from "../../lib/ldd/memory-store";
import { POS_EVENTS } from "../../lib/ldd/pos-events";
import { emptyState, onHand, reduce, saleTotals } from "../../lib/ldd/pos-reducer";
import { checkInvariants, errorsOnly, POS_INVARIANTS } from "../../lib/ldd/invariants";
import { stateDigest } from "../../lib/ldd/ledger";
import { asOf, explainKey, timeline } from "../../lib/ldd/explain";

const STREAM = "store:11111111-1111-4111-8111-111111111111";
const CHILLI = "22222222-2222-4222-8222-222222222222";
const MILK = "44444444-4444-4444-8444-444444444444";
const BISCUIT = "55555555-5555-4555-8555-555555555555";
const CAT = "33333333-3333-4333-8333-333333333333";
const DEVICE = "66666666-6666-4666-8666-666666666666";
const CASHIER = "77777777-7777-4777-8777-777777777777";
const SUPERVISOR = "88888888-8888-4888-8888-888888888888";

const money = (c: number) => `LKR ${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

function build() {
  let n = 0;
  let ms = Date.parse("2026-10-17T08:00:00.000Z");
  return new LedgerEngine({
    store: new MemoryLedgerStore(),
    stream: STREAM,
    events: POS_EVENTS,
    clock: () => new Date((ms += 60_000)),
    newId: () => `evt-${++n}`,
  });
}

const SALE_ID = "99999999-9999-4999-8999-999999999999";
const LINE_CHILLI = "aaaaaaa1-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const LINE_BISCUIT = "aaaaaaa2-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const LINE_MILK = "aaaaaaa3-aaaa-4aaa-8aaa-aaaaaaaaaaa3";
const LINE_FEE = "aaaaaaa4-aaaa-4aaa-8aaa-aaaaaaaaaaa4";
const FEE_UNIT = 10_000;

async function scenario() {
  const engine = build();
  const out: string[] = [];
  const say = (s: string) => out.push(s);

  say("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  say("LDD KIT - Ledger-Driven Development, end to end");
  say("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

  /* 1. catalogue */
  say("\n1. Catalogue (events, not rows)");
  for (const p of [
    { productId: CHILLI, sku: "CHL-250", name: "Chilli Powder 250 g", categoryId: CAT, unitGrams: 250 },
    { productId: MILK, sku: "MILK-GLASS", name: "Fresh Milk (glass bottle)", categoryId: CAT, unitGrams: null },
    { productId: BISCUIT, sku: "MARIE-200", name: "Marie Biscuit 200 g", categoryId: CAT, unitGrams: null },
  ]) {
    await engine.execute({ type: "product.registered", commandId: `reg:${p.sku}`, stream: STREAM, actor: "owner", payload: p });
  }
  for (const [productId, priceCents, taxRateBp, sku] of [
    [CHILLI, 45_000, 1800, "CHL-250"],
    [MILK, 25_000, 0, "MILK-GLASS"],
    [BISCUIT, 12_000, 1800, "MARIE-200"],
  ] as const) {
    await engine.execute({
      type: "product.priced",
      commandId: `price:${sku}`,
      stream: STREAM,
      actor: "owner",
      payload: { productId, packSizeId: null, priceCents, taxRateBp, reason: "opening price" },
    });
  }

  /* 2. goods in */
  say("\n2. Goods received (stock is never assigned, only earned)");
  for (const r of [
    { productId: CHILLI, qty: 20, cost: 30_000, batchNo: "CHL-2026-10", expiresOn: "2027-04-30" },
    { productId: MILK, qty: 12, cost: 20_000, batchNo: "MILK-2026-10-17", expiresOn: "2026-11-02" },
    { productId: BISCUIT, qty: 40, cost: 8_000, batchNo: "MAR-2026-09", expiresOn: "2027-09-30" },
  ]) {
    await engine.execute({
      type: "stock.received",
      commandId: `recv:${r.batchNo}`,
      stream: STREAM,
      actor: "owner",
      payload: {
        productId: r.productId,
        packSizeId: null,
        qty: r.qty,
        unitCostCents: r.cost,
        batchNo: r.batchNo,
        expiresOn: r.expiresOn,
        supplierRef: "PO-1041",
      },
    });
    say(`   +${String(r.qty).padStart(2)} ${r.batchNo.padEnd(18)} expires ${r.expiresOn}`);
  }

  /* 3. a sale */
  say("\n3. A sale, with the bottle-fee rule as a real line");
  const goods = 2 * 45_000 + 3 * 12_000 + 2 * 25_000;
  await engine.execute({
    type: "sale.completed",
    commandId: "sale:10001",
    stream: STREAM,
    actor: "cashier",
    payload: {
      saleId: SALE_ID,
      receiptNo: 10001,
      deviceId: DEVICE,
      cashierId: CASHIER,
      shiftId: null,
      lines: [
        { lineId: LINE_CHILLI, productId: CHILLI, packSizeId: null, qty: 2, unitPriceCents: 45_000, taxRateBp: 1800, kind: "item" },
        { lineId: LINE_BISCUIT, productId: BISCUIT, packSizeId: null, qty: 3, unitPriceCents: 12_000, taxRateBp: 1800, kind: "item" },
        { lineId: LINE_MILK, productId: MILK, packSizeId: null, qty: 2, unitPriceCents: 25_000, taxRateBp: 0, kind: "item" },
        { lineId: LINE_FEE, productId: MILK, packSizeId: null, qty: 1, unitPriceCents: FEE_UNIT, taxRateBp: 0, kind: "bottle_fee" },
      ],
      discountCents: 0,
      tenderedCents: goods + FEE_UNIT,
      method: "cash",
      occurredAt: "2026-10-17T09:30:00.000Z",
    },
  });

  let state = await engine.state();
  const totals = saleTotals(state.sales[SALE_ID]);
  say(`   receipt #10001  goods ${money(totals.subtotalCents)}  bottle fee ${money(totals.bottleFeeCents)}`);
  say(`   total ${money(totals.totalCents)}  VAT inside ${money(totals.taxIncludedCents)}  change ${money(totals.changeCents)}`);
  say(`   stock: chilli ${onHand(state, CHILLI)}  biscuits ${onHand(state, BISCUIT)}  milk ${onHand(state, MILK)}`);
  say(`   bottles outstanding: ${state.bottles.outstanding}`);

  /* 4. void */
  say("\n4. A supervisor voids one chilli line (double scan)");
  await engine.execute({
    type: "sale.line_voided",
    commandId: "void:10001:1",
    stream: STREAM,
    actor: "cashier",
    payload: { saleId: SALE_ID, lineId: LINE_CHILLI, qty: 1, reason: "double_scan", approvedByStaffId: SUPERVISOR },
  });
  state = await engine.state();
  const afterVoid = saleTotals(state.sales[SALE_ID]);
  say(`   total after void ${money(afterVoid.totalCents)} (was ${money(totals.totalCents)})`);
  say(`   chilli back to ${onHand(state, CHILLI)} - the void returned the unit to stock`);

  /* 5. refusal */
  say("\n5. A command that must be refused");
  const beforeRefusal = stateDigest(await engine.state());
  let refusal = "";
  try {
    await engine.execute({
      type: "sale.completed",
      commandId: "sale:dupe",
      stream: STREAM,
      actor: "cashier",
      payload: {
        saleId: "99999999-9999-4999-8999-999999999998",
        receiptNo: 10001,
        deviceId: DEVICE,
        cashierId: CASHIER,
        shiftId: null,
        lines: [{ lineId: "ddddddd1-dddd-4ddd-8ddd-ddddddddddd1", productId: BISCUIT, packSizeId: null, qty: 1, unitPriceCents: 12_000, taxRateBp: 1800, kind: "item" }],
        discountCents: 0,
        tenderedCents: 12_000,
        method: "cash",
        occurredAt: "2026-10-17T10:00:00.000Z",
      },
    });
  } catch (e) {
    // The InvariantError message is multi-line: a header plus one bullet per failed statement.
    refusal = (e as Error).message;
  }
  const afterRefusal = stateDigest(await engine.state());
  say(`   refused: ${refusal.split("\n").map((s) => s.trim()).filter(Boolean).join(" | ")}`);
  say(`   state unchanged: ${beforeRefusal === afterRefusal ? "yes" : "NO - BUG"}`);

  /* 6. time travel */
  const events = await engine.history();
  const saleSeq = events.find((e) => e.type === "sale.completed")!.seq;
  const past = asOf(emptyState(), events, saleSeq - 1);
  say("\n6. Time travel: the state as it stood before the sale");
  say(`   at seq ${saleSeq - 1}: chilli ${onHand(past, CHILLI)} (the sale is not applied yet)`);

  /* 7. explain */
  say("\n7. Explain: why is chilli stock what it is?");
  for (const row of explainKey(events, `stock:${CHILLI}|`)) {
    say(`   seq ${String(row.seq).padStart(2)}  ${row.at}  ${row.summary}`);
  }

  /* 8. integrity */
  const report = await engine.verify();
  say("\n8. Integrity");
  say(`   events checked: ${report.checked}`);
  say(`   hash chain:     ${report.ok ? "intact" : "BROKEN"}`);
  say(`   head hash:      ${report.headHash.slice(0, 24)}â€¦`);

  /* 9. invariants */
  const violations = checkInvariants(await engine.state());
  const errors = errorsOnly(violations);
  say("\n9. Invariants (S1) against the final state");
  say(
    `   ${POS_INVARIANTS.length} invariants evaluated - ${errors.length} error(s), ` +
      `${violations.length - errors.length} warning(s)`,
  );
  for (const v of violations) say(`   [${v.severity}] ${v.invariant}: ${v.message}`);

  /* 10. determinism */
  const once = await engine.state();
  const twice = events.reduce(reduce, emptyState());
  say("\n10. Determinism: fold the same events twice, compare digests");
  say(`   digest A ${stateDigest(once).slice(0, 24)}â€¦`);
  say(`   digest B ${stateDigest(twice).slice(0, 24)}â€¦`);
  say(`   identical: ${stateDigest(once) === stateDigest(twice) ? "yes" : "NO - BUG"}`);

  say("\nTimeline");
  say("â”€".repeat(72));
  for (const row of timeline(events)) {
    say(`  ${String(row.seq).padStart(3)}  ${row.at}  ${row.type.padEnd(20)} ${row.summary}`);
  }
  say("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

  return { engine, report, out, state: once, events, refusal, beforeRefusal, afterRefusal, totals: afterVoid };
}

describe("LDD kit - end-to-end demonstration", () => {
  it("runs the scenario and every guarantee holds", async () => {
    const r = await scenario();

    // The printed report is the deliverable; the assertions are the contract behind it.
    console.log("\n" + r.out.join("\n") + "\n");

    expect(r.report.ok).toBe(true);
    expect(r.refusal).toMatch(/receipt 10001 is already issued/);
    expect(r.beforeRefusal).toBe(r.afterRefusal);
    expect(r.report.checked).toBe(11); // 3 registered + 3 priced + 3 received + 1 sale + 1 void
    expect(errorsOnly(checkInvariants(r.state))).toEqual([]);

    // Quantities reconcile against the events, not against a stored column.
    expect(onHand(r.state, CHILLI)).toBe(19); // 20 received, 2 sold, 1 voided back
    expect(onHand(r.state, BISCUIT)).toBe(37); // 40 received, 3 sold
    expect(onHand(r.state, MILK)).toBe(10); // 12 received, 2 sold; fee line moves no stock

    // Money reconciles from the lines after the void: 1x45000 + 3x12000 + 2x25000 = 131000, plus a 10000 fee.
    expect(r.totals.subtotalCents).toBe(131_000);
    expect(r.totals.bottleFeeCents).toBe(10_000);
    expect(r.totals.totalCents).toBe(141_000);
    // The customer tendered for the pre-void bill, so the void leaves exact change owed.
    expect(r.totals.changeCents).toBe(45_000);
  });
});

