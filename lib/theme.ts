/**
 * Owner-changeable accent, surface tone and light/dark theme (DESIGN.md §3.1b, 0030).
 *
 * The shop's colours are chosen by the owner in Settings and stored on the shop (stores.theme), so
 * every till and dashboard of that shop looks the same. They are copied into localStorage when the
 * shop context loads, which is what lets the <head> script paint them before React starts, offline
 * included. Light/dark stays a per-device choice: a till by a sunny window is not the back office.
 *
 * `applyThemeFromStorage` must stay fully self-contained (no imports, no outer references):
 * it is also inlined into <head> via toString() so the theme is right before first paint.
 */
export type ThemeMode = "light" | "dark" | "system";

export const THEME_KEY = "pos-theme";
export const ACCENT_KEY = "pos-accent";
/** Tillwise indigo. A shop that never chose colours gets the brand look: indigo on the neutral tone. */
export const DEFAULT_ACCENT = "#4f46e5";
export const TONE_KEY = "pos-tone";
/** The shop's default light/dark, used only on a device whose person never chose one. */
export const SHOP_MODE_KEY = "pos-shop-mode";

export type Tone = "warm" | "neutral" | "cool" | "fresh" | "rose" | "midnight";

/** Surface tones. The CSS for each lives in app/globals.css under [data-tone]. */
export const TONES: { id: Tone; name: string; light: string; dark: string }[] = [
  { id: "neutral", name: "Neutral", light: "#f7f7f8", dark: "#1b1b1f" },
  { id: "warm", name: "Warm", light: "#faf8f5", dark: "#201c17" },
  { id: "cool", name: "Cool", light: "#f5f7fa", dark: "#151c28" },
  { id: "fresh", name: "Fresh", light: "#f5f9f6", dark: "#17211b" },
  { id: "rose", name: "Rose", light: "#fbf7f8", dark: "#22181c" },
  { id: "midnight", name: "Midnight", light: "#f4f5fb", dark: "#12152a" },
];

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Blue", hex: "#1d4ed8" },
  { name: "Indigo", hex: "#4f46e5" },
  { name: "Teal", hex: "#0f766e" },
  { name: "Green", hex: "#15803d" },
  { name: "Orange", hex: "#c2410c" },
  { name: "Amber", hex: "#b45309" },
  { name: "Red", hex: "#b91c1c" },
  { name: "Pink", hex: "#be185d" },
  { name: "Plum", hex: "#7e22ce" },
  { name: "Slate", hex: "#475569" },
];

export function applyThemeFromStorage(override?: { mode?: string; accent?: string; tone?: string }): void {
  const root = document.documentElement;
  let mode = override?.mode;
  let accent = override?.accent;
  let tone = override?.tone;
  try {
    mode = mode ?? localStorage.getItem("pos-theme") ?? localStorage.getItem("pos-shop-mode") ?? "system";
    accent = accent ?? localStorage.getItem("pos-accent") ?? "#4f46e5";
    tone = tone ?? localStorage.getItem("pos-tone") ?? "neutral";
  } catch {
    mode = mode ?? "system";
    accent = accent ?? "#4f46e5";
    tone = tone ?? "neutral";
  }
  // Dark surface per tone, so the accent is lightened against the surface it will actually sit on.
  const darkSurfaces: Record<string, [number, number, number]> = {
    warm: [32, 28, 23],
    neutral: [27, 27, 31],
    cool: [21, 28, 40],
    fresh: [23, 33, 27],
    rose: [34, 24, 28],
    midnight: [18, 21, 42],
  };
  if (!darkSurfaces[tone]) tone = "neutral";
  root.setAttribute("data-tone", tone);
  const resolved =
    mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  root.setAttribute("data-theme", resolved);

  const hexToRgb = (h: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h) ?? /^#?([0-9a-f]{6})$/i.exec("4f46e5")!;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const lum = ([r, g, b]: [number, number, number]) => {
    const f = (c: number) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const contrast = (a: [number, number, number], b: [number, number, number]) => {
    const la = lum(a);
    const lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  };
  const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];
  const toHex = (c: [number, number, number]) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");

  const base = hexToRgb(accent);
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const surface: [number, number, number] = resolved === "dark" ? darkSurfaces[tone] : [255, 255, 255];

  let primary = base;
  if (resolved === "light") {
    // Button text is white, so darken until white text reads at 4.5:1.
    for (let t = 0; t <= 1 && contrast(primary, white) < 4.5; t += 0.05) primary = mix(base, black, t);
  } else {
    // On the dark surface the accent must stay visible (3:1), so lighten.
    for (let t = 0; t <= 1 && contrast(primary, surface) < 3; t += 0.05) primary = mix(base, white, t);
  }
  const fg: [number, number, number] = contrast(primary, white) >= contrast(primary, black) ? white : black;
  const soft = mix(primary, surface, resolved === "dark" ? 0.75 : 0.88);

  root.style.setProperty("--primary", toHex(primary));
  root.style.setProperty("--primary-fg", toHex(fg));
  root.style.setProperty("--primary-soft", toHex(soft));
}

