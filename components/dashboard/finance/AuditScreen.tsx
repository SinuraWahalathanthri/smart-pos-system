"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Download, ShieldCheck } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney } from "@/lib/money";
import { monthPeriod, previousPeriod, type AuditEntry, type FinanceAlert, type Period } from "@/lib/finance";
import { downloadCsv, exportFilename, toCsv } from "@/lib/export";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { useShop } from "../useShop";
import { Empty, ErrorNote, Loading, Money, PeriodLabel, Section } from "./FinanceUI";
import { MonthPicker } from "./FinanceScreen";

/**
 * Business auditing: the questions worth asking, and the trail that answers them.
 *
 * Two halves, deliberately separate.
 *
 * The alerts at the top are patterns that are often innocent — a large fuel bill in harvest week, the
 * same diesel receipt entered twice, a price changed with no reason written down. Every one is
 * labelled "review" and phrased as a question with the evidence attached. The app never blocks, never
 * reverses and never accuses: it has no way to tell a mistake from a decision.
 *
 * The trail below is the plain record: who changed what, when, and why. It is append-only at the
 * database level, so this screen can only ever read it.
 */
export function AuditScreen() {
  const { ctx } = useShop();
  return (
    <DashboardShell>
      {ctx?.role === "owner" ? <AuditBody /> : <NotAllowed what="the audit trail" role={ctx?.role} />}
    </DashboardShell>
  );
}

