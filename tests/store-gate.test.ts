import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists to localStorage; this test runs in node, so give it one before importing.
const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
});

const { usePos } = await import("../lib/store");

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
    usePos.setState({ lines: [{ id: "l1", productId: "p1", name: "Chilli", qty: 1, unitPrice: 10000 } as never] });
    usePos.getState().login(staff);
    expect(usePos.getState().gating).toBe(false);
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