export function getStoredMode(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function getStoredAccent(): string {
  try {
    return localStorage.getItem(ACCENT_KEY) ?? DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT;
  }
}

export function setMode(mode: ThemeMode): void {
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage blocked: the choice just won't persist */
  }
  applyThemeFromStorage({ mode });
}

export function setAccent(hex: string): void {
  try {
    localStorage.setItem(ACCENT_KEY, hex);
  } catch {
    /* storage blocked */
  }
  applyThemeFromStorage({ accent: hex });
}

export function getStoredTone(): Tone {
  try {
    const v = localStorage.getItem(TONE_KEY);
    return TONES.some((t) => t.id === v) ? (v as Tone) : "neutral";
  } catch {
    return "neutral";
  }
}

export function setTone(tone: Tone): void {
  try {
    localStorage.setItem(TONE_KEY, tone);
  } catch {
    /* storage blocked */
  }
  applyThemeFromStorage({ tone });
}

/**
 * Adopt the shop's saved colours (stores.theme). Called whenever the shop context loads, on the
 * dashboard and the till. A shop that never chose colours keeps whatever the device already shows.
 */
export function applyShopTheme(theme: { accent?: string; tone?: string; mode?: string } | null | undefined): void {
  if (!theme) return;
  try {
    if (theme.accent) localStorage.setItem(ACCENT_KEY, theme.accent);
    if (theme.tone) localStorage.setItem(TONE_KEY, theme.tone);
    if (theme.mode) localStorage.setItem(SHOP_MODE_KEY, theme.mode);
    else localStorage.removeItem(SHOP_MODE_KEY);
  } catch {
    /* storage blocked: still apply for this page */
  }
  applyThemeFromStorage({ accent: theme.accent, tone: theme.tone });
}

/**
 * WCAG contrast of white text on the accent as the app will actually draw it (after darkening), so
 * Settings can say plainly whether a chosen colour reads well on a button.
 */
export function accentContrast(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return 1;
  const n = parseInt(m[1], 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const l = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  return 1.05 / (l + 0.05);
}

/** Source for the inline <head> script. */
export const themeBootstrapScript = `(${applyThemeFromStorage.toString()})()`;

/**
 * Which edge the mobile dock sits on. A shopkeeper holding the phone in one hand needs the invoice
 * button under that thumb, and which hand that is depends on the person, not the device.
 */
export const DOCK_SIDE_KEY = "pos-dock-side";
export type DockSide = "left" | "right";

export function getStoredDockSide(): DockSide {
  try {
    return localStorage.getItem(DOCK_SIDE_KEY) === "left" ? "left" : "right";
  } catch {
    return "right";
  }
}

export function setDockSide(side: DockSide): void {
  try {
    localStorage.setItem(DOCK_SIDE_KEY, side);
  } catch {
    /* storage blocked: the choice just won't persist */
  }
  window.dispatchEvent(new Event("pos-dock-side"));
}