function AuditBody() {
  const [period, setPeriod] = useState<Period>(() => monthPeriod());
  const [alerts, setAlerts] = useState<FinanceAlert[]>([]);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [actions, setActions] = useState<{ action: string; occurrences: number }[]>([]);
  const [action, setAction] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async (p: Period) => {
    setLoading(true);
    const sb = getSupabase();
    const fromTs = `${p.from}T00:00:00`;
    const toTs = new Date(new Date(`${p.to}T00:00:00`).getTime() + 86_400_000).toISOString();
    const [alertRes, trailRes, actionRes] = await Promise.all([
      sb.rpc("finance_alerts", { p_from: p.from, p_to: p.to }),
      sb.rpc("audit_trail", { p_from: fromTs, p_to: toTs, p_limit: 300 }),
      sb.rpc("audit_actions"),
    ]);
    setLoading(false);
    if (trailRes.error) return setError(trailRes.error.message);
    setError(null);
    setAlerts((alertRes.error ? [] : alertRes.data) as FinanceAlert[]);
    setEntries((trailRes.data as AuditEntry[] | null) ?? []);
    setActions((actionRes.error ? [] : actionRes.data) as { action: string; occurrences: number }[]);
  }, []);

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const visible = useMemo(
    () => (action ? entries.filter((e) => e.action === action) : entries),
    [entries, action],
  );

  function exportTrail() {
    const csv = toCsv(visible, [
      { header: "When", value: (e) => new Date(e.created_at).toISOString() },
      { header: "Who", value: (e) => e.actor },
      { header: "Action", value: (e) => e.action },
      { header: "Record", value: (e) => `${e.entity ?? ""} ${e.entity_id ?? ""}`.trim() },
      { header: "Reason", value: (e) => e.reason },
      { header: "Before", value: (e) => (e.before ? JSON.stringify(e.before) : "") },
      { header: "After", value: (e) => (e.after ? JSON.stringify(e.after) : "") },
    ]);
    downloadCsv(exportFilename("audit-trail", period.from, period.to), csv);
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Audit</h1>
          <PeriodLabel period={period} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <MonthPicker period={period} onChange={setPeriod} />
          <button
            className="inline-flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
            onClick={exportTrail}
            disabled={visible.length === 0}
          >
            <Download size={15} /> Export trail
          </button>
        </div>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load(period)} />}

      <Section
        title={`Worth a look (${alerts.length})`}
        actions={<span className="text-xs text-muted">previous period: {previousPeriod(period).label}</span>}
      >
        {loading ? (
          <Loading what="alerts" />
        ) : alerts.length === 0 ? (
          <div className="flex items-center gap-2 text-sm text-muted">
            <ShieldCheck className="text-success" size={18} />
            Nothing unusual in {period.label}. That means no pattern matched, not that nothing happened — the
            trail below is the full record.
          </div>
        ) : (
          <>
            <ul className="divide-y divide-border">
              {alerts.map((a, i) => (
                <li key={`${a.code}-${a.entity_id ?? i}`} className="flex gap-3 py-3">
                  <AlertTriangle className="mt-0.5 shrink-0 text-warning" size={16} />
                  <div className="flex-1">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <p className="font-medium">{a.headline}</p>
                      {a.amount_cents !== null && <Money cents={a.amount_cents} muted />}
                    </div>
                    <p className="text-sm text-muted">{a.detail}</p>
                    <p className="mt-1 text-xs text-muted">
                      {a.happened_on} · {a.entity.replace(/_/g, " ")}
                      {a.entity_id && <span className="ml-1 font-mono text-[10px]">{a.entity_id.slice(0, 8)}</span>}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
              These are patterns, not findings. A large bill in a busy week, or two customers buying the same
              thing, will look the same as a mistake. Nothing has been blocked or reversed.
            </p>
          </>
        )}
      </Section>

      <Section
        title={`Recorded activity (${visible.length})`}
        actions={
          <div className="flex items-center gap-1.5">
            <span className="text-xs font-medium uppercase tracking-wide text-muted">Action</span>
            <select
              className="field w-auto"
              value={action}
              onChange={(e) => setAction(e.target.value)}
              aria-label="Filter by action"
            >
              <option value="">Everything</option>
              {actions.map((a) => (
                <option key={a.action} value={a.action}>
                  {a.action.replace(/_/g, " ")} ({a.occurrences})
                </option>
              ))}
            </select>
          </div>
        }
      >
        {loading ? (
          <Loading what="the trail" />
        ) : visible.length === 0 ? (
          <Empty>Nothing recorded in {period.label}.</Empty>
        ) : (
          <ul className="divide-y divide-border text-sm">
            {visible.map((e) => {
              const open = expanded === e.id;
              return (
                <li key={e.id} className="py-2">
                  <button
                    className="flex w-full items-start gap-2 text-left"
                    onClick={() => setExpanded(open ? null : e.id)}
                    aria-expanded={open}
                  >
                    <ChevronDown
                      size={15}
                      className={`mt-1 shrink-0 text-muted transition-transform ${open ? "rotate-180" : ""}`}
                    />
                    <span className="flex-1">
                      <span className="font-medium">{e.action.replace(/_/g, " ")}</span>
                      <span className="ml-2 text-muted">{e.actor ?? "unknown user"}</span>
                      <span className="block text-xs text-muted">
                        {new Date(e.created_at).toLocaleString("en-GB")}
                        {e.entity && ` · ${e.entity.replace(/_/g, " ")}`}
                        {e.reason && ` · "${e.reason}"`}
                      </span>
                    </span>
                  </button>
                  {open && (
                    <div className="mt-2 grid gap-2 pl-7 text-xs sm:grid-cols-2">
                      <Change label="Before" value={e.before} />
                      <Change label="After" value={e.after} />
                      {e.approver && (
                        <p className="text-muted sm:col-span-2">
                          Approved by <span className="text-text">{e.approver}</span>
                        </p>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="mt-3 border-t border-border pt-3 text-xs text-muted">
          The trail is append-only: entries cannot be edited or removed, including by the owner. Values are
          recorded in cents.
        </p>
      </Section>
    </div>
  );
}

function Change({ label, value }: { label: string; value: Record<string, unknown> | null }) {
  if (!value) return <p className="text-muted">{label}: —</p>;
  const rows = Object.entries(value).filter(([, v]) => v !== null && v !== undefined && typeof v !== "object");
  return (
    <div>
      <p className="mb-1 text-muted">{label}</p>
      <dl className="space-y-0.5">
        {rows.slice(0, 12).map(([k, v]) => (
          <div key={k} className="flex justify-between gap-2">
            <dt className="text-muted">{k.replace(/_/g, " ")}</dt>
            <dd className="tabular-nums">
              {typeof v === "number" && k.endsWith("_cents") ? formatMoney(v) : String(v)}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
