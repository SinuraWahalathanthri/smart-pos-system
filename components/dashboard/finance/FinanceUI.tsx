"use client";

import type { ReactNode } from "react";
import { AlertTriangle, Info, Loader2 } from "lucide-react";
import { formatMoney } from "@/lib/money";
import type { Period } from "@/lib/finance";

/**
 * The pieces every finance screen shares.
 *
 * Kept together rather than duplicated per screen because these are the components that carry the
 * honesty rules: a figure is never shown without saying whether it is exact, and a period always
 * says which dates it covers.
 */

export function Money({ cents, muted = false }: { cents: number | null | undefined; muted?: boolean }) {
  if (cents === null || cents === undefined) return <span className="text-muted">—</span>;
  return <span className={`tabular-nums ${muted ? "text-muted" : ""}`}>{formatMoney(cents)}</span>;
}

/** A headline number with its label, and an optional note that qualifies it. */
export function Stat({
  label,
  value,
  hint,
  tone = "default",
  estimate = false,
}: {
  label: string;
  value: number;
  hint?: string;
  tone?: "default" | "good" | "bad" | "muted";
  estimate?: boolean;
}) {
  const colour =
    tone === "good" ? "text-success" : tone === "bad" ? "text-danger" : tone === "muted" ? "text-muted" : "text-text";
  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      <p className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-muted">
        {label}
        {estimate && (
          <abbr title="Some costs are missing, so this figure is a floor rather than an exact amount.">
            <Info size={12} aria-label="estimate" />
          </abbr>
        )}
      </p>
      <p className={`mt-1 text-2xl font-semibold ${colour}`}>
        {value < 0 ? "−" : ""}
        {formatMoney(Math.abs(value))}
      </p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded-xl border border-border bg-surface">
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="font-semibold">{title}</h2>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * The banner that stops an estimate being read as a fact.
 *
 * Every screen that shows profit renders this when the figure is not exact. It is not dismissible:
 * a warning that can be hidden is a warning that will be.
 */
export function EstimateNotice({ warnings }: { warnings: string[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="flex gap-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-sm">
      <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={18} />
      <div className="space-y-1">
        {warnings.map((w) => (
          <p key={w}>{w}</p>
        ))}
      </div>
    </div>
  );
}

export function ErrorNote({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
      <span className="text-danger">{message}</span>
      {onRetry && (
        <button className="underline" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function Loading({ what = "figures" }: { what?: string }) {
  return (
    <div className="flex items-center gap-2 p-8 text-sm text-muted">
      <Loader2 className="animate-spin" size={16} /> Loading {what}...
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="p-6 text-center text-sm text-muted">{children}</p>;
}

/** Which dates a screen is reporting on. Always visible, because "profit" means nothing without it. */
export function PeriodLabel({ period }: { period: Period }) {
  return (
    <p className="text-sm text-muted">
      {period.label} · {period.from} to {period.to}
    </p>
  );
}

/**
 * A single horizontal bar, used for category shares. Scaled against the largest value in the set
 * rather than against 100%, because a shop's biggest expense category is rarely a majority.
 */
export function ShareBar({ value, max, tone = "primary" }: { value: number; max: number; tone?: "primary" | "danger" }) {
  const pct = max <= 0 ? 0 : Math.max(2, Math.round((value / max) * 100));
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
      <div
        className={`h-full rounded-full ${tone === "danger" ? "bg-danger" : "bg-primary"}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** A simple table shell: the finance screens are all lists of numbers, and all look the same. */
export function Table({ head, children }: { head: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="border-b border-border text-left text-xs uppercase tracking-wide text-muted">{head}</thead>
        <tbody className="divide-y divide-border">{children}</tbody>
      </table>
    </div>
  );
}
