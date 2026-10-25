"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

interface SheetProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Wider variant for the invoice, which has money columns. */
  wide?: boolean;
}

/**
 * Edge-anchored panel for touch screens, where the till has no room for a permanent bill column.
 *
 * On a phone it rises from the bottom (thumb-reachable, and the on-screen keyboard does not cover the
 * whole thing); from `sm` up it slides in from the right. Unlike `Dialog` it deliberately does not
 * trap Enter: these panels are lists you tap, not forms you submit.
 */
export function Sheet({ title, onClose, children, wide = false }: SheetProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    (el.querySelector<HTMLElement>("[data-autofocus]") ?? el).focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape belongs to whatever is on top. A dialog opened over the sheet (the supervisor's
      // approval for a removal) must not take the sheet down with it.
      const modals = document.querySelectorAll('[aria-modal="true"]');
      if (modals[modals.length - 1] !== ref.current) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fade-in fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-stretch sm:justify-end"
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
        className={`sheet-motion flex max-h-[88dvh] w-full flex-col rounded-t-2xl border border-border bg-surface shadow-[var(--shadow)] outline-none sm:max-h-none sm:rounded-none sm:border-y-0 sm:border-r-0 ${
          wide ? "sm:w-[420px]" : "sm:w-[360px]"
        }`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-md p-2 text-muted hover:bg-surface-2"
          >
            <X size={18} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </div>
  );
}
