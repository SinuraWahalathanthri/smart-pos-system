"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Phone, UserPlus, X } from "lucide-react";
import { getSupabase, isConnected } from "@/lib/supabase/client";
import { usePos } from "@/lib/store";
import { Dialog, Button } from "../ui/Dialog";

export type Customer = {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  bottles_out?: number;
};

/**
 * Attach a customer to the bill, by mobile number.
 *
 * The cashier types the number the customer says out loud. A match loads that person and their
 * outstanding bottles; no match offers to add them. One number belongs to one person, so a household
 * cannot share it - the husband and wife each use their own, which is what makes the bottle ledger
 * trustworthy.
 *
 * Bottles matter here: if the customer brings them back, the return is registered BEFORE the sale so
 * the deposit is not charged twice.
 */
export function CustomerDialog({ onClose, onAttached }: { onClose: () => void; onAttached?: (c: Customer | null) => void }) {
  const notify = usePos((s) => s.notify);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [found, setFound] = useState<Customer | null>(null);
  const [searching, setSearching] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searched, setSearched] = useState(false);
  const seq = useRef(0);

  const digits = phone.replace(/[^0-9+]/g, "");

  // Look up as the cashier types, once the number is long enough to be meaningful.
  useEffect(() => {
    setFound(null);
    setSearched(false);
    if (!isConnected() || digits.length < 4) return;
    const mine = ++seq.current;
    const t = setTimeout(() => {
      void (async () => {
        setSearching(true);
        const { data, error: err } = await getSupabase().rpc("find_customer_by_phone", { p_phone: digits });
        if (mine !== seq.current) return; // a later keystroke already started a newer search
        setSearching(false);
        setSearched(true);
        if (err) {
          setError(err.message);
          return;
        }
        const c = data as Customer | null;
        setFound(c);
        if (c) setName(c.name);
      })();
    }, 250);
    return () => clearTimeout(t);
  }, [digits]);

  async function attach(c: Customer) {
    // Ask for the live bottle count: the search result may be a moment old and it decides the fee.
    const { data } = await getSupabase().rpc("customer_bottles_outstanding", { p_customer: c.id });
    const bottles = typeof data === "number" ? data : (c.bottles_out ?? 0);
    onAttached?.({ ...c, bottles_out: bottles });
    notify(`${c.name} attached${bottles > 0 ? ` - ${bottles} bottle${bottles === 1 ? "" : "s"} to return` : ""}`, bottles > 0 ? "warn" : "success");
    onClose();
  }

  async function create() {
    setError(null);
    if (!name.trim()) {
      setError("Enter the customer's name.");
      return;
    }
    if (digits.length < 9) {
      setError("Enter a full mobile number.");
      return;
    }
    setCreating(true);
    // The database fills in store_id from the signed-in session; the till never sends it.
    const { data, error: err } = await getSupabase().rpc("add_customer", {
      p_name: name.trim(),
      p_phone: digits,
      p_email: email.trim() || null,
    });
    setCreating(false);

    if (err) {
      // The unique index is the real rule; say so in the cashier's words.
      setError(
        /duplicate key|unique|already belongs/i.test(err.message)
          ? "That number already belongs to another customer. Search for it instead."
          : err.message,
      );
      return;
    }
    await attach(data as Customer);
  }

  if (!isConnected()) {
    return (
      <Dialog title="Customer" onClose={onClose} onConfirm={onClose} width="max-w-sm">
        <p className="text-sm text-muted">
          Customers need a database connection. This till is running on local demo data.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Customer"
      onClose={onClose}
      width="max-w-md"
      onConfirm={() => (found ? void attach(found) : void create())}
      footer={
        <>
          <Button onClick={onClose} keycap="Esc">
            Cancel
          </Button>
          {found ? (
            <Button variant="primary" keycap="Enter" onClick={() => void attach(found)}>
              Use {found.name.split(" ")[0]}
            </Button>
          ) : (
            <Button variant="primary" keycap="Enter" onClick={() => void create()} disabled={creating}>
              {creating ? <Loader2 className="animate-spin" size={14} /> : <UserPlus size={14} />} Add customer
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

        {found && <FoundCard c={found} onUse={() => void attach(found)} />}

        {searched && !found && !searching && (
          <div className="rounded-lg border border-dashed border-border p-3">
            <p className="mb-2 text-sm text-muted">No customer on this number. Add them:</p>
            <div className="space-y-2">
              <input
                className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Full name"
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

        {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      </div>
    </Dialog>
  );
}

function FoundCard({ c, onUse }: { c: Customer; onUse: () => void }) {
  const bottles = c.bottles_out ?? 0;
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{c.name}</p>
          <p className="font-mono text-sm text-muted">{c.phone}</p>
          {c.email && <p className="text-xs text-muted">{c.email}</p>}
        </div>
        <button onClick={onUse} className="rounded p-1 text-muted hover:bg-surface" aria-label="Use this customer">
          <X size={14} />
        </button>
      </div>
      {bottles > 0 ? (
        <p className="mt-2 rounded bg-warning-soft px-2 py-1 text-xs text-warning">
          Has {bottles} bottle{bottles === 1 ? "" : "s"} of ours. Register the return before taking payment.
        </p>
      ) : (
        <p className="mt-2 text-xs text-muted">No bottles outstanding.</p>
      )}
    </div>
  );
}
