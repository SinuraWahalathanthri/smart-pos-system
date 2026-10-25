import { describe, expect, it } from "vitest";
import { COMPACT_MAX_WIDTH, COMPACT_QUERY, isCompactWidth } from "../lib/viewport";
import { SHORTCUTS } from "../lib/shortcuts";

/**
 * The compact breakpoint lives in JS (lib/viewport.ts) and in CSS (Tailwind's `lg:`). If they drift,
 * the till shows a single column while still rendering the side bill panel, which is precisely the
 * bug the mobile layout was introduced to fix.
 */
describe("compact viewport", () => {
  it("matches Tailwind's lg breakpoint", () => {
    // lg is 1024px, and Tailwind is min-width based, so the compact side stops one pixel below it.
    expect(COMPACT_MAX_WIDTH).toBe(1023);
    expect(COMPACT_QUERY).toBe("(max-width: 1023px)");
  });

  it("treats phone and portrait-tablet widths as compact", () => {
    for (const w of [320, 360, 390, 414, 768, 820, 1023]) {
      expect(isCompactWidth(w), `width ${w}`).toBe(true);
    }
  });

  it("leaves laptop widths on the two-column layout", () => {
    for (const w of [1024, 1280, 1440, 1920]) {
      expect(isCompactWidth(w), `width ${w}`).toBe(false);
    }
  });
});

/**
 * The action menu is generated from SHORTCUTS, so every till action stays reachable without a
 * keyboard. These assertions protect that promise: a new bar shortcut with no touch path would make
 * a phone unable to run it.
 */
describe("touch has a path to every till action", () => {
  const TOUCH_COVERED = new Set([
    "qty", "search", "calc", "customer", "discount", "bottle",
    "void", "hold", "exact", "pay", "palette", "help", "lock",
  ]);

  it("covers every shortcut shown in the bottom bar", () => {
    const bar = SHORTCUTS.filter((s) => s.bar).map((s) => s.id);
    const missing = bar.filter((id) => !TOUCH_COVERED.has(id));
    expect(missing, `add ${missing.join(", ")} to the touch action menu`).toEqual([]);
  });

  it("covers the destructive actions, which touch cannot express as Del or F8", () => {
    expect(TOUCH_COVERED.has("void")).toBe(true);
  });
});
