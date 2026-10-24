"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Check,
  Copy,
  KeyRound,
  LogOut,
  Plus,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
  Users,
} from "lucide-react";
import { formatMoney } from "@/lib/money";
import {
  copyText,
  createOwner,
  generatePassword,
  listStores,
  resetOwnerPassword,
  setStoreActive,
  storeDetail,
  type PlatformStore,
  type PlatformStoreDetail,
} from "@/lib/platform";
import { getSupabase } from "@/lib/supabase/client";
import { Button, Dialog } from "../ui/Dialog";

/**
 * The platform administrator's screen.
 *
 * Two deliberate constraints shape it:
 *   1. It is READ-ONLY over trading data. There is no control that edits a sale, a product or a stock
 *      level, and no RPC exists to do so. The only writes are provisioning, password reset and the
 *      suspension switch.
 *   2. It does not use DashboardShell. An administrator belongs to no shop, so the shop navigation
 *      (and useShop, which redirects when there is no shop) would be wrong here.
 *
 * The server re-checks is_platform_admin() on every call, so a shop owner who reaches this URL sees
 * an error rather than data.
 */
export function PlatformScreen() {
  const router = useRouter();
  const [stores, setStores] = useState<PlatformStore[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [openStore, setOpenStore] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await getSupabase().auth.getSession();
      if (!data.session) {
        router.replace("/login");
        return;
      }
      setStores(await listStores());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the shops.");
      setStores([]);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const list = stores ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((s) =>
      [s.name, s.owner_email, s.owner_name, s.phone].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [stores, query]);

  const totals = useMemo(() => {
    const list = stores ?? [];
    return {
      shops: list.length,
      active: list.filter((s) => s.is_active).length,
      owners: list.filter((s) => s.owner_email).length,
    };
  }, [stores]);

  async function signOut() {
    await getSupabase().auth.signOut();
    router.replace("/login");
  }

  return (
    <main className="min-h-dvh bg-bg text-text">
      <header className="sticky top-0 z-10 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-primary text-primary-fg">
            <ShieldCheck size={18} />
          </span>
          <div className="mr-auto">
            <h1 className="text-base font-semibold leading-tight">Platform administration</h1>
            <p className="text-xs text-muted">View shops and create owner accounts. Trading data is read-only.</p>
          </div>
          <Button variant="secondary" onClick={() => void load()}>
            <RefreshCw size={15} className="mr-1.5" /> Refresh
          </Button>
          <Button variant="secondary" onClick={() => setCreating(true)}>
            <Plus size={15} className="mr-1.5" /> New owner
          </Button>
          <Button variant="ghost" onClick={() => void signOut()} aria-label="Sign out">
            <LogOut size={15} />
          </Button>
        </div>
      </header>

      <div className="mx-auto max-w-6xl px-4 py-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-3">
          <Stat label="Shops" value={totals.shops} />
          <Stat label="Open" value={totals.active} />
          <Stat label="Owner accounts" value={totals.owners} />
        </div>

        <div className="relative mb-3">
          <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            className="field pl-9"
            placeholder="Search shop, owner or phone"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-xl border border-danger/40 bg-danger/10 p-3 text-sm">
            <ShieldAlert size={16} className="mt-0.5 shrink-0 text-danger" />
            <p>{error}</p>
          </div>
        )}

        {stores === null ? (
          <p className="p-6 text-center text-sm text-muted">Loading shops...</p>
        ) : shown.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted">
            {stores.length === 0 ? (
              <>
                <p className="mb-1 font-medium text-text">No shops yet</p>
                <p>Create the first owner account and their shop will appear here.</p>
              </>
            ) : (
              <p>No shop matches your search.</p>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[34rem] text-sm">
              <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Shop</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Staff</th>
                  <th className="hidden px-3 py-2 text-right font-medium sm:table-cell">Products</th>
                  <th className="hidden px-3 py-2 text-right font-medium md:table-cell">Sales</th>
                  <th className="px-3 py-2 font-medium">State</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((s) => (
                  <tr
                    key={s.id}
                    onClick={() => setOpenStore(s.id)}
                    className="cursor-pointer border-t border-border align-middle hover:bg-surface-2"
                  >
                    <td className="px-3 py-2">
                      <p className="font-medium">{s.name}</p>
                      <p className="text-xs text-muted">
                        Joined {new Date(s.created_at).toLocaleDateString()}
                        {s.phone ? ` · ${s.phone}` : ""}
                      </p>
                    </td>
                    <td className="px-3 py-2">
                      <p className="num text-xs">{s.owner_email ?? <span className="text-muted">no account</span>}</p>
                      {s.owner_name && <p className="text-xs text-muted">{s.owner_name}</p>}
                    </td>
                    <td className="num hidden px-3 py-2 text-right sm:table-cell">{s.staff_count}</td>
                    <td className="num hidden px-3 py-2 text-right sm:table-cell">{s.product_count}</td>
                    <td className="num hidden px-3 py-2 text-right md:table-cell">
                      {s.sale_count}
                      <span className="block text-xs text-muted">{formatMoney(s.sales_cents)}</span>
                    </td>
                    <td className="px-3 py-2">
                      <StateBadge active={s.is_active} />
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button variant="ghost" onClick={() => setOpenStore(s.id)}>
                        View
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {creating && (
        <CreateOwnerDialog
          onClose={() => setCreating(false)}
          onDone={() => {
            setCreating(false);
            void load();
          }}
        />
      )}

      {openStore && (
        <StoreDetailDialog storeId={openStore} onClose={() => setOpenStore(null)} onChanged={() => void load()} />
      )}
    </main>
  );
}

function Stat({
  label,
  value,
  hint,
  warn,
}: {
  label: string;
  value: string | number;
  hint?: string;
  warn?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-surface px-4 py-3">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="num text-2xl font-semibold">{value}</p>
      {hint && <p className={`text-xs ${warn ? "text-danger" : "text-muted"}`}>{hint}</p>}
    </div>
  );
}

function StateBadge({ active }: { active: boolean }) {
  return active ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
      <Check size={12} /> Open
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-danger/15 px-2 py-0.5 text-xs font-medium text-danger">
      <ShieldAlert size={12} /> Suspended
    </span>
  );
}

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Create an owner account and an empty shop.
 *
 * The generated password is shown ONCE, in this dialog, and cannot be retrieved afterwards, so the
 * success panel must not be dismissed casually: losing it means a reset round-trip with the
 * shopkeeper.
 */
function CreateOwnerDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [shopName, setShopName] = useState("");
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState(() => generatePassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ email: string; password: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const emailOk = EMAIL_RE.test(email.trim());

  async function submit() {
    if (busy) return;
    if (!shopName.trim()) return setError("Enter the shop name.");
    if (!emailOk) return setError("Enter a valid email address for the owner.");
    setBusy(true);
    setError(null);
    try {
      await createOwner({
        email: email.trim(),
        password,
        shopName: shopName.trim(),
        fullName: fullName.trim() || undefined,
        address: address.trim() || undefined,
        phone: phone.trim() || undefined,
      });
      setDone({ email: email.trim(), password });
    } catch (e) {
      const m = e instanceof Error ? e.message : "Could not create the account.";
      setError(
        /already exists/i.test(m)
          ? "That email already has an account. Use a different address, or reset that owner's password instead."
          : m,
      );
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog
        title="Owner account created"
        onClose={onDone}
        footer={
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Give these to the shop owner. They will be asked to set their own password when they first sign in.
          </p>
          <div className="rounded-xl border border-border bg-surface-2 p-3">
            <p className="text-xs uppercase text-muted">Email</p>
            <p className="num mb-2 select-all break-all font-medium">{done.email}</p>
            <p className="text-xs uppercase text-muted">Temporary password</p>
            <p className="num select-all break-all font-mono text-lg font-semibold">{done.password}</p>
          </div>
          <Button
            variant="secondary"
            onClick={async () => setCopied(await copyText(`Email: ${done.email}\nPassword: ${done.password}`))}
          >
            <Copy size={15} className="mr-1.5" /> {copied ? "Copied" : "Copy both"}
          </Button>
          <p className="rounded-lg border border-warning/40 bg-warning/10 p-2 text-xs">
            This password is not stored anywhere and cannot be shown again. Copy it now.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="New owner account"
      onClose={onClose}
      onConfirm={() => void submit()}
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Creating..." : "Create account"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Shop name" required>
          <input className="field" data-autofocus value={shopName} onChange={(e) => setShopName(e.target.value)} />
        </Field>
        <Field label="Owner email" required hint="This is what they sign in with.">
          <input
            className="field num"
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Owner name" hint="Optional. Defaults to the shop name.">
          <input className="field" value={fullName} onChange={(e) => setFullName(e.target.value)} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Phone" hint="Optional">
            <input className="field num" value={phone} onChange={(e) => setPhone(e.target.value)} />
          </Field>
          <Field label="Address" hint="Optional">
            <input className="field" value={address} onChange={(e) => setAddress(e.target.value)} />
          </Field>
        </div>

        <div className="rounded-xl border border-dashed border-border p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">Temporary password</span>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => {
                setPassword(generatePassword());
                setCopied(false);
              }}
            >
              Generate another
            </button>
          </div>
          <input
            className="field num font-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-no-enter
          />
          <p className="mt-1 text-xs text-muted">
            Shown once. The owner is required to change it at first sign-in.
          </p>
        </div>

        {error && (
          <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">
            <ShieldAlert size={15} className="mt-0.5 shrink-0 text-danger" /> {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}

/** One shop: who works there, what it has sold, and every platform action taken on it. */
function StoreDetailDialog({
  storeId,
  onClose,
  onChanged,
}: {
  storeId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<PlatformStoreDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suspending, setSuspending] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    try {
      setDetail(await storeDetail(storeId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load this shop.");
    }
  }, [storeId]);

  useEffect(() => {
    void load();
  }, [load]);

  const store = detail?.store;

  return (
    <Dialog
      title={store?.name ?? "Shop"}
      onClose={onClose}
      width="max-w-3xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {error && <p className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">{error}</p>}
      {!detail ? (
        <p className="py-6 text-center text-sm text-muted">Loading...</p>
      ) : (
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          <div className="grid gap-2 sm:grid-cols-2">
            <Info label="Owner" value={store?.owner_email ?? "no account"} />
            <Info label="Phone" value={store?.phone ?? "-"} />
            <Info label="Address" value={store?.address ?? "-"} />
            <Info label="VAT no" value={store?.vat_no ?? "-"} />
            <Info label="Created" value={store ? new Date(store.created_at).toLocaleString() : "-"} />
            <Info
              label="Last sale"
              value={
                !detail.breakdown_available
                  ? "not reported"
                  : detail.totals.last_sale_at
                    ? new Date(detail.totals.last_sale_at).toLocaleString()
                    : "never"
              }
            />
          </div>

          {!store?.is_active && (
            <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">
              <ShieldAlert size={15} className="mt-0.5 shrink-0 text-danger" />
              Suspended {store?.suspended_at ? new Date(store.suspended_at).toLocaleDateString() : ""} —{" "}
              {store?.suspended_reason ?? "no reason recorded"}
            </p>
          )}

          {/* The database predates the breakdown. Say so, because the zeroes below are placeholders
              and an operator would otherwise read "0 sales" as fact. */}
          {!detail.breakdown_available && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 p-2 text-sm">
              <RefreshCw size={15} className="mt-0.5 shrink-0" />
              <span>
                This project is still running the first version of the admin panel, so the figures below
                are empty. Re-run <code className="num">supabase/migrations/0025_platform_admin.sql</code>{" "}
                in the Supabase SQL editor to load the full breakdown.
              </span>
            </p>
          )}

          {/* Headline numbers. "Lifetime" covers every uploaded sale; the monthly table below shows the
              recent shape, so the two are not required to agree. */}
          <section className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Stat label="Lifetime takings" value={formatMoney(detail.totals.sales_cents)} />
            <Stat label="Sales" value={String(detail.totals.sale_count)} />
            <Stat label="Average basket" value={formatMoney(detail.totals.avg_sale_cents)} />
            <Stat
              label="Active products"
              value={String(detail.totals.product_count)}
              hint={detail.totals.low_stock_count > 0 ? `${detail.totals.low_stock_count} low stock` : undefined}
              warn={detail.totals.low_stock_count > 0}
            />
            <Stat
              label="Staff"
              value={`${detail.totals.active_staff_count}/${detail.totals.staff_count}`}
              hint="active / total"
            />
            <Stat
              label="Refunds"
              value={formatMoney(detail.totals.refund_cents)}
              hint={`${detail.totals.refund_count} refunded`}
            />
          </section>

          <section>
            <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
              <Users size={14} /> Staff ({detail.staff.length})
            </h3>
            <ul className="divide-y divide-border rounded-xl border border-border">
              {detail.staff.map((p) => (
                <li key={p.id} className="flex items-center justify-between px-3 py-1.5 text-sm">
                  <span>
                    {p.full_name} <span className="text-xs text-muted">#{p.staff_code}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {p.role}
                    {!p.is_active && " · inactive"}
                    {p.sales_count > 0 && <span className="num"> · {p.sales_count} sales</span>}
                  </span>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">Sales by month</h3>
            {detail.monthly_sales.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-center text-xs text-muted">
                No sales recorded yet.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {detail.monthly_sales.map((m) => (
                  <li key={m.month} className="flex items-center justify-between px-3 py-1.5 text-sm">
                    <span className="num">{m.month}</span>
                    <span className="text-xs text-muted">
                      {m.sales} sales · <span className="num">{formatMoney(m.total_cents)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <div className="grid gap-3 sm:grid-cols-2">
            <section>
              <h3 className="mb-1 text-sm font-semibold">Payment mix</h3>
              {detail.payment_mix.length === 0 ? (
                <Empty text="No payments recorded." />
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {detail.payment_mix.map((p) => (
                    <li key={p.method} className="flex items-center justify-between px-3 py-1.5 text-sm">
                      <span className="capitalize">{p.method}</span>
                      <span className="text-xs text-muted">
                        {p.count} · <span className="num">{formatMoney(p.total_cents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 className="mb-1 text-sm font-semibold">Best sellers</h3>
              {detail.top_products.length === 0 ? (
                <Empty text="Nothing sold yet." />
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {detail.top_products.map((p, i) => (
                    <li key={`${p.name}-${i}`} className="flex items-center justify-between px-3 py-1.5 text-sm">
                      <span className="truncate pr-2">{p.name}</span>
                      <span className="shrink-0 text-xs text-muted">
                        {Number(p.qty)} · <span className="num">{formatMoney(p.revenue_cents)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <section>
            <h3 className="mb-1 text-sm font-semibold">Recent sales</h3>
            {detail.recent_sales.length === 0 ? (
              <Empty text="No sales recorded." />
            ) : (
              <div className="overflow-x-auto rounded-xl border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">Receipt</th>
                      <th className="px-3 py-1.5 font-medium">When</th>
                      <th className="px-3 py-1.5 font-medium">Cashier</th>
                      <th className="px-3 py-1.5 text-right font-medium">Total</th>
                      <th className="px-3 py-1.5 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.recent_sales.map((s) => (
                      <tr key={s.id} className="border-t border-border">
                        <td className="num px-3 py-1.5">#{s.receipt_no}</td>
                        <td className="px-3 py-1.5 text-xs text-muted">
                          {new Date(s.created_at).toLocaleString()}
                        </td>
                        <td className="px-3 py-1.5 text-xs">{s.cashier ?? "—"}</td>
                        <td className="num px-3 py-1.5 text-right">{formatMoney(s.total_cents)}</td>
                        <td className="px-3 py-1.5 text-xs">
                          <span className={s.status === "completed" ? "text-muted" : "text-danger"}>{s.status}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section>
            <h3 className="mb-1 text-sm font-semibold">Platform history</h3>
            {detail.platform_actions.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border p-3 text-center text-xs text-muted">
                No platform actions.
              </p>
            ) : (
              <ul className="divide-y divide-border rounded-xl border border-border">
                {detail.platform_actions.map((a, i) => (
                  <li key={i} className="px-3 py-1.5 text-sm">
                    <span className="font-medium">{a.action.replace(/_/g, " ")}</span>{" "}
                    <span className="text-xs text-muted">{new Date(a.created_at).toLocaleString()}</span>
                    {typeof a.detail?.reason === "string" && a.detail.reason && (
                      <span className="block text-xs text-muted">Reason: {a.detail.reason}</span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button variant="secondary" onClick={() => setResetting(true)}>
              <KeyRound size={15} className="mr-1.5" /> Reset owner password
            </Button>
            <Button variant={store?.is_active ? "danger" : "primary"} onClick={() => setSuspending(true)}>
              <Building2 size={15} className="mr-1.5" />
              {store?.is_active ? "Suspend shop" : "Restore shop"}
            </Button>
          </section>
        </div>
      )}

      {resetting && store?.owner_id && (
        <ResetPasswordDialog
          userId={store.owner_id}
          onClose={() => setResetting(false)}
          onDone={() => {
            setResetting(false);
            void load();
          }}
        />
      )}

      {suspending && store && (
        <SuspendDialog
          storeId={store.id}
          active={store.is_active}
          onClose={() => setSuspending(false)}
          onDone={() => {
            setSuspending(false);
            void load();
            onChanged();
          }}
        />
      )}
    </Dialog>
  );
}

function ResetPasswordDialog({
  userId,
  onClose,
  onDone,
}: {
  userId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState(() => generatePassword());
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await resetOwnerPassword(userId, password, reason.trim() || undefined);
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not reset the password.");
      setBusy(false);
    }
  }

  if (done) {
    return (
      <Dialog
        title="Password reset"
        onClose={onDone}
        footer={
          <Button variant="primary" onClick={onDone}>
            Done
          </Button>
        }
      >
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Give this to the owner. They will be asked to change it when they next sign in.
          </p>
          <p className="num select-all break-all rounded-xl border border-border bg-surface-2 p-3 font-mono text-lg font-semibold">
            {password}
          </p>
          <Button variant="secondary" onClick={() => void copyText(password)}>
            <Copy size={15} className="mr-1.5" /> Copy
          </Button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Reset owner password"
      onClose={onClose}
      onConfirm={() => void submit()}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving..." : "Reset password"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Give the new password to the owner. They will be asked to change it when they next sign in.
        </p>
        <div className="rounded-xl border border-dashed border-border p-3">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium">New password</span>
            <button
              type="button"
              className="text-xs font-medium text-primary hover:underline"
              onClick={() => setPassword(generatePassword())}
            >
              Generate another
            </button>
          </div>
          <input
            className="field num font-mono"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            data-no-enter
          />
        </div>
        <Field label="Reason" hint="Recorded in the platform history.">
          <input
            className="field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. lost the handover slip"
          />
        </Field>
        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">{error}</p>}
      </div>
    </Dialog>
  );
}

function SuspendDialog({
  storeId,
  active,
  onClose,
  onDone,
}: {
  storeId: string;
  active: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (active && !reason.trim()) return setError("Give a reason so the decision can be reviewed later.");
    setBusy(true);
    setError(null);
    try {
      await setStoreActive(storeId, !active, reason.trim() || undefined);
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the shop's state.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={active ? "Suspend this shop?" : "Restore this shop?"}
      onClose={onClose}
      onConfirm={() => void submit()}
      tone={active ? "danger" : "default"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant={active ? "danger" : "primary"} onClick={() => void submit()} disabled={busy}>
            {busy ? "Saving..." : active ? "Suspend" : "Restore"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm">
          {active
            ? "The shop's staff will lose access to their data and no new sales can be recorded. Nothing is deleted, and restoring reopens it exactly as it was."
            : "The shop reopens and its staff can work again."}
        </p>
        <Field label="Reason" required={active}>
          <input
            className="field"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={active ? "e.g. unpaid invoice" : "Optional"}
            data-autofocus
          />
        </Field>
        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 p-2 text-sm">{error}</p>}
      </div>
    </Dialog>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 px-3 py-1.5">
      <p className="text-xs uppercase text-muted">{label}</p>
      <p className="break-words text-sm">{value}</p>
    </div>
  );
}

/** Muted placeholder for a table that has nothing in it yet. */
function Empty({ text }: { text: string }) {
  return (
    <p className="rounded-xl border border-dashed border-border p-3 text-center text-xs text-muted">{text}</p>
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
