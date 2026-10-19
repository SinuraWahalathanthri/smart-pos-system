"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Phone, Star, UserPlus, UserRound } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import { usePos } from "@/lib/store";
import { Dialog, Button } from "../ui/Dialog";
import type { Customer } from "./CustomerDialog";

export type CustomerCard = Customer & {
  points: number;
  spend_cents: number;
  visits: number;
  bottles_out: number;
};

/**
 * Who is this sale for? Asked before the bill starts, not at the end.
 *
 * The number is the first thing typed because it is the only thing the customer reliably knows, and
 * because the answer decides three things at once: whether points accrue, whether bottle loans are
 * traceable, and whether a returning customer is recognised. A name typed at the end of a sale
 * cannot do any of that.
 *
 * Walk-in is always one keypress away (Ctrl+W). Forcing registration would make the shop slower for
 * the majority who are not registered, which is how cashiers learn to fake numbers.
 */
export function CustomerGate({ onDone }: { onDone: (c: CustomerCard | null) => void }) {
  const notify = usePos((s) => s.notify);
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<CustomerCard | null>(null);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const digits = phone.replace(/[^0-9+]/g, "");

  useEffect(() => {
    setFound(null);
    setSearched(false);
    setError(null);
    if (!isConnected() || digits.length < 4) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const { data, error: err } = await getSupabase().rpc("customer_card", { p_phone: digits });
        if (mine !== seq.current) return; // a later keystroke started a newer search
        setSearching(false);
        setSearched(true);
        if (err) {
          setError(err.message);
          return;
        }
        setFound((data as CustomerCard | null) ?? null);
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [digits]);

  function use(c: CustomerCard) {
    onDone(c);
  }

  async function register() {
    setError(null);
    if (!name.trim()) {
      setError("Enter the customer's name.");
      return;
    }
    if (digits.length < 9) {
      setError("Enter a full mobile number.");
      return;
    }
    setBusy(true);
    const { data, error: err } = await getSupabase().rpc("add_customer", {
      p_name: name.trim(),
      p_phone: digits,
      p_email: email.trim() || null,
    });
    if (err) {
      setBusy(false);
      const dup = /duplicate key|unique|already belongs/i.test(err.message);
      // Someone registered this number between the lookup and now: show them rather than fail.
      if (dup) {
        const { data: again } = await getSupabase().rpc("customer_card", { p_phone: digits });
        if (again) {
          setFound(again as CustomerCard);
          return;
        }
      }
      setError(dup ? "That number already belongs to another customer. Search for it instead." : err.message);
      return;
    }
    setBusy(false);
    onDone({ ...(data as Customer), points: 0, spend_cents: 0, visits: 0, bottles_out: 0 });
    notify(`${(data as Customer).name} added - this order earns them points`, "success");
  }

  if (!isConnected()) {
    return (
      <Dialog title="Who is this sale for?" onClose={() => onDone(null)} onConfirm={() => onDone(null)} width="max-w-sm">
        <p className="text-sm text-muted">
          Customers need a database connection. This till is running on local demo data, so orders are recorded as
          walk-ins.
        </p>
      </Dialog>
    );
  }

  const canRegister = searched && !found && !searching && digits.length >= 9;

  return (
    <Dialog
      title="Who is this sale for?"
      onClose={() => onDone(null)}
      width="max-w-md"
      onConfirm={() => (found ? use(found) : canRegister ? void register() : undefined)}
      onKey={(e) => {
        if (e.ctrlKey && e.key.toLowerCase() === "w") {
          e.preventDefault();
          onDone(null);
          return true;
        }
      }}
      footer={
        <>
          <Button keycap="Ctrl+W" onClick={() => onDone(null)}>
            <UserRound size={14} /> Walk-in
          </Button>
          {found ? (
            <Button variant="primary" keycap="Enter" onClick={() => use(found)}>
              Start order for {found.name.split(" ")[0]}
            </Button>
          ) : (
            <Button variant="primary" keycap="Enter" onClick={() => void register()} disabled={!canRegister || busy}>
              {busy ? <Loader2 className="animate-spin" size={14} /> : <UserPlus size={14} />} Register
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Mobile number</span>
          <div className="relative">
            <Phone className="absolute left-3 top-3 text-muted" size={16} />
            <input
              data-autofocus
              className="w-full rounded-lg border border-border bg-surface-2 px-9 py-2.5 font-mono text-lg"
              inputMode="tel"
              autoComplete="off"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="0771234567"
              maxLength={16}
            />
            {searching && <Loader2 className="absolute right-3 top-3 animate-spin text-muted" size={16} />}
          </div>
          {digits.length > 0 && digits.length < 4 && (
            <span className="mt-1 block text-xs text-muted">Keep typing - at least the last 4 digits.</span>
          )}
        </label>

        {found && <Card c={found} onUse={() => use(found)} />}

        {canRegister && (
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="mb-2 text-sm text-muted">No customer on this number. Register them:</p>
            <div className="space-y-2">
              <input
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
                data-autofocus
              />
              <input
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email (optional)"
              />
            </div>
          </div>
        )}

        {searched && !found && !searching && !canRegister && (
          <p className="text-xs text-muted">Type the full number to register it, or continue as a walk-in.</p>
        )}

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

        <p className="text-xs text-muted">
          Walk-in orders are still recorded and stock still moves; they just earn no points and cannot be tied to a
          bottle loan.
        </p>
      </div>
    </Dialog>
  );
}

function Card({ c, onUse }: { c: CustomerCard; onUse: () => void }) {
  return (
    <button
      onClick={onUse}
      data-no-enter
      className="w-full rounded-xl border border-primary bg-primary-soft p-3 text-left"
    >
      <div className="flex items-center justify-between">
        <span className="font-semibold text-primary">{c.name}</span>
        <span className="font-mono text-xs text-primary">{c.phone}</span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-primary">
        <span className="inline-flex items-center gap-1">
          <Star size={12} /> {c.points} point{c.points === 1 ? "" : "s"}
        </span>
        <span>{c.visits} order{c.visits === 1 ? "" : "s"}</span>
        <span>{formatMoney(c.spend_cents)} spent</span>
        {c.bottles_out > 0 && (
          <span className="font-semibold text-warning">
            {c.bottles_out} bottle{c.bottles_out === 1 ? "" : "s"} to return
          </span>
        )}
      </div>
    </button>
  );
}
