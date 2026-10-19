"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import Link from "next/link";
import { LayoutDashboard, Lock, LogOut, Moon, Palette, Sun, SunMoon, Volume2, VolumeX, Wifi, WifiOff } from "lucide-react";
import { SHOP_NAME } from "@/lib/config";
import { getDb } from "@/lib/data/db";
import { isMuted, playCue, setMuted } from "@/lib/sound";
import { usePos } from "@/lib/store";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import { useSync } from "@/lib/sync/engine";
import {
  ACCENT_PRESETS,
  getStoredAccent,
  getStoredMode,
  setAccent,
  setMode,
  type ThemeMode,
} from "@/lib/theme";

function ThemeMenu() {
  const [open, setOpen] = useState(false);
  const [mode, setModeState] = useState<ThemeMode>("system");
  const [accent, setAccentState] = useState("#1d4ed8");
  const [muted, setMutedState] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Read the saved choices when the menu opens (browser storage isn't available during server render).
  function toggle() {
    if (!open) {
      setModeState(getStoredMode());
      setAccentState(getStoredAccent());
      setMutedState(isMuted());
    }
    setOpen((o) => !o);
  }

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const modes: { id: ThemeMode; label: string; Icon: typeof Sun }[] = [
    { id: "light", label: "Light", Icon: Sun },
    { id: "dark", label: "Dark", Icon: Moon },
    { id: "system", label: "System", Icon: SunMoon },
  ];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label="Appearance"
        aria-expanded={open}
        onClick={toggle}
        className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
      >
        <Palette size={18} />
      </button>
      {open && (
        <div className="pop-in absolute right-0 top-full z-30 mt-2 w-72 rounded-xl border border-border bg-surface p-4 shadow-[var(--shadow)]">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Theme</p>
          <div className="mb-4 grid grid-cols-3 gap-1.5">
            {modes.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setMode(id);
                  setModeState(id);
                }}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2 text-xs font-semibold ${
                  mode === id ? "border-primary bg-primary-soft text-primary" : "border-border text-muted hover:text-text"
                }`}
              >
                <Icon size={16} />
                {label}
              </button>
            ))}
          </div>
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Accent colour</p>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENT_PRESETS.map((p) => (
              <button
                key={p.hex}
                type="button"
                title={p.name}
                aria-label={p.name}
                aria-pressed={accent.toLowerCase() === p.hex}
                onClick={() => {
                  setAccent(p.hex);
                  setAccentState(p.hex);
                }}
                className={`h-7 w-7 rounded-full border-2 ${accent.toLowerCase() === p.hex ? "border-text" : "border-transparent"}`}
                style={{ background: p.hex }}
              />
            ))}
            <label className="ml-1 flex items-center gap-1.5 text-xs text-muted">
              <input
                type="color"
                value={accent}
                aria-label="Custom accent colour"
                onChange={(e) => {
                  setAccent(e.target.value);
                  setAccentState(e.target.value);
                }}
                className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
              />
              Custom
            </label>
          </div>
          <p className="mt-2 text-xs text-muted">Text contrast is adjusted automatically.</p>
          <button
            type="button"
            onClick={() => {
              setMuted(!muted);
              setMutedState(!muted);
              if (muted) playCue("ok");
            }}
            className="mt-4 flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm font-medium hover:bg-surface-2"
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
            Scan sounds: {muted ? "off" : "on"}
          </button>
        </div>
      )}
    </div>
  );
}

function subscribeOnline(cb: () => void) {
  window.addEventListener("online", cb);
  window.addEventListener("offline", cb);
  return () => {
    window.removeEventListener("online", cb);
    window.removeEventListener("offline", cb);
  };
}

function StatusPill() {
  const router = useRouter();
  const online = useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
  const sync = useSync();
  const pending = useLiveQuery(() => getDb().sales.where("syncStatus").equals("pending").count(), [], 0);
  const failed = useLiveQuery(() => getDb().sales.where("syncStatus").equals("failed").count(), [], 0);

  // What the cashier needs to know, most urgent first.
  let tone = "bg-success-soft text-success";
  // navigator.onLine is only a hint that an interface is up, not that the server is reachable. An
  // installed till can sit on a shop network with no internet and still be "online", which would
  // tell the cashier everything is fine while the queue grows. Once the engine has actually failed
  // to reach the server it says so, and that verdict wins over the browser's guess.
  // "idle" plus a completed cycle is the only evidence the server actually answered: the engine
  // sets idle with lastSyncAt on success, and offline/auth/error when a cycle failed.
  const reachable = sync.state === "idle" && sync.lastSyncAt !== null;
  const certainlyOffline = !online || sync.state === "offline";
  let label = certainlyOffline ? "Offline" : reachable ? "Online" : "Not synced yet";
  let hint = "Sales are saved on this PC first and sync when online";
  if (!isConnected()) {
    tone = "bg-surface-2 text-muted";
    label = "Demo";
    hint = "Not connected to Supabase: sales stay on this PC";
  } else if (failed > 0) {
    tone = "bg-danger-soft text-danger";
    label = `${failed} sale${failed > 1 ? "s" : ""} refused`;
    hint = "The server refused these sales. Ask the owner to check them.";
  } else if (sync.state === "auth") {
    tone = "bg-warning-soft text-warning";
    label = "Sign in again";
    hint = sync.message ?? "Till sign-in expired";
  } else if (certainlyOffline) {
    tone = "bg-warning-soft text-warning";
    label = "Offline";
    hint = "No connection. Selling continues and sales upload later.";
  } else if (sync.state === "error") {
    tone = "bg-danger-soft text-danger";
    label = "Sync problem";
    hint = sync.message ?? "";
  } else if (sync.state === "syncing") {
    label = "Syncing…";
  }

  const Icon = certainlyOffline ? WifiOff : Wifi;
  const body = (
    <>
      <Icon size={14} />
      {label}
      {pending > 0 && <span className="num">· {pending} to upload</span>}
    </>
  );
  const cls = `flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${tone}`;

  if (isConnected() && sync.state === "auth") {
    return (
      <button
        type="button"
        title={hint}
        className={`${cls} underline`}
        onClick={async () => {
          await getSupabase().auth.signOut();
          router.push("/login?till=1");
        }}
      >
        {body}
      </button>
    );
  }
  return (
    <span className={cls} title={hint}>
      {body}
    </span>
  );
}

/** The shop's name from the server (cached for offline), or the placeholder in demo mode. */
function useShopName(): string {
  return useLiveQuery(
    async () => {
      const till = (await getDb().meta.get("till"))?.value as { store?: { name?: string } } | undefined;
      return till?.store?.name ?? SHOP_NAME;
    },
    [],
    SHOP_NAME,
  );
}

function Clock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    const tick = () => setNow(new Date());
    const first = setTimeout(tick, 0);
    const every = setInterval(tick, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(every);
    };
  }, []);
  return <span className="num text-sm text-muted">{now ? now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</span>;
}

export function Header() {
  const session = usePos((s) => s.session);
  const setLocked = usePos((s) => s.setLocked);
  const logout = usePos((s) => s.logout);
  const lines = usePos((s) => s.lines.length);
  const shopName = useShopName();
  // A cashier sells and nothing else, so the way out of the till is not offered to them.
  const canLeaveTill = session?.role === "owner" || session?.role === "supervisor";

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border bg-surface px-4">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-sm font-bold text-primary-fg">
          {shopName[0]}
        </span>
        <span className="font-semibold">{shopName}</span>
      </div>
      <span className="text-sm text-muted">
        {session?.name} <span className="rounded bg-surface-2 px-1.5 py-0.5 text-xs capitalize">{session?.role}</span>
      </span>
      <div className="ml-auto flex items-center gap-1">
        {canLeaveTill && (
          <Link
            href="/dashboard"
            aria-label="Open dashboard"
            title="Dashboard"
            className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-text"
          >
            <LayoutDashboard size={16} />
            <span className="hidden sm:inline">Dashboard</span>
          </Link>
        )}
        <StatusPill />
        <Clock />
        <ThemeMenu />
        <button
          type="button"
          aria-label="Lock till"
          title="Lock (Ctrl+L)"
          onClick={() => setLocked(true)}
          className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text"
        >
          <Lock size={18} />
        </button>
        <button
          type="button"
          aria-label="Sign out"
          title={lines > 0 ? "Finish or hold the current bill first" : "Sign out"}
          disabled={lines > 0}
          onClick={logout}
          className="rounded-md p-2 text-muted hover:bg-surface-2 hover:text-text disabled:opacity-30"
        >
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
