"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, LogOut, ShieldAlert } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { Button } from "../ui/Dialog";

/**
 * The owner's own account.
 *
 * Exists because accounts are now provisioned with a password the shop did not choose. `?first=1` is
 * the forced path used straight after such a handover: the sidebar is hidden and the only ways out are
 * setting a password or signing out. Without this, a generated password would stay live indefinitely
 * and would be known to whoever wrote it down.
 *
 * The password itself is changed through Supabase Auth (auth.updateUser), not through an RPC: the
 * service that verifies the login is the one that must change it.
 */
export function AccountScreen() {
  const router = useRouter();
  const [first, setFirst] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setFirst(window.location.search.includes("first=1"));
    void (async () => {
      try {
        const { data } = await getSupabase().auth.getSession();
        if (!data.session) {
          router.replace("/login");
          return;
        }
        setEmail(data.session.user.email ?? null);
      } catch {
        router.replace("/login");
      }
    })();
  }, [router]);

  const longEnough = password.length >= 8;
  const matches = password.length > 0 && password === confirm;
  const canSubmit = longEnough && matches && !busy;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await getSupabase().auth.updateUser({ password });
      if (err) throw new Error(err.message);
      // Clear the first-login flag only after Auth accepted the new password, so a failed change
      // cannot leave the account looking settled while the generated password still works.
      await getSupabase().rpc("complete_password_change");
      setDone(true);
      setPassword("");
      setConfirm("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change your password.");
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <div className="w-full max-w-md">
        <h1 className="mb-1 text-xl font-semibold">{first ? "Choose your password" : "Your account"}</h1>
        <p className="mb-5 text-sm text-muted">
          {first
            ? "Your shop was set up with a temporary password. Replace it with one only you know."
            : "Change the password you sign in with."}
        </p>

        {email && (
          <div className="mb-4 rounded-xl border border-border bg-surface-2 px-3 py-2">
            <p className="text-xs uppercase text-muted">Signed in as</p>
            <p className="num break-all text-sm font-medium">{email}</p>
          </div>
        )}

        {done ? (
          <div className="space-y-3 rounded-xl border border-success/40 bg-success/10 p-4">
            <p className="flex items-center gap-2 text-sm font-medium text-success">
              <Check size={16} /> Password changed
            </p>
            <p className="text-sm text-muted">Use the new password the next time you sign in.</p>
            <div className="flex gap-2 pt-1">
              <Button variant="primary" onClick={() => router.replace("/")}>
                Continue
              </Button>
              <Button variant="ghost" onClick={() => void signOut()}>
                <LogOut size={15} className="mr-1.5" /> Sign out
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <Field label="New password" hint="At least 8 characters.">
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                data-autofocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
            <Field label="Repeat new password" hint={confirm && !matches ? "The two do not match." : undefined}>
              <input
                className="field"
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </Field>

            {error && (
              <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">
                <ShieldAlert size={15} className="mt-0.5 shrink-0 text-danger" /> {error}
              </p>
            )}

            <div className="flex gap-2 pt-1">
              <Button variant="primary" type="submit" disabled={!canSubmit}>
                {busy ? "Saving..." : "Change password"}
              </Button>
              <Button variant="ghost" type="button" onClick={() => void signOut()}>
                <LogOut size={15} className="mr-1.5" /> Sign out
              </Button>
            </div>

            {first && (
              <p className="pt-1 text-xs text-muted">
                Until you choose a password, anyone given the temporary one can sign in as you.
              </p>
            )}
          </form>
        )}
      </div>
    </main>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
