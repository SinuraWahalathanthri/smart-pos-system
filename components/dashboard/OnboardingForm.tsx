"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Store } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";

/**
 * First run. A new owner names their shop and is taken to the dashboard.
 *
 * Deliberately short: only what the till and the receipts genuinely need. Everything else
 * (categories, staff, products) is added from the dashboard once the shop exists, so this screen
 * cannot become a form the owner abandons half-finished.
 *
 * The shop is created empty. There is no sample catalogue - a real shop must never open to
 * somebody else's demo data.
 */
export function OnboardingForm({ email }: { email: string }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signedInAs, setSignedInAs] = useState(email);
  const [form, setForm] = useState({
    name: "",
    address: "",
    phone: "",
    vatNo: "",
    currency: "LKR",
    bottleFee: "100",
    discount: "5",
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  /**
   * This screen is only meaningful for a signed-in owner, but nothing else guarantees that: opening
   * /onboarding directly with an expired session showed a working form whose every submit failed
   * with a bare "not_authenticated". Decide the state before drawing the form.
   */
  useEffect(() => {
    void (async () => {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) {
        router.replace("/login");
        return;
      }
      setSignedInAs(data.session.user.email ?? email);
      const { data: shop } = await getSupabase().rpc("my_shop");
      if ((shop as { onboarded?: boolean } | null)?.onboarded) router.replace("/dashboard");
    })();
  }, [email, router]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    if (!form.name.trim()) {
      setError("Enter your shop name.");
      return;
    }
    setSaving(true);
    setError(null);

    const bottleCents = Math.round(Number(form.bottleFee || "0") * 100);
    const { data, error: err } = await getSupabase().rpc("create_store", {
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_phone: form.phone.trim() || null,
      p_vat_no: form.vatNo.trim() || null,
      p_currency: form.currency.trim() || "LKR",
      p_prices_include_tax: true,
      p_bottle_fee_cents: Number.isFinite(bottleCents) ? bottleCents : 10000,
      p_max_cashier_discount_pct: Number(form.discount || "0"),
    });

    setSaving(false);
    if (err) {
      setError(explain(err.message));
      return;
    }
    if (!(data as { id?: string } | null)?.id) {
      setError("The shop could not be created. Try again.");
      return;
    }
    router.replace("/dashboard");
  }

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-3 grid h-14 w-14 place-items-center rounded-2xl bg-primary text-primary-fg">
            <Store size={26} />
          </span>
          <h1 className="text-2xl font-semibold">Set up your shop</h1>
          <p className="mt-1 text-sm text-muted">Signed in as {signedInAs || "your account"}</p>
        </div>

        <form onSubmit={submit} className="space-y-4 rounded-xl border border-border bg-surface p-5">
          <Field label="Shop name" required>
            <input
              className="field"
              autoFocus
              value={form.name}
              onChange={set("name")}
              placeholder="Sinura Spice House"
              maxLength={120}
            />
          </Field>

          <Field label="Address">
            <input className="field" value={form.address} onChange={set("address")} placeholder="12 Main Street, Kandy" />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone">
              <input className="field" value={form.phone} onChange={set("phone")} placeholder="081 234 5678" />
            </Field>
            <Field label="VAT number" hint="Leave blank if not registered">
              <input className="field" value={form.vatNo} onChange={set("vatNo")} placeholder="Optional" />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Currency">
              <input className="field" value={form.currency} onChange={set("currency")} maxLength={3} />
            </Field>
            <Field label="Bottle deposit" hint="Charged only if a bottle is not returned">
              <input className="field" value={form.bottleFee} onChange={set("bottleFee")} inputMode="decimal" />
            </Field>
          </div>

          <Field label="Max cashier discount %" hint="Above this, a supervisor must approve">
            <input className="field" value={form.discount} onChange={set("discount")} inputMode="decimal" />
          </Field>

          <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            Your shop starts empty. Add staff and products from the dashboard next.
          </p>

          {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

          <button
            type="submit"
            disabled={saving}
            className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 font-medium text-primary-fg disabled:opacity-60"
          >
            {saving ? <Loader2 className="animate-spin" size={18} /> : <ArrowRight size={18} />}
            {saving ? "Creating shop" : "Create shop"}
          </button>
        </form>
      </div>
    </main>
  );
}

/**
 * create_store's exceptions arrive as raw Postgres text ("not_authenticated", "shop name is
 * required"), which tells the owner nothing about what to do next.
 */
function explain(message: string): string {
  if (/not_authenticated|JWT|28000/i.test(message)) {
    return "Your session has expired. Sign in again, then create the shop.";
  }
  if (/shop name is required/i.test(message)) return "Enter your shop name.";
  if (/bottle fee cannot be negative/i.test(message)) return "Bottle deposit cannot be negative.";
  if (/discount percentage/i.test(message)) return "Max cashier discount must be between 0 and 100.";
  if (/fetch|network/i.test(message)) return "No connection to the server. Check the internet and try again.";
  return message;
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
