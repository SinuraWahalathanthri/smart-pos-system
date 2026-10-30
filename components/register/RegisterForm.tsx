"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, MailCheck, Store } from "lucide-react";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import {
  CAPTCHA_SITE_KEY,
  MIN_PASSWORD,
  PLATFORM_NAME,
  isEmail,
  passwordStrength,
  registerAccount,
  resendVerification,
} from "@/lib/registration";
import { Captcha } from "./Captcha";

/**
 * Step 1 of registration: the owner's own account.
 *
 * Only the account is made here. The business details come next, on /onboarding, because the
 * application RPC needs a signed-in, verified account behind it - nothing in registration is
 * callable anonymously.
 */
export function RegisterForm() {
  const router = useRouter();
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "" });
  const [captcha, setCaptcha] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  // Already signed in: the next step is the application, not a second account.
  useEffect(() => {
    if (!isConnected()) return;
    void getSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session) router.replace("/onboarding");
      });
  }, [router]);

  const onToken = useCallback((t: string | null) => setCaptcha(t), []);
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [k]: e.target.value }));
    setError(null);
  };
  const strength = passwordStrength(form.password);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!form.name.trim()) return setError("Enter your full name.");
    if (!isEmail(form.email)) return setError("Enter a valid email address.");
    if (form.password.length < MIN_PASSWORD) return setError(`The password needs at least ${MIN_PASSWORD} characters.`);
    if (form.password !== form.confirm) return setError("The two passwords do not match.");
    if (CAPTCHA_SITE_KEY && !captcha) return setError("Complete the human check first.");

    setBusy(true);
    try {
      const { needsVerification } = await registerAccount({
        email: form.email,
        password: form.password,
        fullName: form.name,
        captchaToken: captcha,
      });
      if (needsVerification) setSentTo(form.email.trim().toLowerCase());
      else router.replace("/onboarding");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the account.");
    } finally {
      setBusy(false);
    }
  }

  if (!isConnected()) {
    return (
      <Shell>
        <p className="rounded-xl border border-border bg-surface p-5 text-sm text-muted">
          This installation is not connected to a server yet, so new businesses cannot register here.{" "}
          <Link href="/setup" className="font-semibold text-primary hover:underline">Connect to Supabase</Link> first.
        </p>
      </Shell>
    );
  }

  if (sentTo) return <CheckEmail email={sentTo} />;

  return (
    <Shell>
      <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-5" noValidate>
        <p className="text-sm text-muted">
          Step 1 of 2 · Your account. You will use it to sign in to the dashboard and manage the business.
        </p>
        <Field label="Your full name">
          <input className="field" autoFocus autoComplete="name" value={form.name} onChange={set("name")} maxLength={120} />
        </Field>
        <Field label="Email">
          <input
            className="field"
            type="email"
            autoComplete="email"
            inputMode="email"
            value={form.email}
            onChange={set("email")}
            placeholder="you@business.com"
          />
        </Field>
        <Field label="Password">
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
          />
          {form.password && (
            <span className="mt-1.5 flex items-center gap-2 text-xs text-muted">
              <span className="flex gap-1" aria-hidden>
                {[1, 2, 3].map((i) => (
                  <span
                    key={i}
                    className={`h-1.5 w-8 rounded-full ${
                      strength.score >= i ? (strength.score === 1 ? "bg-warning" : "bg-success") : "bg-surface-2"
                    }`}
                  />
                ))}
              </span>
              {strength.label}
            </span>
          )}
        </Field>
        <Field label="Confirm password">
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={set("confirm")}
          />
        </Field>

        <Captcha onToken={onToken} />

        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}

        <button
          type="submit"
          disabled={busy}
          className="flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-fg disabled:opacity-60"
        >
          {busy ? <Loader2 className="animate-spin" size={16} /> : <ArrowRight size={16} />} Create account
        </button>
        <p className="text-center text-sm text-muted">
          Already registered?{" "}
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </form>
    </Shell>
  );
}

/** Shown after sign-up: the account exists but cannot do anything until the email is confirmed. */
function CheckEmail({ email }: { email: string }) {
  const [state, setState] = useState<"idle" | "sending" | "sent" | string>("idle");
  async function resend() {
    setState("sending");
    try {
      await resendVerification(email);
      setState("sent");
    } catch (e) {
      setState(e instanceof Error ? e.message : "Could not resend the email.");
    }
  }
  return (
    <Shell>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-5 text-center">
        <MailCheck className="mx-auto text-primary" size={32} />
        <h2 className="text-lg font-semibold">Check your email</h2>
        <p className="text-sm text-muted">
          We sent a confirmation link to <span className="font-medium text-text">{email}</span>. Open it to continue
          to step 2, the business details.
        </p>
        <p className="text-xs text-muted">Nothing arrived? Check the spam folder, or send it again.</p>
        <button
          type="button"
          onClick={() => void resend()}
          disabled={state === "sending" || state === "sent"}
          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-2 disabled:opacity-60"
        >
          {state === "sent" ? "Sent again" : state === "sending" ? "Sending..." : "Resend the link"}
        </button>
        {state !== "idle" && state !== "sending" && state !== "sent" && <p className="text-sm text-danger">{state}</p>}
        <p className="border-t border-border pt-3 text-sm text-muted">
          Confirmed on another device?{" "}
          <Link href="/login" className="font-semibold text-primary hover:underline">Sign in here</Link>
        </p>
      </div>
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <Link href="/" className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-fg">
            <Store size={26} />
          </Link>
          <h1 className="text-2xl font-semibold">Register your business</h1>
          <p className="mt-1 text-sm text-muted">on {PLATFORM_NAME}</p>
        </div>
        {children}
      </div>
    </main>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
