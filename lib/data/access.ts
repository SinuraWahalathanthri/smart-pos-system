import { asSbClient, getSupabase, isConnected, isNetworkError, type SbError } from "../supabase/client";
import type { SessionUser } from "../store";
import type { Staff } from "../types";
import { clearFailures, hashSecret, lockedSeconds, matchesBadge, recordFailure, verifyPin } from "./auth";
import { getDb } from "./db";

/**
 * Staff sign-in and supervisor approval.
 *
 * Online, the SERVER decides: it checks the PIN (and badge), counts wrong attempts and locks people out.
 * Offline, the till falls back to a copy it made the last time that person authenticated online on this
 * device (a salted hash of the PIN/badge they just proved). Anyone who has never authenticated here
 * cannot be approved offline. In demo mode (no Supabase) the seeded local staff are used.
 */

export type AccessResult =
  | { ok: true; user: SessionUser }
  | { ok: false; message: string; locked?: boolean; triesLeft?: number };

interface ServerReply {
  ok: boolean;
  reason?: string;
  tries_left?: number;
  seconds?: number;
  staff?: { id: string; name: string; role: SessionUser["role"]; code: string };
  approver_id?: string;
  approver_name?: string;
  approver_role?: SessionUser["role"];
  approver_code?: string;
  name?: string;
  locked?: boolean;
}

function messageFor(r: ServerReply): Extract<AccessResult, { ok: false }> {
  switch (r.reason) {
    case "wrong_pin":
      return { ok: false, message: `Wrong PIN. ${r.tries_left ?? 0} ${r.tries_left === 1 ? "try" : "tries"} left.`, triesLeft: r.tries_left };
    case "locked": {
      const mins = r.seconds ? Math.max(1, Math.ceil(r.seconds / 60)) : 5;
      return { ok: false, message: `Too many wrong PINs. Locked for ${mins} min.`, locked: true };
    }
    case "unknown_staff":
      return { ok: false, message: "Staff code not found." };
    case "invalid_badge":
      return { ok: false, message: "Badge not recognised. Scan a supervisor ID badge." };
    case "badge_required":
      return { ok: false, message: "A supervisor badge is needed for this approval." };
    case "pin_required":
      return { ok: false, message: "Enter the PIN." };
    default:
      return { ok: false, message: "Could not verify. Try again." };
  }
}

function serverError(e: SbError): Extract<AccessResult, { ok: false }> {
  if (e.code === "28000" || e.status === 401 || /jwt|not_authenticated/i.test(e.message)) {
    return { ok: false, message: "This till is signed out of the server. Sign the till in again." };
  }
  return { ok: false, message: e.message };
}

async function remember(user: SessionUser, secrets: { pin?: string; badge?: string }) {
  const db = getDb();
  const existing = await db.staff.get(user.id);
  const salt = existing?.salt ?? crypto.randomUUID();
  const row: Staff = {
    id: user.id,
    name: user.name,
    code: user.code,
    role: user.role,
    active: true,
    salt,
    pinHash: secrets.pin ? await hashSecret(salt, secrets.pin) : (existing?.pinHash ?? ""),
    badgeHash: secrets.badge ? await hashSecret(salt, secrets.badge.trim()) : existing?.badgeHash,
  };
  await db.staff.put(row);
}

const toUser = (s: Staff): SessionUser => ({ id: s.id, name: s.name, role: s.role, code: s.code });

async function localPin(staff: Staff, pin: string): Promise<AccessResult> {
  const wait = lockedSeconds(staff.id);
  if (wait > 0) return { ok: false, message: `Too many wrong PINs. Locked for ${Math.ceil(wait / 60)} min.`, locked: true };
  if (staff.pinHash && (await verifyPin(staff, pin))) {
    clearFailures(staff.id);
    return { ok: true, user: toUser(staff) };
  }
  const left = recordFailure(staff.id);
  return left > 0
    ? { ok: false, message: `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`, triesLeft: left }
    : { ok: false, message: "Too many wrong PINs. Locked for 5 min.", locked: true };
}

/** Sign a member of staff in on this till (staff code + PIN). */
export async function signInStaff(code: string, pin: string): Promise<AccessResult> {
  if (isConnected()) {
    try {
      const { data, error } = await asSbClient(getSupabase()).rpc("verify_staff_pin", { p_staff_code: code, p_pin: pin });
      if (!error) {
        const r = data as ServerReply;
        if (!r.ok || !r.staff) return messageFor(r);
        await remember(r.staff, { pin });
        return { ok: true, user: r.staff };
      }
      if (!isNetworkError(error)) return serverError(error);
    } catch {
      /* treated as offline: fall through to the local copy */
    }
  }
  const staff = await getDb().staff.where("code").equals(code).first();
  if (!staff || !staff.active) {
    return { ok: false, message: isConnected() ? "Offline: this staff member hasn't signed in on this till before." : "Staff code not found." };
  }
  return localPin(staff, pin);
}

/** Is this a supervisor's badge? Gives instant feedback after the scan, before the PIN. */
export async function checkBadge(badge: string): Promise<{ ok: true; name: string; locked: boolean } | { ok: false; message: string }> {
  if (isConnected()) {
    try {
      const { data, error } = await asSbClient(getSupabase()).rpc("check_badge", { p_badge: badge });
      if (!error) {
        const r = data as ServerReply;
        return r.ok ? { ok: true, name: r.name ?? "Supervisor", locked: !!r.locked } : messageFor(r);
      }
      if (!isNetworkError(error)) return serverError(error);
    } catch {
      /* offline */
    }
  }
  const candidates = await getDb().staff.filter((s) => s.active && (s.role === "supervisor" || s.role === "owner")).toArray();
  for (const s of candidates) {
    if (await matchesBadge(s, badge)) return { ok: true, name: s.name, locked: lockedSeconds(s.id) > 0 };
  }
  return {
    ok: false,
    message: isConnected() ? "Badge not recognised (offline: only supervisors approved on this till before)." : "Badge not recognised. Scan a supervisor ID badge.",
  };
}

/**
 * Approve one action. Badge + PIN together; the signed-in owner passes no badge and their own staff code.
 */
export async function approve(input: { badge?: string; pin: string; action: string; staffCode?: string }): Promise<AccessResult> {
  const badge = input.badge?.trim() ?? "";
  if (isConnected()) {
    try {
      const { data, error } = await asSbClient(getSupabase()).rpc("verify_supervisor", {
        p_badge: badge || null,
        p_pin: input.pin,
        p_action: input.action,
        p_staff_code: input.staffCode ?? null,
      });
      if (!error) {
        const r = data as ServerReply;
        if (!r.ok || !r.approver_id) return messageFor(r);
        const user: SessionUser = { id: r.approver_id, name: r.approver_name ?? "Supervisor", role: r.approver_role ?? "supervisor", code: r.approver_code ?? "" };
        await remember(user, { pin: input.pin, badge: badge || undefined });
        return { ok: true, user };
      }
      if (!isNetworkError(error)) return serverError(error);
    } catch {
      /* offline */
    }
  }

  const db = getDb();
  if (badge) {
    const candidates = await db.staff.filter((s) => s.active && (s.role === "supervisor" || s.role === "owner")).toArray();
    for (const s of candidates) {
      if (await matchesBadge(s, badge)) return localPin(s, input.pin);
    }
    return { ok: false, message: "Badge not recognised." };
  }
  const owner = input.staffCode ? await db.staff.where("code").equals(input.staffCode).first() : undefined;
  if (!owner || owner.role !== "owner") return { ok: false, message: "A supervisor badge is needed for this approval." };
  return localPin(owner, input.pin);
}
