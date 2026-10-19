import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists to localStorage; this test runs in node, so give it one before importing.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { dropSavedGating, shouldOpenGate, usePos } = await import("../lib/store");

const staff = { id: "u1", name: "Nimal", role: "cashier" as const, code: "1234" };

describe("asking who the sale is for", () => {
  beforeEach(() => {
    mem.clear();
    usePos.setState({ session: null, lines: [], gating: false, customerId: undefined, customerName: undefined });
  });

  it("asks when a cashier starts a fresh till", () => {
    usePos.getState().login(staff);
    expect(usePos.getState().gating).toBe(true);
  });

  it("does not ask again after the customer is chosen", () => {
    usePos.getState().login(staff);
    usePos.getState().attachCustomer({ id: "c1", name: "Sandya" });
    usePos.getState().setGating(false);
    expect(usePos.getState().gating).toBe(false);
  });

  it("asks for the next sale once the bill is cleared", () => {
    usePos.getState().login(staff);
    usePos.getState().setGating(false);
    usePos.getState().clearBill();
    expect(usePos.getState().gating).toBe(true);
  });

  it("forgets the customer when the bill is cleared, so points cannot leak to the last one", () => {
    usePos.getState().login(staff);
    usePos.getState().attachCustomer({ id: "c1", name: "Sandya" });
    usePos.getState().clearBill();
    expect(usePos.getState().customerId).toBeUndefined();
    expect(usePos.getState().customerName).toBeUndefined();
  });

  it("does not ask a cashier who signs in to a bill already in progress", () => {
    // gating itself stays true; the bill is what suppresses the gate.
    usePos.setState({ lines: [{ id: "l1", productId: "p1", name: "Chilli", qty: 1, unitPrice: 10000 } as never] });
    usePos.getState().login(staff);
    const open = shouldOpenGate({ ...usePos.getState(), hydrated: true });
    expect(open).toBe(false);
  });

  it("keeps the customer attached to a held bill when it is recalled", () => {
    usePos.getState().login(staff);
    usePos.getState().attachCustomer({ id: "c9", name: "Kasun" });
    const held = { ...usePos.getState().snapshot(), id: "h1", createdAt: 0, cashierName: "Nimal" };
    usePos.getState().clearBill();
    usePos.getState().loadBill(held);
    expect(usePos.getState().customerId).toBe("c9");
    expect(usePos.getState().customerName).toBe("Kasun");
  });
});

describe("the gate after a reload", () => {
  beforeEach(() => {
    mem.clear();
    usePos.setState({ session: null, lines: [], gating: true, customerId: undefined, customerName: undefined });
  });
  it("drops a gate dismissal saved by an older build", () => {
    // This is the exact shape that was already on the user's till: gating:false persisted.
    const saved = { session: staff, lines: [], customerId: "c1", customerName: "Sandya", gating: false };
    const migrated = dropSavedGating(saved);
    expect(migrated).not.toBeNull();
    expect(migrated).not.toHaveProperty("gating");
    // everything else the till needs must survive the migration
    expect(migrated!.customerId).toBe("c1");
    expect(migrated!.session).toEqual(staff);
  });
  it("treats junk in storage as empty rather than crashing the till", () => {
    expect(dropSavedGating(null)).toBeNull();
    expect(dropSavedGating("nonsense")).toBeNull();
  });
  it("asks again after a sale clears the bill", () => {
    usePos.getState().login(staff);
    usePos.getState().setGating(false);
    usePos.getState().clearBill();
    expect(usePos.getState().gating).toBe(true);
  });
});

describe("the rule that decides when to ask", () => {
  const base = {
    gating: true,
    session: staff,
    locked: false,
    approval: null,
    dialog: null,
    lines: [] as unknown[],
    customerId: undefined as string | undefined,
    hydrated: true,
  };
  it("asks on an empty bill at a signed-in till", () => {
    expect(shouldOpenGate(base)).toBe(true);
  });
  it("does not ask over a bill that already has items", () => {
    expect(shouldOpenGate({ ...base, lines: [1] })).toBe(false);
  });
  it("does not ask once a customer is chosen", () => {
    expect(shouldOpenGate({ ...base, customerId: "c1" })).toBe(false);
  });
  it("does not ask behind another dialog, an approval or the lock screen", () => {
    expect(shouldOpenGate({ ...base, dialog: { type: "pay" } })).toBe(false);
    expect(shouldOpenGate({ ...base, approval: { description: "x" } })).toBe(false);
    expect(shouldOpenGate({ ...base, locked: true })).toBe(false);
  });
  it("does not ask before hydration, or when nobody is signed in", () => {
    expect(shouldOpenGate({ ...base, hydrated: false })).toBe(false);
    expect(shouldOpenGate({ ...base, session: null })).toBe(false);
  });
});
