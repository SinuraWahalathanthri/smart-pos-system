"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface DialogProps {
  title: string;
  onClose: () => void;
  /** Enter (when focus isn't on a button) confirms. */
  onConfirm?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  tone?: "default" | "danger";
  /** Extra key handling (runs before the defaults). Return true if handled. */
  onKey?: (e: React.KeyboardEvent) => boolean | void;
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Enter confirms, Esc cancels, Tab stays inside (DESIGN.md §7). */
export function Dialog({ title, onClose, onConfirm, children, footer, width = "max-w-lg", tone = "default", onKey }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const target = el.querySelector<HTMLElement>("[data-autofocus]") ?? el;
    target.focus();
    if (target instanceof HTMLInputElement) target.select();
  }, []);

  function handleKey(e: React.KeyboardEvent) {
    if (onKey?.(e)) {
      e.stopPropagation();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === "Enter" && onConfirm) {
      const t = e.target as HTMLElement;
      if (t.tagName !== "BUTTON" && t.tagName !== "TEXTAREA" && !t.hasAttribute("data-no-enter")) {
        e.preventDefault();
        e.stopPropagation();
        onConfirm();
      }
      return;
    }
    if (e.key === "Tab" && ref.current) {
      const items = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={handleKey}
        className={`pop-in w-full ${width} rounded-xl border bg-surface shadow-[var(--shadow)] outline-none ${
          tone === "danger" ? "border-danger" : "border-border"
        }`}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-1.5 text-muted hover:bg-surface-2"
          >
            <X size={18} />
          </button>
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Keycap({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={`keycap-hint inline-flex min-w-6 items-center justify-center rounded-md border border-border border-b-2 bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-muted ${className}`}
    >
      {children}
    </kbd>
  );
}

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  keycap?: string;
};

export function Button({ variant = "secondary", keycap, className = "", children, ...rest }: BtnProps) {
  const styles = {
    primary: "bg-primary text-primary-fg hover:brightness-110",
    secondary: "border border-border bg-surface-2 hover:bg-border/60",
    danger: "bg-danger text-white hover:brightness-110",
    ghost: "hover:bg-surface-2",
  }[variant];
  return (
    <button
      type="button"
      {...rest}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold transition disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
      {keycap && (
        <span className="keycap-hint rounded border border-current/30 px-1 font-mono text-[10px] opacity-80">{keycap}</span>
      )}
    </button>
  );
}
