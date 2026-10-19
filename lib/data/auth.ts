import type { Staff } from "../types";

/**
 * Local (demo / offline) credential checks. SHA-256 with a per-user salt.
 * Online, supervisor approval is re-verified server-side by verify_supervisor() (supabase/migrations).
 */

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const hashSecret = (salt: string, secret: string) => sha256Hex(`${salt}:${secret}`);

export const verifyPin = async (staff: Staff, pin: string) => (await hashSecret(staff.salt, pin)) === staff.pinHash;

export async function matchesBadge(staff: Staff, badge: string): Promise<boolean> {
  return !!staff.badgeHash && (await hashSecret(staff.salt, badge.trim())) === staff.badgeHash;
}

/* --- lockout: 3 wrong PINs lock approvals for 5 minutes (PLAN.md §3) --- */

const LOCK_KEY = "pos-lockouts";
const MAX_TRIES = 3;
const LOCK_MS = 5 * 60 * 1000;

type Lockouts = Record<string, { fails: number; until: number }>;

function read(): Lockouts {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) ?? "{}") as Lockouts;
  } catch {
    return {};
  }
}

function write(l: Lockouts) {
  try {
    localStorage.setItem(LOCK_KEY, JSON.stringify(l));
  } catch {
    /* storage blocked: lockout then only lasts for this page */
  }
}

/** Seconds left on a lockout, or 0. */
export function lockedSeconds(staffId: string, now = Date.now()): number {
  const e = read()[staffId];
  return e && e.until > now ? Math.ceil((e.until - now) / 1000) : 0;
}

/** Record a failed PIN; returns tries left (0 means now locked). */
export function recordFailure(staffId: string, now = Date.now()): number {
  const all = read();
  const e = all[staffId] ?? { fails: 0, until: 0 };
  const fails = e.until > 0 && e.until <= now ? 1 : e.fails + 1;
  if (fails >= MAX_TRIES) {
    all[staffId] = { fails: 0, until: now + LOCK_MS };
    write(all);
    return 0;
  }
  all[staffId] = { fails, until: 0 };
  write(all);
  return MAX_TRIES - fails;
}

export function clearFailures(staffId: string) {
  const all = read();
  delete all[staffId];
  write(all);
}
