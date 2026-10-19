"use client";

import { useEffect } from "react";
import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import { usePos } from "@/lib/store";

const STYLE = {
  info: "border-border bg-surface text-text",
  success: "border-success bg-success-soft text-success",
  warn: "border-warning bg-warning-soft text-warning",
  error: "border-danger bg-danger-soft text-danger",
} as const;

const ICON = { info: Info, success: CheckCircle2, warn: AlertTriangle, error: XCircle } as const;

/** Non-blocking messages; never covers the bill (bottom-centre, above the shortcut bar). */
export function Toaster() {
  const toast = usePos((s) => s.toast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => {
      if (usePos.getState().toast?.id === toast.id) usePos.setState({ toast: null });
    }, 3200);
    return () => clearTimeout(t);
  }, [toast]);

  if (!toast) return null;
  const Icon = ICON[toast.kind];
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-14 z-50 flex justify-center px-4">
      <div
        role="status"
        aria-live="polite"
        className={`pop-in pointer-events-auto flex max-w-xl items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium shadow-[var(--shadow)] ${STYLE[toast.kind]}`}
      >
        <Icon size={18} className="shrink-0" />
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
