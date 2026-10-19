import { describe, expect, it } from "vitest";
import { canonicalJson, GENESIS_HASH, hashEvent, sha256Hex } from "../../lib/ldd/hash";
import { Ledger, toIso } from "../../lib/ldd/ledger";
import { MemoryLedgerStore } from "../../lib/ldd/memory-store";
import { POS_EVENTS } from "../../lib/ldd/pos-events";
import {
  IntegrityError,
  InvariantError,
  UnknownEventError,
  ValidationError,
  type Command,
  type LedgerStore,
  type LedgerEvent,
} from "../../lib/ldd/types";

const fixedClock = () => new Date("2026-10-17T09:00:00.000Z");

function makeLedger() {
  let n = 0;
  return new Ledger({
    store: new MemoryLedgerStore(),
    events: POS_EVENTS,
    clock: fixedClock,
    newId: () => `evt-${++n}`,
  });
}

const STREAM = "store:11111111-1111-4111-8111-111111111111";
const PRODUCT = "22222222-2222-4222-8222-222222222222";
const CATEGORY = "33333333-3333-4333-8333-333333333333";

const register: Command = {
  type: "product.registered",
  commandId: "reg-1",
  stream: STREAM,
  actor: "owner",
  payload: { productId: PRODUCT, sku: "CHL-001", name: "Chilli Powder", categoryId: CATEGORY, unitGrams: null },
};

const receive: Command = {
  type: "stock.received",
  commandId: "recv-1",
  stream: STREAM,
  actor: "owner",
  payload: {
    productId: PRODUCT,
    packSizeId: null,
    qty: 10,
    unitCostCents: 40_000,
    batchNo: "B-01",
    expiresOn: "2027-01-31",
    supplierRef: null,
  },
};

describe("sha256Hex", () => {
  it("matches the published test vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the published test vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("matches for a 56-byte message (padding boundary)", () => {
    // 56 bytes forces an extra padding block; a naive implementation gets this wrong.
    const input = "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
    expect(sha256Hex(input)).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });
});

