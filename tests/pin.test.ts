import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isValidPin, sanitisePin } from "../lib/pin";

/**
 * The staff PIN rule exists twice by necessity: once in `set_staff_pin` (the authority) and once in
 * the form, so the operator gets an error before a round trip. If they drift, the form either accepts
 * PINs the server refuses (confusing, looks like a bug) or rejects PINs the server would take.
 *
 * These tests pin the client rule and assert it still matches the SQL.
 */
describe("till PIN validation", () => {
  it("accepts 4 to 8 digits", () => {
    expect(isValidPin("1234")).toBe(true);
    expect(isValidPin("12345678")).toBe(true);
  });

  it("rejects anything shorter, longer, or non-numeric", () => {
    for (const bad of ["", "123", "123456789", "12a4", "12 34", "１２３４", "-1234", "1234 "]) {
      expect(isValidPin(bad), bad).toBe(false);
    }
  });

  it("strips what a keypad cannot have and caps the length", () => {
    expect(sanitisePin("1a2b3c4")).toBe("1234");
    expect(sanitisePin("123456789012")).toBe("12345678");
    expect(sanitisePin(" 12 34 ")).toBe("1234");
    expect(sanitisePin("")).toBe("");
  });

  it("still matches the pattern the database enforces", () => {
    const sql = readFileSync(join(__dirname, "..", "supabase", "migrations", "0008_staff_products_rpc.sql"), "utf8");
    const check = sql.match(/p_pin !~ '([^']+)'/);

    expect(check, "set_staff_pin no longer validates the PIN; update lib/pin.ts with it").not.toBeNull();
    const dbPattern = new RegExp(check![1]);

    // Every PIN the UI accepts must satisfy the database, and vice versa.
    const samples = ["123", "1234", "12345678", "123456789", "12a4", "0000", "99999999"];
    for (const sample of samples) {
      expect(dbPattern.test(sample), sample).toBe(isValidPin(sample));
    }
  });
});
