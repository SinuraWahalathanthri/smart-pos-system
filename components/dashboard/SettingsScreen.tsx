"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Loader2, RotateCcw } from "lucide-react";
import {
  BUSINESS_PROFILES,
  FEATURES,
  effectiveFeatures,
  featureOverrides,
  profileFor,
  type Features,
  type Tone,
} from "@/lib/business";
import { getSupabase } from "@/lib/supabase/client";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  TONES,
  accentContrast,
  applyShopTheme,
  applyThemeFromStorage,
  type ThemeMode,
} from "@/lib/theme";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { SHOP_CHANGED, useShop, type Shop } from "./useShop";

export function SettingsScreen() {
  const { ctx } = useShop();
  return (
    <DashboardShell>
      {ctx?.store && ctx.role === "owner" ? <SettingsForm shop={ctx.store} /> : ctx && <NotAllowed what="settings" role={ctx.role} />}
    </DashboardShell>
  );
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * The owner's business settings (save_shop_profile, 0030): what kind of business this is, which
 * features it uses, and its colours. All three are saved together so the shop never ends up half
 * changed, and colours preview on the whole page as they are picked.
 */
function SettingsForm({ shop }: { shop: Shop }) {
  const savedType = shop.business_type ?? null;
  // null = a shop from before business types; it keeps its legacy features until a type is chosen.
  const [type, setType] = useState<string | null>(savedType);
  const [features, setFeatures] = useState<Features>(() => effectiveFeatures(savedType, shop.features));
  const [accent, setAccent] = useState(shop.theme?.accent ?? DEFAULT_ACCENT);
  const [hexText, setHexText] = useState(shop.theme?.accent ?? DEFAULT_ACCENT);
  const [tone, setTone] = useState<Tone>((shop.theme?.tone as Tone) ?? "neutral");
  const [mode, setMode] = useState<ThemeMode>(shop.theme?.mode ?? "system");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Preview on the real page. Leaving without saving puts the stored colours back.
  useEffect(() => {
    applyThemeFromStorage({ accent, tone });
  }, [accent, tone]);
  useEffect(() => () => applyThemeFromStorage(), []);

  const defaults = useMemo(() => effectiveFeatures(type, null), [type]);
  const profile = profileFor(type);

  function pickType(id: string) {
    setType(id);
    // A new type brings its own defaults; the owner can still change each one below.
    setFeatures(effectiveFeatures(id, null));
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    const theme = { accent, tone, ...(mode !== "system" ? { mode } : {}) };
    const { error: err } = await getSupabase().rpc("save_shop_profile", {
      p_profile: { ...(type ? { business_type: type } : {}), features: featureOverrides(type, features), theme },
    });
    setBusy(false);
    if (err) return setError(err.message);
    applyShopTheme(theme);
    setSaved(true);
    window.dispatchEvent(new Event(SHOP_CHANGED));
  }

  const contrast = accentContrast(accent);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-muted">What kind of business this is, what it uses, and how it looks. Applies to every till.</p>
      </div>

      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="font-semibold">Type of business</h2>
        <p className="mb-3 text-sm text-muted">Sets sensible defaults for products, units and features. Nothing already recorded changes.</p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label="Type of business">
          {BUSINESS_PROFILES.map((p) => (
            <button
              key={p.id}
              type="button"
              role="radio"
              aria-checked={type === p.id}
              onClick={() => pickType(p.id)}
              className={`rounded-lg border-2 p-3 text-left transition ${
                type === p.id ? "border-primary bg-primary-soft" : "border-border hover:border-muted"
              }`}
            >
              <span className="block text-sm font-semibold">{p.label}</span>
              <span className="block text-xs text-muted">{p.hint}</span>
            </button>
          ))}
        </div>
        {savedType === null && (
          <p className="mt-2 text-xs text-muted">
            This shop was set up before business types existed, so it has kept every feature it used. Choosing a type
            here is optional.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <h2 className="font-semibold">Features</h2>
        <p className="mb-3 text-sm text-muted">
          Switching one off only tidies the screens: products and history already recorded are kept.
        </p>
        <div className="divide-y divide-border">
          {FEATURES.map((f) => (
            <label key={f.id} className="flex cursor-pointer items-start gap-3 py-2.5">
              <input
                type="checkbox"
                className="mt-1"
                checked={features[f.id]}
                onChange={(e) => {
                  setFeatures((cur) => ({ ...cur, [f.id]: e.target.checked }));
                  setSaved(false);
                }}
              />
              <span className="flex-1 text-sm">
                <span className="font-medium">{f.label}</span>
                {features[f.id] !== defaults[f.id] && (
                  <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-muted">
                    changed
                  </span>
                )}
                <span className="block text-xs text-muted">{f.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Colours</h2>
            <p className="text-sm text-muted">Previewed on this page as you choose. Saved for every till and screen in this shop.</p>
          </div>
          <button
            type="button"
            onClick={() => {
              setAccent(profile.theme.accent);
              setHexText(profile.theme.accent);
              setTone(profile.theme.tone);
              setSaved(false);
            }}
            className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-sm text-primary hover:bg-surface-2"
          >
            <RotateCcw size={14} /> Suggested for {profile.label.toLowerCase()}
          </button>
        </div>

        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Accent</p>
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
                setHexText(p.hex);
                setSaved(false);
              }}
              className={`grid h-9 w-9 place-items-center rounded-full border-2 ${
                accent.toLowerCase() === p.hex ? "border-text" : "border-transparent"
              }`}
              style={{ background: p.hex }}
            >
              {accent.toLowerCase() === p.hex && <Check size={16} className="text-white" />}
            </button>
          ))}
          <label className="ml-1 flex items-center gap-2 text-sm text-muted">
            <input
              type="color"
              value={HEX.test(accent) ? accent : DEFAULT_ACCENT}
              aria-label="Custom accent colour"
              onChange={(e) => {
                setAccent(e.target.value);
                setHexText(e.target.value);
                setSaved(false);
              }}
              className="h-9 w-11 cursor-pointer rounded border border-border bg-transparent"
            />
            <input
              className="field w-28 font-mono"
              value={hexText}
              aria-label="Accent colour as hex"
              maxLength={7}
              onChange={(e) => {
                const v = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
                setHexText(v);
                if (HEX.test(v)) {
                  setAccent(v.toLowerCase());
                  setSaved(false);
                }
              }}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">
          {contrast >= 4.5
            ? "Reads well with white text."
            : "A light colour: buttons use a deeper shade of it so their text stays readable."}
        </p>

        <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wider text-muted">Background tone</p>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {TONES.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={tone === t.id}
              onClick={() => {
                setTone(t.id);
                setSaved(false);
              }}
              className={`overflow-hidden rounded-lg border-2 text-xs font-semibold ${
                tone === t.id ? "border-primary" : "border-border"
              }`}
            >
              <span className="flex h-10">
                <span className="flex-1" style={{ background: t.light }} />
                <span className="flex-1" style={{ background: t.dark }} />
              </span>
              <span className="block py-1">{t.name}</span>
            </button>
          ))}
        </div>

        <p className="mb-2 mt-5 text-xs font-bold uppercase tracking-wider text-muted">Default light or dark</p>
        <div className="flex gap-2">
          {(["system", "light", "dark"] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => {
                setMode(m);
                setSaved(false);
              }}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                mode === m ? "border-primary bg-primary-soft text-primary" : "border-border text-muted"
              }`}
            >
              {m === "system" ? "Follow the device" : m === "light" ? "Light" : "Dark"}
            </button>
          ))}
        </div>
        <p className="mt-1 text-xs text-muted">Each till can still switch light and dark for itself.</p>

        <div className="mt-5 rounded-xl border border-border bg-bg p-3" aria-label="Preview">
          <p className="mb-2 text-xs font-bold uppercase tracking-wider text-muted">Preview</p>
          <div className="flex flex-wrap items-center gap-3">
            <span className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg">Pay</span>
            <span className="rounded-lg bg-primary-soft px-3 py-2 text-sm font-medium text-primary">Selected</span>
            <span className="rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              {profile.example.product} <span className="text-muted">· 2 in stock</span>
            </span>
            <span className="rounded bg-success-soft px-2 py-1 text-xs font-semibold text-success">Paid</span>
            <span className="rounded bg-warning-soft px-2 py-1 text-xs font-semibold text-warning">Low</span>
          </div>
        </div>
      </section>

      <div className="sticky bottom-0 flex items-center gap-3 border-t border-border bg-bg py-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={busy}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={14} />} Save settings
        </button>
        {saved && <span className="text-sm text-success">Saved. Tills pick this up on their next sync.</span>}
      </div>
    </div>
  );
}
