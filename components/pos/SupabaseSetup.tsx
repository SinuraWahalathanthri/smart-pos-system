"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { SHOP_NAME } from "@/lib/config";
import {
  clearSupabaseConfig,
  getSupabaseConfig,
  testConnection,
  validateConfig,
  type ConfigProblem,
  type SupabaseConfig,
} from "@/lib/supabase/config";
import { resetSupabaseClient } from "@/lib/supabase/client";
import { Button } from "../ui/Dialog";

/**
 * Where the shopkeeper pastes their Supabase project URL and anon key.
 *
 * Kept deliberately plain: this is the one screen a non-developer will touch, once, on a new machine.
 * The connection test runs before saving so a typo is caught here rather than at the first sale.
 */
export function SupabaseSetup({ onDone }: { onDone?: () => void }) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [anonKey, setAnonKey] = useState("");
  const [problems, setProblems] = useState<ConfigProblem[]>([]);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [existing, setExisting] = useState<boolean>(false);

  useEffect(() => {
    const current = getSupabaseConfig();
    if (current) {
      setUrl(current.url);
      setExisting(true);
    }
  }, []);

  const problemFor = (field: ConfigProblem["field"]) => problems.find((p) => p.field === field)?.message;

  async function connect() {
    if (busy) return;
    setStatus(null);
    const candidate: SupabaseConfig = { url: url.trim(), anonKey: anonKey.trim() };
    const found = validateConfig(candidate);
    setProblems(found);
    if (found.length) return;

    setBusy(true);
    try {
      const result = await testConnection(candidate);
      setStatus({ ok: result.ok, message: result.message });
      if (result.ok) {
        const { saveSupabaseConfig } = await import("@/lib/supabase/config");
        saveSupabaseConfig(candidate);
        resetSupabaseClient();
        setExisting(true);
        onDone?.();
      }
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    clearSupabaseConfig();
    resetSupabaseClient();
    setUrl("");
    setAnonKey("");
    setExisting(false);
    setStatus({ ok: true, message: "Cleared. The till is back in demo mode with sample data." });
  }

  const inputClass =
    "mt-1 h-12 w-full rounded-xl border-2 border-border bg-surface px-3 font-mono text-sm outline-none focus:border-primary";

  return (
    <div className="w-full max-w-lg">
      <div className="mb-6 text-center">
        <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-2xl font-bold text-primary-fg">
          {SHOP_NAME[0]}
        </span>
        <h1 className="text-2xl font-semibold">Connect your database</h1>
        <p className="text-sm text-muted">One time setup. Paste the details from your Supabase project.</p>
      </div>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm">
        <label className="text-sm font-semibold text-muted" htmlFor="sb-url">
          Project URL
        </label>
        <input
          id="sb-url"
          value={url}
          autoFocus
          spellCheck={false}
          placeholder="https://abcdefghijklmnop.supabase.co"
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), void connect())}
          className={inputClass}
        />
        {problemFor("url") && <p className="mt-1 text-sm font-medium text-danger">{problemFor("url")}</p>}

        <label className="mt-4 block text-sm font-semibold text-muted" htmlFor="sb-key">
          Anon / publishable key
        </label>
        <textarea
          id="sb-key"
          value={anonKey}
          spellCheck={false}
          rows={3}
          placeholder="eyJhbGciOi..."
          onChange={(e) => setAnonKey(e.target.value)}
          className="mt-1 w-full resize-none rounded-xl border-2 border-border bg-surface px-3 py-2 font-mono text-sm outline-none focus:border-primary"
        />
        {problemFor("anonKey") && <p className="mt-1 text-sm font-medium text-danger">{problemFor("anonKey")}</p>}

        <p className="mt-3 rounded-lg bg-surface-2 p-3 text-xs text-muted">
          Find both under <span className="font-semibold text-text">Settings → API</span> in your Supabase
          dashboard. Use the <span className="font-semibold text-text">anon</span> key, not the service-role
          key: the anon key is safe to keep on a till, the service-role key is not.
        </p>

        <p
          role="status"
          className={`mt-3 min-h-5 text-sm font-medium ${
            status ? (status.ok ? "text-success" : "text-danger") : "text-muted"
          }`}
        >
          {status?.message ?? ""}
        </p>

        <div className="mt-1 flex gap-2">
          <Button variant="primary" className="h-12 flex-1 text-base" onClick={connect} disabled={busy}>
            {busy ? "Checking…" : existing ? "Test and update" : "Test and connect"}
          </Button>
          {existing && (
            <Button variant="ghost" className="h-12" onClick={disconnect}>
              Disconnect
            </Button>
          )}
        </div>

        <div className="mt-4 flex items-center justify-between text-xs text-muted">
          <Link href="/pos" className="underline-offset-2 hover:underline">
            Run in demo mode instead
          </Link>
          <button
            type="button"
            className="underline-offset-2 hover:underline"
            onClick={() => (onDone ? onDone() : router.push("/pos"))}
          >
            Done
          </button>
        </div>
      </div>

      <details className="mt-4 rounded-xl border border-dashed border-border p-3 text-xs text-muted">
        <summary className="cursor-pointer font-semibold text-text">First time here? Prepare the database</summary>
        <ol className="mt-2 list-decimal space-y-1 pl-4">
          <li>Create a project at supabase.com.</li>
          <li>
            In the SQL editor, run every file in <code className="font-mono">supabase/migrations</code> in
            order, starting with <code className="font-mono">0001_core.sql</code> and finishing with{" "}
            <code className="font-mono">0005_core_schema.sql</code>.
          </li>
          <li>Come back here and paste the URL and anon key.</li>
        </ol>
      </details>
    </div>
  );
}
