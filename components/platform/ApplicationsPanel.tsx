"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, Inbox, MessageSquareWarning, ShieldAlert, XCircle } from "lucide-react";
import {
  BUSINESS_TYPES,
  STATUS_LABEL,
  listApplications,
  registrationSettings,
  reviewApplication,
  setAutoApprove,
  type ApplicationStatus,
  type ReviewApplication,
} from "@/lib/registration";
import { Button, Dialog } from "../ui/Dialog";

type Filter = "open" | ApplicationStatus | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "To review" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
];

/**
 * Vendor applications (0029), for the platform administrator.
 *
 * A decision never touches a shop's trading data: approving only lets the applicant open their own
 * shop through create_store(). Rejecting or asking for information needs a reason, because the
 * applicant reads it on their status page. Every decision is written to platform_audit.
 */
export function ApplicationsPanel({ onPendingCount }: { onPendingCount: (n: number) => void }) {
  const [filter, setFilter] = useState<Filter>("open");
  const [rows, setRows] = useState<ReviewApplication[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReviewApplication | null>(null);
  const [auto, setAuto] = useState<boolean | null>(null);
  const [savingAuto, setSavingAuto] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, pending, settings] = await Promise.all([
        listApplications(filter),
        filter === "open" ? Promise.resolve(null) : listApplications("open"),
        registrationSettings(),
      ]);
      setRows(list);
      onPendingCount((pending ?? list).length);
      setAuto(settings.auto_approve_vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load applications.");
      setRows([]);
    }
  }, [filter, onPendingCount]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggleAuto(on: boolean) {
    setSavingAuto(true);
    try {
      setAuto((await setAutoApprove(on)).auto_approve_vendors);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the setting.");
    } finally {
      setSavingAuto(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-border p-0.5 text-sm">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              className={`rounded-md px-2.5 py-1 ${filter === f.id ? "bg-primary text-primary-fg" : "text-muted hover:bg-surface-2"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-sm" title="New applications from verified emails are approved straight away">
          <input
            type="checkbox"
            checked={auto ?? false}
            disabled={auto === null || savingAuto}
            onChange={(e) => void toggleAuto(e.target.checked)}
          />
          Approve new applications automatically
        </label>
      </div>

      {auto && (
        <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm">
          Auto-approval is on: any verified email can open a shop without a review. Check the Approved list regularly.
        </p>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
          <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
          <p>{error}</p>
        </div>
      )}

      {rows === null ? (
        <p className="p-6 text-center text-sm text-muted">Loading applications...</p>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
          <Inbox className="mx-auto mb-2" size={22} />
          {filter === "open" ? "No applications waiting for review." : "Nothing in this list."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[36rem] text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Business</th>
                <th className="px-3 py-2 font-medium">Owner</th>
                <th className="hidden px-3 py-2 font-medium sm:table-cell">Type</th>
                <th className="px-3 py-2 font-medium">Sent</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} onClick={() => setOpen(a)} className="cursor-pointer border-t border-border hover:bg-surface-2">
                  <td className="px-3 py-2">
                    <p className="font-medium">{a.trading_name || a.legal_name}</p>
                    <p className="text-xs text-muted">
                      {a.country}
                      {a.store_name ? ` · shop: ${a.store_name}` : ""}
                    </p>
                  </td>
                  <td className="px-3 py-2">
                    <p className="num text-xs">{a.owner_email}</p>
                    <p className="text-xs text-muted">{a.owner_name}</p>
                  </td>
                  <td className="hidden px-3 py-2 text-muted sm:table-cell">{typeLabel(a.business_type)}</td>
                  <td className="px-3 py-2 text-muted">{new Date(a.submitted_at).toLocaleDateString()}</td>
                  <td className="px-3 py-2">
                    <StatusChip status={a.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <ReviewDialog
          app={open}
          onClose={() => setOpen(null)}
          onDecided={() => {
            setOpen(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

const typeLabel = (t: string) => BUSINESS_TYPES.find((b) => b.id === t)?.label ?? t;

function StatusChip({ status }: { status: ApplicationStatus }) {
  const style =
    status === "approved"
      ? "bg-success/15 text-success"
      : status === "rejected" || status === "withdrawn"
        ? "bg-surface-2 text-muted"
        : status === "info_requested"
          ? "bg-warning/15 text-warning"
          : "bg-primary-soft text-primary";
  return <span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-xs ${style}`}>{STATUS_LABEL[status]}</span>;
}

function ReviewDialog({
  app,
  onClose,
  onDecided,
}: {
  app: ReviewApplication;
  onClose: () => void;
  onDecided: () => void;
}) {
  const [decision, setDecision] = useState<"approve" | "reject" | "request_info" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const open = app.status === "submitted" || app.status === "info_requested";

  async function decide() {
    if (!decision) return;
    if (decision !== "approve" && !reason.trim()) {
      return setError(decision === "reject" ? "Say why, so the applicant can fix it." : "Say what information you need.");
    }
    setBusy(true);
    setError(null);
    try {
      await reviewApplication(app.id, decision, reason);
      onDecided();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the decision.");
      setBusy(false);
    }
  }

  const details: [string, string | number | null][] = [
    ["Registered name", app.legal_name],
    ["Shop name", app.trading_name],
    ["Type", typeLabel(app.business_type)],
    ["Country", `${app.country} · ${app.currency}`],
    ["Address", app.address],
    ["Business phone", app.phone],
    ["Tax number", app.tax_number],
    ["Registration no.", app.registration_number],
    ["Locations / tills", `${app.locations_count} / ${app.tills_count}`],
    ["Owner", app.owner_name],
    ["Owner email", app.owner_email],
    ["Owner mobile", app.owner_phone],
    ["Terms accepted", `version ${app.terms_version}`],
    ["Sent", new Date(app.submitted_at).toLocaleString()],
  ];

  return (
    <Dialog
      title={app.trading_name || app.legal_name}
      onClose={onClose}
      width="max-w-2xl"
      footer={
        open ? (
          <>
            <Button onClick={onClose} disabled={busy}>
              Close
            </Button>
            {decision && (
              <Button
                variant={decision === "reject" ? "danger" : "primary"}
                onClick={() => void decide()}
                disabled={busy}
              >
                {busy
                  ? "Saving..."
                  : decision === "approve"
                    ? "Confirm approval"
                    : decision === "reject"
                      ? "Reject application"
                      : "Send request"}
              </Button>
            )}
          </>
        ) : (
          <Button onClick={onClose}>Close</Button>
        )
      }
    >
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <StatusChip status={app.status} />
          {app.decision_reason && <span className="text-sm text-muted">“{app.decision_reason}”</span>}
        </div>

        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          {details.map(([k, v]) => (
            <div key={k} className="rounded-lg border border-border bg-surface-2 px-3 py-1.5">
              <dt className="text-xs uppercase text-muted">{k}</dt>
              <dd className="break-words">{v === null || v === "" ? <span className="text-muted">—</span> : v}</dd>
            </div>
          ))}
        </dl>

        {open && (
          <div className="space-y-3 border-t border-border pt-3">
            <p className="text-sm font-medium">Decision</p>
            <div className="grid gap-2 sm:grid-cols-3">
              <Choice
                active={decision === "approve"}
                onClick={() => setDecision("approve")}
                Icon={CheckCircle2}
                label="Approve"
                hint="They can open their shop"
              />
              <Choice
                active={decision === "request_info"}
                onClick={() => setDecision("request_info")}
                Icon={MessageSquareWarning}
                label="Ask for info"
                hint="Sent back to the applicant"
              />
              <Choice
                active={decision === "reject"}
                onClick={() => setDecision("reject")}
                Icon={XCircle}
                label="Reject"
                hint="They may apply again"
              />
            </div>
            {decision && decision !== "approve" && (
              <label className="block">
                <span className="mb-1 block text-sm font-medium">
                  {decision === "reject" ? "Reason (the applicant sees this)" : "What do you need? (the applicant sees this)"}
                </span>
                <textarea
                  className="field min-h-20"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  autoFocus
                  placeholder={decision === "reject" ? "We could not confirm the business registration" : "Please add your VAT number"}
                />
              </label>
            )}
            {error && <p className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm text-danger">{error}</p>}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Choice({
  active,
  onClick,
  Icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  Icon: typeof CheckCircle2;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-start gap-2 rounded-lg border p-2.5 text-left text-sm ${
        active ? "border-primary bg-primary-soft" : "border-border hover:bg-surface-2"
      }`}
    >
      <Icon size={16} className="mt-0.5 shrink-0" />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-xs text-muted">{hint}</span>
      </span>
    </button>
  );
}