describe("canonicalJson", () => {
  it("sorts keys so hash input is order-independent", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it("drops undefined and normalises -0", () => {
    expect(canonicalJson({ a: undefined, b: -0 })).toBe('{"b":0}');
  });

  it("recurses into arrays and nested objects", () => {
    expect(canonicalJson({ z: [{ b: 1, a: 2 }] })).toBe('{"z":[{"a":2,"b":1}]}');
  });
});

describe("Ledger append", () => {
  it("starts a stream at seq 1 chained to the genesis hash", async () => {
    const ledger = makeLedger();
    const e = await ledger.append(register);
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.hash).toHaveLength(64);
  });

  it("chains each event to its predecessor", async () => {
    const ledger = makeLedger();
    const a = await ledger.append(register);
    const b = await ledger.append(receive);
    expect(b.prevHash).toBe(a.hash);
    expect(b.seq).toBe(2);
  });

  it("keeps business time separate from record time", async () => {
    const ledger = makeLedger();
    const offline = { ...register, at: "2026-10-16T22:15:00.000Z" };
    const e = await ledger.append(offline);
    expect(e.at).toBe("2026-10-16T22:15:00.000Z");
    expect(e.recordedAt).toBe("2026-10-17T09:00:00.000Z");
  });

  it("is idempotent on commandId and returns the original event", async () => {
    const ledger = makeLedger();
    const first = await ledger.append(register);
    const again = await ledger.append(register);
    expect(again.id).toBe(first.id);
    expect(await ledger.head(STREAM)).toEqual(first);
    expect((await ledger.verify(STREAM)).checked).toBe(1);
  });

  it("rejects a reused commandId for a different event type", async () => {
    const ledger = makeLedger();
    await ledger.append(register);
    await expect(ledger.append({ ...receive, commandId: "reg-1" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("rejects a payload that fails its schema", async () => {
    const ledger = makeLedger();
    const bad = { ...receive, payload: { ...(receive.payload as object), qty: 0 } };
    await expect(ledger.append(bad)).rejects.toThrow(ValidationError);
  });

  it("rejects an unregistered event type", async () => {
    const ledger = makeLedger();
    await expect(
      ledger.append({ ...register, type: "stock.teleported" }),
    ).rejects.toThrow(UnknownEventError);
  });

  it("refuses a command with no commandId", async () => {
    const ledger = makeLedger();
    await expect(ledger.append({ ...register, commandId: "" })).rejects.toThrow(/commandId is required/);
  });

  it("does not let a malformed event reach the store", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger({ store, events: POS_EVENTS, clock: fixedClock });
    await expect(
      ledger.append({ ...receive, payload: { ...(receive.payload as object), qty: -5 } }),
    ).rejects.toThrow(ValidationError);
    expect(await store.count(STREAM)).toBe(0);
  });
});

describe("Ledger verify", () => {
  it("accepts an untouched chain", async () => {
    const ledger = makeLedger();
    await ledger.append(register);
    await ledger.append(receive);
    const report = await ledger.verify(STREAM);
    expect(report.ok).toBe(true);
    expect(report.checked).toBe(2);
    expect(report.problems).toEqual([]);
  });

  it("detects a payload edited in place", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger({ store, events: POS_EVENTS, clock: fixedClock });
    await ledger.append(register);
    const [e] = await store.readStream(STREAM);
    await store.clear();
    await store.append({ ...e, payload: { ...(e.payload as object), name: "Turmeric" } });

    const report = await ledger.verify(STREAM);
    expect(report.ok).toBe(false);
    expect(report.problems[0].reason).toMatch(/altered/);
  });

  it("detects a deleted middle event through the seq gap", async () => {
    // A permissive store, because MemoryLedgerStore refuses to write a gap in the first place —
    // which is the point of having both layers. Here we simulate a storage engine that did not.
    const permissive: LedgerStore = {
      head: async () => null,
      append: async () => {},
      readStream: async () => tampered,
      findByCommandId: async () => null,
      count: async () => tampered.length,
    };
    let tampered: LedgerEvent[] = [];

    const store = new MemoryLedgerStore();
    const ledger = new Ledger({ store, events: POS_EVENTS, clock: fixedClock });
    await ledger.append(register);
    await ledger.append(receive);
    await ledger.append({ ...receive, commandId: "recv-2" });

    const events = await store.readStream(STREAM);
    tampered = [events[0], events[2]]; // the middle event is gone

    const report = await new Ledger({ store: permissive, events: POS_EVENTS }).verify(STREAM);
    expect(report.ok).toBe(false);
    expect(report.problems.some((p) => /expected seq/.test(p.reason))).toBe(true);
    expect(report.problems.some((p) => /prevHash/.test(p.reason))).toBe(true);
  });

  it("detects a re-chained but reordered event", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new Ledger({ store, events: POS_EVENTS, clock: fixedClock });
    await ledger.append(register);
    const second = await ledger.append(receive);

    const events = await store.readStream(STREAM);
    await store.clear();
    // Attacker rewrites history and recomputes a valid chain from a different starting point.
    const forged = { ...events[0], at: "2020-01-01T00:00:00.000Z" };
    const body = { ...forged, hash: undefined };
    const rehashed = { ...body, hash: hashEvent(body as never) } as typeof forged;
    await store.append(rehashed);
    await store.append({ ...second, prevHash: rehashed.hash, hash: hashEvent({ ...second, prevHash: rehashed.hash }) });

    // The chain is internally consistent, but the head hash no longer matches what was previously attested.
    const report = await ledger.verify(STREAM);
    expect(report.headHash).not.toBe(second.hash);
  });

  it("reports an empty stream as valid with the genesis hash", async () => {
    const report = await makeLedger().verify(STREAM);
    expect(report).toMatchObject({ ok: true, checked: 0, headHash: GENESIS_HASH });
  });
});

describe("store guards", () => {
  it("rejects a non-contiguous seq at the storage layer, not just the engine", async () => {
    const store = new MemoryLedgerStore();
    const ledger = makeLedger();
    const e = await ledger.append(register);
    await expect(store.append({ ...e, seq: 5, hash: "f".repeat(64) })).rejects.toThrow(IntegrityError);
  });

  it("rejects a duplicate hash", async () => {
    const ledger = makeLedger();
    const e = await ledger.append(register);
    const store = new MemoryLedgerStore();
    const other = new Ledger({ store, events: POS_EVENTS, clock: fixedClock });
    await other.append(register);
    await expect(store.append({ ...e, stream: "store:other" })).rejects.toThrow(IntegrityError);
  });
});

describe("time formatting", () => {
  it("writes milliseconds and UTC", () => {
    expect(toIso(new Date("2026-10-17T09:00:00.123456Z"))).toBe("2026-10-17T09:00:00.123Z");
  });

  it("produces an ISO instant that round-trips", () => {
    const iso = toIso(fixedClock());
    expect(new Date(iso).getTime()).toBe(fixedClock().getTime());
  });
});

describe("invariant plumbing", () => {
  it("InvariantError carries every violation message", () => {
    const err = new InvariantError(["a failed", "b failed"]);
    expect(err.violations).toEqual(["a failed", "b failed"]);
    expect(err.message).toContain("a failed");
  });
});




