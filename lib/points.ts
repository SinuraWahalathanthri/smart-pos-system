import type { Cents } from "./money";

/**
 * Loyalty points: LKR 100 spent earns 1 point.
 *
 * Money is in cents, so one point is 10,000 cents. The remainder is not banked - a LKR 250 receipt
 * earns 2 points, not 2.5. Kept in one place because the till shows the number and the database
 * awards it, and the two must agree.
 */
export const CENTS_PER_POINT = 10_000;

export function pointsFor(total: Cents): number {
  return Math.max(0, Math.floor(Math.max(0, total) / CENTS_PER_POINT));
}
