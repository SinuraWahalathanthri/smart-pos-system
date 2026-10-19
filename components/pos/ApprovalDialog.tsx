"use client";

import { useState } from "react";
import { CheckCircle2, ShieldAlert } from "lucide-react";
import { approve, checkBadge } from "@/lib/data/access";
import { playCue } from "@/lib/sound";
import { usePos } from "@/lib/store";
import { useShake } from "@/lib/useShake";
import { Button, Dialog } from "../ui/Dialog";

/**
 * Supervisor approval: scan the ID badge, then type the PIN. Both are always required.
 * The signed-in owner approves with their PIN only (still recorded by name).
 * Online the server checks everything and counts wrong PINs; offline a cached copy is used (lib/data/access.ts).
 */
export function ApprovalDialog() {
  const approval = usePos((s) => s.approval)!;
  const session = usePos((s) => s.session);
  const resolveApproval = usePos((s) => s.resolveApproval);

  const ownerSelf = session?.role === "owner";
  const [badge, setBadge] = useState<{ code: string; name: string } | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [shakeRef, shake] = useShake<HTMLDivElement>();
  const [busy, setBusy] = useState(false);

  const stage: "badge" | "pin" = ownerSelf || badge ? "pin" : "badge";

  function fail(msg: string) {
    setError(msg);
    setValue("");
    shake();
    playCue("error");
  }

  async function submit() {
    if (busy || value.trim() === "") return;
    setBusy(true);
    try {
      if (stage === "badge") {
        const res = await checkBadge(value);
        if (!res.ok) return fail(res.message);
        if (res.locked) return fail(`${res.name} is locked after too many wrong PINs. Try again in a few minutes.`);
        setBadge({ code: value.trim(), name: res.name });
        setValue("");
        setError(null);
        playCue("attention");
        return;
      }

      const res = await approve({
        badge: badge?.code,
        pin: value,
        action: approval.description,
        staffCode: session?.code,
      });
      if (res.ok) {
        playCue("ok");
        resolveApproval(res.user);
        return;
      }
      fail(res.message);
      if (res.locked) setTimeout(() => resolveApproval(null), 1500);
    } finally {
      setBusy(false);
    }
  }

  const step = (n: number, label: string, done: boolean, active: boolean) => (
    <div className={`flex items-center gap-2 ${active ? "text-text" : "text-muted"}`}>
      {done ? (
        <CheckCircle2 size={20} className="text-success" />
      ) : (
        <span className={`grid h-5 w-5 place-items-center rounded-full border text-xs font-bold ${active ? "border-primary text-primary" : "border-border"}`}>
          {n}
        </span>
      )}
      <span className={`font-medium ${active ? "" : "opacity-70"}`}>{label}</span>
      {done && badge && n === 1 && <span className="ml-auto text-sm font-semibold text-success">{badge.name}</span>}
    </div>
  );

  return (
    <Dialog
      title="Supervisor approval needed"
      onClose={() => resolveApproval(null)}
      onConfirm={submit}
      tone="danger"
      width="max-w-md"
      footer={
        <>
          <Button onClick={() => resolveApproval(null)} keycap="Esc">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} keycap="Enter" disabled={busy || value.trim() === ""}>
            {stage === "badge" ? "Check badge" : "Approve"}
          </Button>
        </>
      }
    >
      <div className="mb-4 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-danger">
        <ShieldAlert size={20} className="mt-0.5 shrink-0" />
        <p className="font-medium">{approval.description}</p>
      </div>

      <div className="mb-3 space-y-2">
        {!ownerSelf && step(1, "Scan supervisor badge", !!badge, stage === "badge")}
        {step(ownerSelf ? 1 : 2, ownerSelf ? "Owner PIN" : "Enter PIN", false, stage === "pin")}
      </div>

      <div ref={shakeRef}>
        <input
          data-autofocus
          type={stage === "pin" ? "password" : "text"}
          inputMode={stage === "pin" ? "numeric" : "text"}
          autoComplete="off"
          value={value}
          onChange={(e) => setValue(stage === "pin" ? e.target.value.replace(/\D/g, "").slice(0, 8) : e.target.value)}
          aria-label={stage === "pin" ? "Supervisor PIN" : "Scan supervisor badge"}
          placeholder={stage === "pin" ? "● ● ● ●" : "Scan the badge barcode…"}
          className="num h-14 w-full rounded-xl border-2 border-primary bg-surface px-4 text-center text-2xl tracking-[0.4em] outline-none placeholder:tracking-normal placeholder:text-muted/60"
        />
      </div>
      <p role="alert" className={`mt-2 min-h-5 text-sm font-medium ${error ? "text-danger" : "text-transparent"}`}>
        {error ?? "."}
      </p>
    </Dialog>
  );
}
