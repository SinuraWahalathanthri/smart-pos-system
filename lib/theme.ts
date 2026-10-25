/**
 * Owner-changeable accent + light/dark theme (DESIGN.md §3.1b).
 *
 * `applyThemeFromStorage` must stay fully self-contained (no imports, no outer references):
 * it is also inlined into <head> via toString() so the theme is right before first paint.
 */
export type ThemeMode = "light" | "dark" | "system";

export const THEME_KEY = "pos-theme";
export const ACCENT_KEY = "pos-accent";
export const DEFAULT_ACCENT = "#1d4ed8";

export const ACCENT_PRESETS: { name: string; hex: string }[] = [
  { name: "Blue", hex: "#1d4ed8" },
  { name: "Teal", hex: "#0f766e" },
  { name: "Green", hex: "#15803d" },
  { name: "Chilli", hex: "#c2410c" },
  { name: "Turmeric", hex: "#b45309" },
  { name: "Plum", hex: "#7e22ce" },
  { name: "Slate", hex: "#475569" },
];

export function applyThemeFromStorage(override?: { mode?: string; accent?: string }): void {
  const root = document.documentElement;
  let mode = override?.mode;
  let accent = override?.accent;
  try {
    mode = mode ?? localStorage.getItem("pos-theme") ?? "system";
    accent = accent ?? localStorage.getItem("pos-accent") ?? "#1d4ed8";
  } catch {
    mode = mode ?? "system";
    accent = accent ?? "#1d4ed8";
  }
  const resolved =
    mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches)
      ? "dark"
      : "light";
  root.setAttribute("data-theme", resolved);

  const hexToRgb = (h: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h) ?? /^#?([0-9a-f]{6})$/i.exec("1d4ed8")!;
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
  const surface: [number, number, number] = resolved === "dark" ? [32, 28, 23] : [255, 255, 255];

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
