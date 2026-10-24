"use client";

import { useState } from "react";
import { ShieldAlert, Store } from "lucide-react";
import { parseMoneyInput } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import type { Shop } from "./useShop";
import { Button, Dialog } from "../ui/Dialog";

/**
 * Edit the shop's own details.
 *
 * This is the gap that made a typo in the shop name permanent: before this, the only way to change it
 * was to edit the database by hand. Everything on the form is something the owner is entitled to
 * change about their own business; billing state (suspension) is deliberately absent because that is
 * a platform decision, and the server refuses it here anyway.
 *
 * Money is entered in rupees and converted with parseMoneyInput, so the bottle deposit stays integer
 * cents like every other amount in the app.
 */
export function ShopDetailsDialog({ shop, onClose, onSaved }: { shop: Shop; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(shop.name);
  const [address, setAddress] = useState(shop.address ?? "");
  const [phone, setPhone] = useState(shop.phone ?? "");
  const [vatNo, setVatNo] = useState(shop.vat_no ?? "");
  const [currency, setCurrency] = useState(shop.currency);
  const [bottleFee, setBottleFee] = useState((shop.bottle_fee_cents / 100).toFixed(2));
  const [discount, setDiscount] = useState(String(shop.max_cashier_discount_pct));
  const [pricesIncludeTax, setPricesIncludeTax] = useState(shop.prices_include_tax);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const feeCents = parseMoneyInput(bottleFee);
  const discountPct = Number(discount);
  const valid =
    name.trim().length > 0 &&
    feeCents !== null &&
    feeCents >= 0 &&
    Number.isFinite(discountPct) &&
    discountPct >= 0 &&
    discountPct <= 100;

  async function submit() {
    if (busy || !valid) return;
    setBusy(true);
    setError(null);
    try {
      const { error: err } = await getSupabase().rpc("update_store_details", {
        p_name: name.trim(),
        p_address: address.trim() || null,
        p_phone: phone.trim() || null,
        p_vat_no: vatNo.trim() || null,
        p_currency: currency.trim() || "LKR",
        p_bottle_fee_cents: feeCents,
        p_max_cashier_discount_pct: discountPct,
        p_prices_include_tax: pricesIncludeTax,
      });
      if (err) throw new Error(err.message);
      onSaved();
    } catch (e) {
      const m = e instanceof Error ? e.message : "Could not save the shop details.";
      setError(
        /only the shop owner/i.test(m) ? "Only the shop owner can change these details." : m,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title="Shop details"
      onClose={onClose}
      onConfirm={() => void submit()}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!valid || busy}>
            {busy ? "Saving..." : "Save changes"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="flex items-center gap-2 text-sm text-muted">
          <Store size={15} /> These details appear on receipts and reports.
        </p>

        <Field label="Shop name" required>
          <input className="field" data-autofocus value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone">
            <input className="field num" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="VAT number" hint="Leave blank if not registered.">
            <input className="field num" value={vatNo} onChange={(e) => setVatNo(e.target.value)} />
          </Field>
        </div>
        <Field label="Address">
          <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Currency">
            <input className="field num" value={currency} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
          <Field label="Bottle deposit" hint="Rupees, per returnable bottle.">
            <input
              className="field num"
              inputMode="decimal"
              value={bottleFee}
              onChange={(e) => setBottleFee(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Max cashier discount %" hint="The largest discount a cashier may give without approval.">
          <input
            className="field num"
            inputMode="decimal"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </Field>

        <label className="flex items-start gap-2 rounded-xl border border-border p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={pricesIncludeTax}
            onChange={(e) => setPricesIncludeTax(e.target.checked)}
          />
          <span className="text-sm">
            Prices already include tax
            <span className="block text-xs text-muted">
              Turn off if shelf prices are before VAT and tax is added at the till.
            </span>
          </span>
        </label>

        {!valid && (name.trim().length === 0 || feeCents === null || !(discountPct >= 0 && discountPct <= 100)) && (
          <p className="text-xs text-muted">Check the name, bottle deposit and discount percentage.</p>
        )}

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-danger" /> {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">
        {label}
        {required && <span className="ml-0.5 text-danger">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}
