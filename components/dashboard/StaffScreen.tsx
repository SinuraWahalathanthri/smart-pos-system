"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, ScanLine, UserX, KeyRound } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { Button, Dialog } from "../ui/Dialog";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { isValidPin, sanitisePin } from "@/lib/pin";
import { permissions, useShop, type Role } from "./useShop";

type StaffRow = {
  id: string;
  full_name: string;
  staff_code: string;
  role: Role;
  is_active: boolean;
  has_badge: boolean;
  has_pin: boolean;
  created_at: string;
};

/**
 * Staff management. Owner only, enforced by the RPCs (`create_staff` refuses anyone else).
 *
 * PINs are set here and hashed server side; nothing in this screen ever reads a hash back.
 */
export function StaffScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);

  return (
    <DashboardShell>
      {can.manageStaff ? <StaffList /> : <NotAllowed what="staff" role={ctx?.role} />}
    </DashboardShell>
  );
}

function StaffList() {
  const [rows, setRows] = useState<StaffRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<StaffRow | null>(null);
  const [badgeFor, setBadgeFor] = useState<StaffRow | null>(null);

  async function load() {
    setLoading(true);
    const { data, error: err } = await getSupabase().rpc("staff_directory");
    setLoading(false);
    if (err) {
      setError(err.message);
      return;
    }
    setRows((data as StaffRow[] | null) ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function call(fn: string, args: Record<string, unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const { error: err } = await getSupabase().rpc(fn, args);
    setBusy(false);
    if (err) {
      setError(err.message);
      return false;
    }
    setMessage(ok);
    await load();
    return true;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Staff</h1>
          <p className="text-sm text-muted">People who can sign in at the till.</p>
        </div>
        <button
          onClick={() => setAdding(true)}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg disabled:opacity-60"
        >
          <Plus size={16} /> Add staff
        </button>
      </div>

      {message && <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{message}</p>}
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      {pinFor && (
        <SetPinDialog
          staff={pinFor}
          serverError={error}
          onClose={() => setPinFor(null)}
          onSubmit={async (pin) => {
            const ok = await call("set_staff_pin", { p_staff_id: pinFor.id, p_pin: pin }, "PIN updated.");
            if (ok) setPinFor(null);
          }}
        />
      )}

      {badgeFor && (
        <SetBadgeDialog
          staff={badgeFor}
          serverError={error}
          onClose={() => setBadgeFor(null)}
          onSubmit={async (badge) => {
            const ok = await call(
              "set_staff_badge",
              { p_staff_id: badgeFor.id, p_badge: badge },
              `${badgeFor.full_name}'s badge is set. It now approves at the till together with their PIN.`,
            );
            if (ok) setBadgeFor(null);
          }}
        />
      )}

      {adding && (
        <AddStaffForm
          onCancel={() => setAdding(false)}
          onCreate={async (form) => {
            const ok = await call(
              "create_staff",
              {
                p_name: form.name,
                p_staff_code: form.code,
                p_role: form.role,
                p_pin: form.pin,
              },
              `${form.name} can now sign in with code ${form.code}.`,
            );
            if (ok) setAdding(false);
          }}
          busy={busy}
        />
      )}

      {loading ? (
        <p className="text-sm text-muted">Loading...</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted">
          No staff yet. Add a cashier to start selling.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Code</th>
                <th className="px-4 py-2">Role</th>
                <th className="px-4 py-2">Badge</th>
                <th className="px-4 py-2">PIN</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2 font-medium">{r.full_name}</td>
                  <td className="px-4 py-2 font-mono">{r.staff_code}</td>
                  <td className="px-4 py-2 capitalize">{r.role}</td>
                  <td className="px-4 py-2">
                    {/* A supervisor approves with badge + PIN together; without a badge they cannot approve at all. */}
                    {r.has_badge ? (
                      <span className="text-muted">Set</span>
                    ) : r.role === "supervisor" ? (
                      <span className="font-medium text-danger" title="Cannot approve voids or discounts until a badge is set">
                        Not set
                      </span>
                    ) : (
                      <span className="text-muted">-</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    {/* No PIN means the till rejects every attempt, which reads as "wrong PIN". */}
                    {r.has_pin ? <span className="text-muted">Set</span> : <span className="font-medium text-danger">Not set</span>}
                  </td>
                  <td className="px-4 py-2">
                    <span className={r.is_active ? "text-success" : "text-muted"}>
                      {r.is_active ? "Active" : "Inactive"}
                    </span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-1">
                      <button
                        title="Reset PIN"
                        disabled={busy}
                        onClick={() => setPinFor(r)}
                        className="rounded-lg p-2 text-muted hover:bg-surface-2"
                      >
                        <KeyRound size={16} />
                      </button>
                      {r.role !== "cashier" && (
                        <button
                          title={r.has_badge ? "Replace badge" : "Set badge"}
                          disabled={busy}
                          onClick={() => setBadgeFor(r)}
                          className="rounded-lg p-2 text-muted hover:bg-surface-2"
                        >
                          <ScanLine size={16} />
                        </button>
                      )}
                      {r.role !== "owner" && (
                        <button
                          title={r.is_active ? "Deactivate" : "Reactivate"}
                          disabled={busy}
                          onClick={() =>
                            void call(
                              "set_staff_active",
                              { p_staff_id: r.id, p_active: !r.is_active },
                              r.is_active ? "Staff deactivated." : "Staff reactivated.",
                            )
                          }
                          className="rounded-lg p-2 text-muted hover:bg-surface-2"
                        >
                          <UserX size={16} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Reset one person's till PIN.
 *
 * A real dialog rather than `window.prompt`: Electron does not implement `prompt()` at all, so it
 * returns null without showing anything and the button silently did nothing in the desktop app.
 * The validation mirrors `set_staff_pin` (4-8 digits) so a bad PIN is caught before the round trip.
 *
 * Errors are shown here, not in the page banner behind the overlay - a failed save that appears to do
 * nothing is what the operator would otherwise see.
 */
function SetPinDialog({
  staff,
  serverError,
  onClose,
  onSubmit,
}: {
  staff: StaffRow;
  /** Failure from the RPC. Passed in because the page banner sits behind this overlay. */
  serverError: string | null;
  onClose: () => void;
  onSubmit: (pin: string) => void | Promise<void>;
}) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const valid = isValidPin(pin);
  const matches = pin === confirm;

  async function submit() {
    if (!valid) {
      setErr("The PIN must be 4 to 8 digits.");
      return;
    }
    if (!matches) {
      setErr("The two PINs do not match.");
      return;
    }
    setErr(null);
    setSaving(true);
    await onSubmit(pin);
    setSaving(false);
  }

  return (
    <Dialog
      title={`Set PIN for ${staff.full_name}`}
      onClose={onClose}
      width="max-w-sm"
      onConfirm={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving || !valid || !matches}>
            {saving ? <Loader2 className="animate-spin" size={15} /> : <KeyRound size={15} />} Set PIN
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {staff.full_name} signs in at the till with code <span className="font-mono">{staff.staff_code}</span>.
          Setting a PIN also clears any lockout from failed attempts.
        </p>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">New PIN</span>
          <input
            className="field font-mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            data-autofocus
            value={pin}
            onChange={(e) => {
              setPin(sanitisePin(e.target.value));
              setErr(null);
            }}
            placeholder="4-8 digits"
            maxLength={8}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Confirm PIN</span>
          <input
            className="field font-mono"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => {
              setConfirm(sanitisePin(e.target.value));
              setErr(null);
            }}
            placeholder="Type it again"
            maxLength={8}
          />
        </label>

        {confirm.length > 0 && !matches && <p className="text-xs text-danger">The two PINs do not match.</p>}
        {err && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</p>
        )}
        {serverError && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
            {serverError}
          </p>
        )}

        <p className="text-xs text-muted">The PIN is hashed on the server and cannot be read back.</p>
      </div>
    </Dialog>
  );
}

/**
 * Register the badge a supervisor scans to approve a void, discount or stock correction.
 *
 * The till asks for the badge AND the PIN together; a supervisor without a badge is refused with
 * "badge_required", so before this dialog existed only the owner could approve anything. The badge
 * is scanned twice: a misread scan stored as the badge would lock the supervisor out with no hint why.
 */
function SetBadgeDialog({
  staff,
  serverError,
  onClose,
  onSubmit,
}: {
  staff: StaffRow;
  serverError: string | null;
  onClose: () => void;
  onSubmit: (badge: string) => void | Promise<void>;
}) {
  const [badge, setBadge] = useState("");
  const [again, setAgain] = useState("");
  const [saving, setSaving] = useState(false);
  const secondRef = useRef<HTMLInputElement>(null);

  const ready = badge.trim().length >= 3 && badge.trim() === again.trim();

  async function submit() {
    if (!ready) return;
    setSaving(true);
    await onSubmit(badge.trim());
    setSaving(false);
  }

  return (
    <Dialog
      title={`${staff.has_badge ? "Replace" : "Set"} badge for ${staff.full_name}`}
      onClose={onClose}
      width="max-w-sm"
      onKey={(e) => {
        // A scanner ends with Enter: after the first scan, move to the second field instead of submitting.
        if (e.key === "Enter" && (e.target as HTMLElement).dataset.badge === "first") {
          e.preventDefault();
          secondRef.current?.focus();
          return true;
        }
      }}
      onConfirm={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={saving || !ready}>
            {saving ? <Loader2 className="animate-spin" size={15} /> : <ScanLine size={15} />} Save badge
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Scan {staff.full_name}&apos;s staff badge, then scan it again to confirm. You can also type the code printed
          under the barcode.
          {staff.has_badge && " The old badge stops working immediately."}
        </p>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Scan badge</span>
          <input
            className="field font-mono"
            type="password"
            autoComplete="off"
            data-autofocus
            data-badge="first"
            value={badge}
            onChange={(e) => setBadge(e.target.value)}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Scan again</span>
          <input
            ref={secondRef}
            className="field font-mono"
            type="password"
            autoComplete="off"
            value={again}
            onChange={(e) => setAgain(e.target.value)}
          />
        </label>
        {again.length > 0 && badge.trim() !== again.trim() && (
          <p className="text-xs text-danger">The two scans do not match. Scan the same badge twice.</p>
        )}
        {serverError && (
          <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{serverError}</p>
        )}
        <p className="text-xs text-muted">The badge is hashed on the server and cannot be read back.</p>
      </div>
    </Dialog>
  );
}

function AddStaffForm({
  onCreate,
  onCancel,
  busy,
}: {
  onCreate: (f: { name: string; code: string; role: Role; pin: string }) => void | Promise<void>;
  onCancel: () => void;
  busy: boolean;
}) {
  const [form, setForm] = useState({ name: "", code: "", role: "cashier" as Role, pin: "" });
  const valid = form.name.trim() && form.code.trim() && isValidPin(form.pin);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void onCreate(form);
      }}
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Full name</span>
          <input
            className="field"
            autoFocus
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Nimal Perera"
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Staff code</span>
          <input
            className="field font-mono"
            value={form.code}
            onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
            placeholder="2"
            maxLength={16}
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Role</span>
          <select
            className="field"
            value={form.role}
            onChange={(e) => setForm((f) => ({ ...f, role: e.target.value as Role }))}
          >
            <option value="cashier">Cashier - till only</option>
            <option value="supervisor">Supervisor - till and products</option>
          </select>
        </label>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">PIN</span>
          <input
            className="field font-mono"
            type="password"
            inputMode="numeric"
            value={form.pin}
            onChange={(e) => setForm((f) => ({ ...f, pin: sanitisePin(e.target.value) }))}
            placeholder="4-8 digits"
            maxLength={8}
          />
        </label>
      </div>

      <p className="text-xs text-muted">
        The PIN is hashed on the server and cannot be read back. If it is forgotten, reset it here.
      </p>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid || busy}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={14} />} Add staff
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}
