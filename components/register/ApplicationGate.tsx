"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, Clock, Loader2, LogOut, MailWarning, MessageSquareWarning, RefreshCw, Store, XCircle } from "lucide-react";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import {
  BUSINESS_TYPES,
  COUNTRIES,
  PLATFORM_NAME,
  STATUS_LABEL,
  inputFrom,
  myApplication,
  resendVerification,
  submitApplication,
  validateApplication,
  withdrawApplication,
  type ApplicationInput,
  type MyApplication,
} from "@/lib/registration";
import { OnboardingForm } from "@/components/dashboard/OnboardingForm";
import { Button, Dialog } from "@/components/ui/Dialog";

/**
 * /onboarding: everything between "I have an account" and "I have a shop".
 *
 *   email not confirmed      -> ask them to open the link (with a resend button)
 *   no application yet       -> the business application form (step 2 of registration)
 *   sent back for more info  -> the same form, prefilled, with the reviewer's message
 *   waiting for review       -> status, with the option to withdraw
 *   rejected / withdrawn     -> the reason, and a way to apply again
 *   approved                 -> the shop form (create_store), prefilled from the application
 *
 * create_store() refuses an account without an approved application, so this screen is a guide,
 * not the guard.
 */
export function ApplicationGate() {
  const router = useRouter();
  const [state, setState] = useState<MyApplication | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  // The name typed at sign-up (Supabase keeps it in user_metadata), so step 2 does not ask twice.
  const [signUpName, setSignUpName] = useState("");

  const load = useCallback(async () => {
    setError(null);
    if (!isConnected()) {
      router.replace("/setup");
      return;
    }
    const sb = getSupabase();
    const { data } = await sb.auth.getSession();
    if (!data.session) {
      router.replace("/login");
      return;
    }
    setSignUpName(String(data.session.user.user_metadata?.full_name ?? ""));
    const { data: shop } = await sb.rpc("my_shop");
    const ctx = shop as { onboarded?: boolean; is_platform_admin?: boolean } | null;
    if (ctx?.onboarded) {
      router.replace("/dashboard");
      return;
    }
    if (ctx?.is_platform_admin) {
      router.replace("/platform");
      return;
    }
    try {
      setState(await myApplication());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your registration.");
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/");
  }

  if (error) {
    return (
      <Frame onSignOut={signOut}>
        <div className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm">
          <p className="text-danger">{error}</p>
          <button className="mt-2 underline" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </Frame>
    );
  }
  if (!state) {
    return (
      <Frame>
        <p className="flex items-center justify-center gap-2 p-8 text-sm text-muted">
          <Loader2 className="animate-spin" size={16} /> Loading your registration...
        </p>
      </Frame>
    );
  }

  const app = state.application;

  if (!state.email_verified) {
    return (
      <Frame email={state.email} onSignOut={signOut}>
        <VerifyEmail email={state.email ?? ""} onRefresh={() => void load()} />
      </Frame>
    );
  }

  if (app?.status === "approved") {
    return (
      <OnboardingForm
        email={state.email ?? ""}
        initial={{
          name: app.trading_name || app.legal_name,
          address: app.address ?? "",
          phone: app.phone ?? "",
          vatNo: app.tax_number ?? "",
          currency: app.currency,
        }}
        approved
      />
    );
  }

  const canEdit = !app || app.status === "info_requested" || app.status === "rejected" || app.status === "withdrawn";
  if (canEdit && (editing || !app || app.status === "info_requested")) {
    return (
      <Frame email={state.email} onSignOut={signOut}>
        <ApplicationForm
          state={state}
          signUpName={signUpName}
          fresh={!app || app.status === "rejected" || app.status === "withdrawn"}
          onSubmitted={() => {
            setEditing(false);
            void load();
          }}
        />
      </Frame>
    );
  }

  return (
    <Frame email={state.email} onSignOut={signOut}>
      <StatusCard state={state} onApplyAgain={() => setEditing(true)} onChanged={() => void load()} />
    </Frame>
  );
}

function Frame({
  children,
  email,
  onSignOut,
}: {
  children: React.ReactNode;
  email?: string | null;
  onSignOut?: () => void;
}) {
  return (
    <main className="min-h-dvh px-4 py-10">
      <div className="mx-auto w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <Link href="/" className="grid h-11 w-11 place-items-center rounded-xl bg-primary text-primary-fg">
            <Store size={20} />
          </Link>
          <div className="mr-auto">
            <h1 className="text-xl font-semibold">Register your business</h1>
            <p className="text-sm text-muted">
              {PLATFORM_NAME}
              {email ? ` · signed in as ${email}` : ""}
            </p>
          </div>
          {onSignOut && (
            <button
              onClick={onSignOut}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted hover:bg-surface-2"
            >
              <LogOut size={15} /> Sign out
            </button>
          )}
        </div>
        {children}
      </div>
    </main>
  );
}

function VerifyEmail({ email, onRefresh }: { email: string; onRefresh: () => void }) {
  const [sent, setSent] = useState<"idle" | "sending" | "sent" | string>("idle");
  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-5">
      <MailWarning className="text-warning" size={28} />
      <h2 className="text-lg font-semibold">Confirm your email to continue</h2>
      <p className="text-sm text-muted">
        Open the link we sent to <span className="font-medium text-text">{email}</span>. The business details come
        straight after.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onRefresh}>
          <RefreshCw size={15} /> I&apos;ve confirmed it
        </Button>
        <Button
          disabled={sent === "sending" || sent === "sent"}
          onClick={async () => {
            setSent("sending");
            try {
              await resendVerification(email);
              setSent("sent");
            } catch (e) {
              setSent(e instanceof Error ? e.message : "Could not resend.");
            }
          }}
        >
          {sent === "sent" ? "Sent again" : sent === "sending" ? "Sending..." : "Resend the link"}
        </Button>
      </div>
      {sent !== "idle" && sent !== "sending" && sent !== "sent" && <p className="text-sm text-danger">{sent}</p>}
    </div>
  );
}

