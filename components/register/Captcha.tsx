"use client";

import { useEffect, useRef } from "react";
import { CAPTCHA_SITE_KEY } from "@/lib/registration";

type Turnstile = {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  remove: (id: string) => void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/**
 * Cloudflare Turnstile, drawn only when NEXT_PUBLIC_TURNSTILE_SITE_KEY is set.
 *
 * The token goes to Supabase Auth with signUp(); Supabase checks it against the secret configured in
 * the project (Authentication → Attack Protection). Without a site key nothing is drawn and sign-up
 * relies on Supabase's own rate limits and email verification.
 */
export function Captcha({ onToken }: { onToken: (token: string | null) => void }) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CAPTCHA_SITE_KEY || !box.current) return;
    let widget: string | null = null;
    let cancelled = false;

    const draw = () => {
      if (cancelled || !box.current || !window.turnstile) return;
      widget = window.turnstile.render(box.current, {
        sitekey: CAPTCHA_SITE_KEY,
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(null),
        "error-callback": () => onToken(null),
      });
    };

    if (window.turnstile) draw();
    else {
      let tag = document.querySelector<HTMLScriptElement>(`script[src="${SCRIPT}"]`);
      if (!tag) {
        tag = document.createElement("script");
        tag.src = SCRIPT;
        tag.async = true;
        document.head.appendChild(tag);
      }
      tag.addEventListener("load", draw);
    }
    return () => {
      cancelled = true;
      if (widget && window.turnstile) window.turnstile.remove(widget);
    };
  }, [onToken]);

  if (!CAPTCHA_SITE_KEY) return null;
  return <div ref={box} className="min-h-16" />;
}
