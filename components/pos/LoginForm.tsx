"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { signInStaff } from "@/lib/data/access";
import { ensureSeeded, getDb } from "@/lib/data/db";
import { SHOP_NAME } from "@/lib/config";
import { playCue } from "@/lib/sound";
import { usePos } from "@/lib/store";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import { useShake } from "@/lib/useShake";
import { Button } from "../ui/Dialog";

type DeviceState = "checking" | "needed" | "ready";

/**
 * Two levels of sign-in when connected to Supabase:
 *   1. the TILL signs in once with its own account (email + password), kept for weeks;
 *   2. each member of staff then signs in on it with staff code + PIN (all day, from the keyboard).
 * In demo mode only step 2 exists.
 */
export function LoginForm() {
  const router = useRouter();
  const login = usePos((s) => s.login);
  const [device, setDevice] = useState<DeviceState>(isConnected() ? "checking" : "ready");
  const shopName = useLiveQuery(async () => {
    if (!isConnected()) return SHOP_NAME;
    const till = (await getDb().meta.get("till"))?.value as { store?: { name?: string } } | undefined;
    return till?.store?.name ?? SHOP_NAME;
  }, [], SHOP_NAME);

  // /login?till=1 means "only the till's own sign-in expired": staff stay signed in and go straight back.
  const wantsTill = useRef(false);

  useEffect(() => {
    void ensureSeeded();
    wantsTill.current = window.location.search.includes("till=1");
    if (usePos.getState().session && !wantsTill.current) router.replace("/pos");
    if (!isConnected()) return;
    void getSupabase()
      .auth.getSession()
      .then(({ data }) => {
        if (data.session && wantsTill.current) router.replace("/pos");
        else setDevice(data.session ? "ready" : "needed");
      })
      .catch(() => setDevice("needed"));
  }, [router]);

  return (
    <main className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-2xl font-bold text-primary-fg">
            {shopName[0]}
          </span>
          <h1 className="text-2xl font-semibold">{shopName}</h1>
          <p className="text-sm text-muted">{device === "needed" ? "Sign in this till" : "Sign in to the till"}</p>
        </div>

        {device === "checking" && <p className="text-center text-muted">Checking…</p>}
        {device === "needed" && (
          <DeviceForm onDone={() => (wantsTill.current && usePos.getState().session ? router.replace("/pos") : setDevice("ready"))} />
        )}
        {device === "ready" && (
          <StaffForm
            onSignedIn={(u) => {
              login(u);
              router.replace("/pos");
            }}
            onChangeTill={
              isConnected()
                ? async () => {
                    await getSupabase().auth.signOut();
                    setDevice("needed");
                  }
                : undefined
            }
          />
        )}

        {!isConnected() && (
          <div className="mt-4 rounded-xl border border-dashed border-border p-3 text-xs text-muted">
            <p className="mb-1 font-semibold text-text">Demo mode: not connected to Supabase</p>
            <p className="num">Owner: code 1, PIN 9999</p>
            <p className="num">Supervisor Kamal: code 2, PIN 2222, badge text SUP-0002</p>
            <p className="num">Cashier Nimal: code 3, PIN 3333</p>
          </div>
        )}
      </div>
    </main>
  );
}

/** Step 1: the till's own account. */
function DeviceForm({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const passRef = useRef<HTMLInputElement>(null);

  async function submit() {
    if (busy) return;
    if (!email.trim() || !password) return setError("Enter the till's email and password.");
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await getSupabase().auth.signInWithPassword({ email: email.trim(), password });
      if (err) {
        setError(/fetch|network/i.test(err.message) ? "No connection to the server. Check the internet and try again." : err.message);
        shake();
        playCue("error");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={shakeRef} className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
      <p className="mb-3 text-sm text-muted">
        This is done once per till. Use the till account the owner created in Supabase. Staff sign in with their code and PIN afterwards.
      </p>
      <label className="text-sm font-semibold text-muted" htmlFor="till-email">Till email</label>
      <input
        id="till-email"
        type="email"
        autoFocus
        value={email}
        autoComplete="username"
        onChange={(e) => setEmail(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), passRef.current?.focus())}
        className="mb-3 mt-1 h-12 w-full rounded-xl border-2 border-border bg-surface px-3 text-lg outline-none focus:border-primary"
      />
      <label className="text-sm font-semibold text-muted" htmlFor="till-password">Password</label>
      <input
        id="till-password"
        ref={passRef}
        type="password"
        value={password}
        autoComplete="current-password"
        onChange={(e) => setPassword(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void submit())}
        className="mt-1 h-12 w-full rounded-xl border-2 border-border bg-surface px-3 text-lg outline-none focus:border-primary"
      />
      <p role="alert" className="mt-2 min-h-5 text-center text-sm font-medium text-danger">{error ?? ""}</p>
      <Button variant="primary" className="mt-1 h-12 w-full text-base" onClick={submit} disabled={busy} keycap="Enter">
        Sign in this till
      </Button>
    </div>
  );
}

/** Step 2: staff code + PIN. */
function StaffForm({ onSignedIn, onChangeTill }: { onSignedIn: (u: { id: string; name: string; role: "owner" | "supervisor" | "cashier"; code: string }) => void; onChangeTill?: () => void }) {
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const [busy, setBusy] = useState(false);
  const pinRef = useRef<HTMLInputElement>(null);

  function fail(msg: string) {
    setError(msg);
    setPin("");
    shake();
    playCue("error");
    pinRef.current?.focus();
  }

  async function submit() {
    if (busy) return;
    if (code.trim() === "" || pin === "") return fail("Enter your staff code and PIN.");
    setBusy(true);
    try {
      const res = await signInStaff(code.trim(), pin);
      if (!res.ok) return fail(res.message);
      onSignedIn(res.user);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div ref={shakeRef}>
      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <label className="text-sm font-semibold text-muted" htmlFor="code">Staff code</label>
        <input
          id="code"
          autoFocus
          value={code}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              pinRef.current?.focus();
            }
          }}
          className="num mb-3 mt-1 h-14 w-full rounded-xl border-2 border-border bg-surface px-4 text-center text-2xl outline-none focus:border-primary"
        />
        <label className="text-sm font-semibold text-muted" htmlFor="pin">PIN</label>
        <input
          id="pin"
          ref={pinRef}
          type="password"
          value={pin}
          inputMode="numeric"
          autoComplete="off"
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 8))}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void submit();
            }
          }}
          className="num mt-1 h-14 w-full rounded-xl border-2 border-border bg-surface px-4 text-center text-2xl tracking-[0.4em] outline-none focus:border-primary"
        />
        <p role="alert" className="mt-2 min-h-5 text-center text-sm font-medium text-danger">{error ?? ""}</p>
        <Button variant="primary" className="mt-1 h-12 w-full text-base" onClick={submit} disabled={busy} keycap="Enter">
          Sign in
        </Button>
      </div>
      {onChangeTill && (
        <button type="button" onClick={onChangeTill} className="mx-auto mt-3 block text-xs text-muted underline">
          Sign this till out of the server
        </button>
      )}
    </div>
  );
}
