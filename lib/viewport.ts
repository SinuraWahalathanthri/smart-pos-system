import { useSyncExternalStore } from "react";
import { getStoredDockSide, setDockSide, type DockSide } from "./theme";

/**
 * Below this width the till stops showing the bill beside the grid and moves it into a sheet.
 * Matches Tailwind's `lg` breakpoint, so CSS and JS never disagree about which layout is on screen.
 */
export const COMPACT_MAX_WIDTH = 1023;

export const COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

/** Split out so the boundary can be tested without a DOM. */
export function isCompactWidth(width: number): boolean {
  return width <= COMPACT_MAX_WIDTH;
}

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(COMPACT_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/**
 * True on phones and portrait tablets, where the bill no longer fits beside the grid.
 *
 * `useSyncExternalStore` rather than useEffect+useState: it reads the real value on the very first
 * client render, so the till never paints the desktop two-column layout and then jump to the compact
 * one. The server snapshot is `false`, which matches the desktop-first render.
 */
export function useIsCompact(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COMPACT_QUERY).matches,
    () => false,
  );
}

/** Reads a stored preference and re-reads it when setDockSide-style events fire. */
export function useStoredDockSide(): [DockSide, (s: DockSide) => void] {
  const side = useSyncExternalStore(
    (onChange) => {
      window.addEventListener("pos-dock-side", onChange);
      return () => window.removeEventListener("pos-dock-side", onChange);
    },
    () => getStoredDockSide(),
    () => "right" as DockSide,
  );
  return [side, setDockSide];
}