function ApplicationForm({
  state,
  signUpName,
  fresh,
  onSubmitted,
}: {
  state: MyApplication;
  signUpName: string;
  fresh: boolean;
  onSubmitted: () => void;
}) {
  const app = state.application;
  const [form, setForm] = useState<ApplicationInput>(() =>
    inputFrom(fresh ? null : app, app?.owner_name ?? signUpName),
  );
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof ApplicationInput>(k: K, v: ApplicationInput[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setError(null);
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problem = validateApplication(form);
    if (problem) return setError(problem);
    if (!terms) return setError("Accept the terms of service and privacy policy to continue.");
    setBusy(true);
    try {
      await submitApplication({ ...form, currency: form.currency.trim().toUpperCase() }, state.terms_version);
      onSubmitted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the application.");
    } finally {
      setBusy(false);
    }
  }

  const label = "mb-1 block text-sm font-medium";
  return (
    <form onSubmit={submit} className="space-y-5 rounded-xl border border-border bg-surface p-5" noValidate>
      <p className="text-sm text-muted">Step 2 of 2 · About the business. A reviewer reads this before the shop opens.</p>

      {app?.status === "info_requested" && app.decision_reason && (
        <div className="flex gap-2 rounded-lg border border-warning/40 bg-warning/10 p-3 text-sm">
          <MessageSquareWarning className="mt-0.5 shrink-0 text-warning" size={16} />
          <div>
            <p className="font-medium">The reviewer asked for more information</p>
            <p className="mt-0.5">{app.decision_reason}</p>
          </div>
        </div>
      )}

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">You</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Full name *</span>
            <input className="field" autoFocus value={form.owner_name} onChange={(e) => set("owner_name", e.target.value)} />
          </label>
          <label className="block">
            <span className={label}>Mobile number</span>
            <input className="field" inputMode="tel" value={form.owner_phone} onChange={(e) => set("owner_phone", e.target.value)} />
          </label>
        </div>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">The business</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block">
            <span className={label}>Registered business name *</span>
            <input className="field" value={form.legal_name} onChange={(e) => set("legal_name", e.target.value)} placeholder="Perera Traders (Pvt) Ltd" />
          </label>
          <label className="block">
            <span className={label}>Shop name customers see</span>
            <input className="field" value={form.trading_name} onChange={(e) => set("trading_name", e.target.value)} placeholder="Perera Mart" />
          </label>
        </div>

        <div>
          <span className={label}>What kind of business is it? *</span>
          <div className="grid gap-2 sm:grid-cols-2">
            {BUSINESS_TYPES.map((b) => (
              <label
                key={b.id}
                className={`flex cursor-pointer items-start gap-2 rounded-lg border p-2.5 text-sm ${
                  form.business_type === b.id ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2"
                }`}
              >
                <input
                  type="radio"
                  name="business_type"
                  className="mt-0.5"
                  checked={form.business_type === b.id}
                  onChange={() => set("business_type", b.id)}
                />
                <span>
                  <span className="block font-medium">{b.label}</span>
                  <span className="block text-xs text-muted">{b.hint}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block sm:col-span-2">
            <span className={label}>Country *</span>
            <select
              className="field"
              value={form.country}
              onChange={(e) => {
                const c = COUNTRIES.find((x) => x.name === e.target.value);
                setForm((f) => ({ ...f, country: e.target.value, currency: c?.currency ?? f.currency }));
              }}
            >
              {COUNTRIES.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className={label}>Currency *</span>
            <input
              className="field uppercase"
              value={form.currency}
              maxLength={3}
              onChange={(e) => set("currency", e.target.value.replace(/[^a-z]/gi, ""))}
            />
          </label>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block sm:col-span-2">
            <span className={label}>Address</span>
            <input className="field" value={form.address} onChange={(e) => set("address", e.target.value)} />
          </label>
          <label className="block">
            <span className={label}>Business phone</span>
            <input className="field" inputMode="tel" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          </label>
          <label className="block">
            <span className={label}>VAT / tax number</span>
            <input className="field" value={form.tax_number} onChange={(e) => set("tax_number", e.target.value)} placeholder="If registered" />
          </label>
          <label className="block">
            <span className={label}>Business registration number</span>
            <input className="field" value={form.registration_number} onChange={(e) => set("registration_number", e.target.value)} placeholder="Optional" />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>Locations</span>
              <input
                className="field"
                inputMode="numeric"
                value={form.locations_count}
                onChange={(e) => set("locations_count", Number(e.target.value.replace(/\D/g, "")) || 0)}
              />
            </label>
            <label className="block">
              <span className={label}>Tills</span>
              <input
                className="field"
                inputMode="numeric"
                value={form.tills_count}
                onChange={(e) => set("tills_count", Number(e.target.value.replace(/\D/g, "")) || 0)}
              />
            </label>
          </div>
        </div>
      </fieldset>

      <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-sm">
        <input type="checkbox" className="mt-0.5" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
        <span>
          I accept the{" "}
          <Link href="/terms" target="_blank" className="font-semibold text-primary hover:underline">terms of service</Link> and{" "}
          <Link href="/privacy" target="_blank" className="font-semibold text-primary hover:underline">privacy policy</Link>{" "}
          <span className="text-muted">(version {state.terms_version})</span>, and confirm I may register this business.
        </span>
      </label>

      {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

      <button
        type="submit"
        disabled={busy}
        className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg disabled:opacity-60"
      >
        {busy && <Loader2 className="animate-spin" size={16} />}
        {app?.status === "info_requested" ? "Send the updated application" : "Send application"}
      </button>
    </form>
  );
}

function StatusCard({
  state,
  onApplyAgain,
  onChanged,
}: {
  state: MyApplication;
  onApplyAgain: () => void;
  onChanged: () => void;
}) {
  const app = state.application!;
  const [withdrawing, setWithdrawing] = useState(false);
  const type = BUSINESS_TYPES.find((b) => b.id === app.business_type)?.label ?? app.business_type;

  const tone =
    app.status === "submitted"
      ? { Icon: Clock, color: "text-primary", text: "A reviewer will look at it shortly. Sign in again any time to see the decision here." }
      : app.status === "rejected"
        ? { Icon: XCircle, color: "text-danger", text: "The application was not approved. You can correct it and apply again." }
        : app.status === "withdrawn"
          ? { Icon: XCircle, color: "text-muted", text: "You withdrew this application." }
          : { Icon: CheckCircle2, color: "text-success", text: "" };

  return (
    <div className="space-y-4 rounded-xl border border-border bg-surface p-5">
      <div className="flex items-start gap-3">
        <tone.Icon className={`mt-0.5 shrink-0 ${tone.color}`} size={26} />
        <div>
          <h2 className="text-lg font-semibold">{STATUS_LABEL[app.status]}</h2>
          <p className="text-sm text-muted">{tone.text}</p>
        </div>
      </div>

      {app.decision_reason && app.status === "rejected" && (
        <p className="rounded-lg border border-border bg-surface-2 p-3 text-sm">
          <span className="font-medium">Reviewer&apos;s note: </span>
          {app.decision_reason}
        </p>
      )}

      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <Item term="Business" value={app.trading_name ? `${app.trading_name} (${app.legal_name})` : app.legal_name} />
        <Item term="Type" value={type} />
        <Item term="Country" value={`${app.country} · ${app.currency}`} />
        <Item term="Sent" value={new Date(app.submitted_at).toLocaleString()} />
      </dl>

      <div className="flex flex-wrap gap-2">
        {app.status === "submitted" && (
          <>
            <Button onClick={onChanged}>
              <RefreshCw size={15} /> Check again
            </Button>
            <Button variant="ghost" onClick={() => setWithdrawing(true)}>
              Withdraw application
            </Button>
          </>
        )}
        {(app.status === "rejected" || app.status === "withdrawn") && (
          <Button variant="primary" onClick={onApplyAgain}>
            Apply again
          </Button>
        )}
      </div>

      {withdrawing && (
        <WithdrawDialog
          onClose={() => setWithdrawing(false)}
          onDone={() => {
            setWithdrawing(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function WithdrawDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    try {
      await withdrawApplication();
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not withdraw.");
      setBusy(false);
    }
  }
  return (
    <Dialog
      title="Withdraw the application?"
      tone="danger"
      onClose={onClose}
      onConfirm={() => void go()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={busy}>
            {busy ? "Withdrawing..." : "Withdraw"}
          </Button>
        </>
      }
    >
      <p className="text-sm text-muted">The reviewer will no longer see it. You can apply again at any time.</p>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Dialog>
  );
}

function Item({ term, value }: { term: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-2">
      <dt className="text-xs uppercase text-muted">{term}</dt>
      <dd className="break-words">{value}</dd>
    </div>
  );
}
