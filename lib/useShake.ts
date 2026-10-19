"use client";

import { useCallback, useRef } from "react";

/**
 * Replays the "shake" animation on an element without re-creating it, so the input inside keeps
 * keyboard focus (re-mounting it would drop focus and swallow the next scan).
 */
export function useShake<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const shake = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.classList.remove("shake");
    void el.offsetWidth; // restart the CSS animation
    el.classList.add("shake");
  }, []);
  return [ref, shake] as const;
}
