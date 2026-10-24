import { describe, expect, it } from "vitest";
import { generatePassword } from "../lib/platform";

/**
 * The temporary passwords handed to shopkeepers are typed by hand, often read over the phone, so the
 * generator has two jobs: be unguessable, and be transcribable. These tests pin both, because a
 * regression here is silent - the password still looks like a password.
 */
describe("generated handover passwords", () => {
  it("is long enough to be unguessable by default", () => {
    expect(generatePassword().length).toBe(20);
  });

  it("avoids characters that are misread when dictated", () => {
    // 0/O and 1/l/I are the characters people get wrong on a slip of paper.
    const sample = Array.from({ length: 200 }, () => generatePassword()).join("");
    expect(sample).not.toMatch(/[0O1lI]/);
  });

  it("has no symbols, so it survives a phone keypad", () => {
    const sample = Array.from({ length: 200 }, () => generatePassword()).join("");
    expect(sample).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("always contains upper, lower and a digit", () => {
    // Repeated calls, because the guarantee is enforced by regenerating.
    for (let i = 0; i < 200; i += 1) {
      const p = generatePassword();
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[0-9]/);
    }
  });

  it("does not repeat itself", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generatePassword()));
    expect(seen.size).toBe(500);
  });

  it("honours a requested length", () => {
    expect(generatePassword(12)).toHaveLength(12);
  });
});
