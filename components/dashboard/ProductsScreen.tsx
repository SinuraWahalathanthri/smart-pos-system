"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, PackagePlus, Plus, Search, Trash2 } from "lucide-react";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { StockPanel } from "./StockPanel";
import { permissions, useShop } from "./useShop";

type ProductRow = {
  id: string;
  name: string;
  price_cents: number;
  reorder_level: number | null;
  is_returnable_bottle: boolean;
  is_active: boolean;
  color: string | null;
  sku: string | null;
  kind: string | null;
  sale_mode: string | null;
  category_id: string | null;
  stock_on_hand: number | string;
};

export type Category = { id: string; name: string };

type PackRow = { id?: string; weightG: string; price: string };

/**
 * The catalogue. Owner and supervisor only; a cashier is refused by save_product server side.
 *
 * There are no product images: this build deliberately avoids object storage. The tile colour is a
 * label so the till grid stays readable without paying for a bucket.
 */
export function ProductsScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);

  return (
    <DashboardShell>
      {can.manageProducts ? <ProductList currency={ctx?.store?.currency ?? "LKR"} /> : <NotAllowed what="products" role={ctx?.role} />}
    </DashboardShell>
  );
}

const COLORS = ["amber", "red", "green", "blue", "purple", "slate"];

/** Strip anything that is not part of a decimal, so a stray keypress cannot become a letter. */
const digits = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
const whole = (v: string) => v.replace(/[^0-9]/g, "");

function ProductList({ currency }: { currency: string }) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  const [stockFor, setStockFor] = useState<ProductRow | null>(null);
  const [packTotal, setPackTotal] = useState<Map<string, number>>(new Map());

  const money = (c: number) => formatMoney(c);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);

  async function load() {
    setLoading(true);
    const sb = getSupabase();
    const [{ data: prods, error: e1 }, { data: cats }, { data: sizes }] = await Promise.all([
      sb
        .from("products")
        .select("id, name, price_cents, reorder_level, is_returnable_bottle, is_active, color, sku, kind, sale_mode, category_id, stock_on_hand")
        .is("archived_at", null)
        .order("name"),
      sb.from("categories").select("id, name").order("sort_order"),
      // A weighted product's stock lives on its packets, not on the product row.
      sb.from("pack_sizes").select("product_id, packets_on_hand").eq("is_active", true),
    ]);
    setLoading(false);
    if (e1) {
      setError(e1.message);
      return;
    }
    setRows((prods as ProductRow[] | null) ?? []);
    setCats((cats as Category[] | null) ?? []);
    const totals = new Map<string, number>();
    for (const s of (sizes as { product_id: string; packets_on_hand: number | string }[] | null) ?? []) {
      totals.set(s.product_id, (totals.get(s.product_id) ?? 0) + Number(s.packets_on_hand));
    }
    setPackTotal(totals);
  }

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q));
  }, [rows, query]);

  async function save(payload: Record<string, unknown>, packs: PackRow[]) {
    setBusy(true);
    setError(null);
    setMessage(null);
    const { data, error: err } = await getSupabase().rpc("save_product", { p_product: payload });
    if (err) {
      setBusy(false);
      setError(err.message);
      return false;
    }
    const id = (data as { id?: string } | null)?.id;
    // Packets live in their own table and their stock may only move through stock_movements, so they
    // are written separately from the product row.
    if (id && payload.sale_mode === "weighted") {
      const { error: packErr } = await getSupabase().rpc("save_pack_sizes", {
        p_product: id,
        p_sizes: packs.map((p) => ({
          id: p.id ?? null,
          weight_g: Number(p.weightG),
          price_cents: Math.round(Number(p.price || "0") * 100),
        })),
      });
      if (packErr) {
        setBusy(false);
        setError(packErr.message);
        return false;
      }
    }
    setBusy(false);
    setMessage("Saved.");
    setEditing(null);
    await load();
    return true;
  }
  async function addCategory(name: string): Promise<Category | null> {
    setError(null);
    const { data, error: err } = await getSupabase().rpc("save_category", { p_name: name, p_sort_order: cats.length });
    if (err) {
      setError(err.message);
      return null;
    }
    await load();
    return data as Category | null;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Products</h1>
          <p className="text-sm text-muted">What the till can sell.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-2.5 text-muted" size={16} />
            <input
              className="field pl-8"
              placeholder="Search name or SKU"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <button
            onClick={() => setEditing("new")}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg"
          >
            <Plus size={16} /> Add product
          </button>
        </div>
      </div>

      {message && <p className="rounded-lg bg-success-soft px-3 py-2 text-sm text-success">{message}</p>}
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}

      {editing && (
        <ProductForm
          initial={editing === "new" ? null : editing}
          cats={cats}
          busy={busy}
          currency={currency}
          onCancel={() => setEditing(null)}
          onSave={save}
          onAddCategory={addCategory}
        />
      )}

      {stockFor && (
        <StockPanel
          product={stockFor}
          weighted={stockFor.sale_mode === "weighted"}
          currency={currency}
          onClose={() => setStockFor(null)}
          onDone={() => void load()}
        />
      )}
      {loading ? (
        <p className="text-sm text-muted">Loading...</p>
      ) : shown.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-8 text-center">
          <PackagePlus className="mx-auto mb-2 text-muted" size={22} />
          <p className="text-sm text-muted">
            {rows.length === 0 ? "No products yet. Add the first one to start selling." : "Nothing matches that search."}
          </p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-right">Stock</th>
                <th className="px-4 py-2 text-right">Reorder at</th>
                <th className="px-4 py-2">Bottle</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span
                        className="h-2.5 w-2.5 rounded-full"
                        style={{ background: `var(--tile-${r.color ?? "amber"}, var(--primary))` }}
                      />
                      <span className="font-medium">{r.name}</span>
                      {r.sale_mode === "weighted" && <span className="text-xs text-muted">(by weight)</span>}
                      {!r.is_active && <span className="text-xs text-muted">(inactive)</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-muted">
                    {r.category_id ? (catName.get(r.category_id) ?? "-") : "-"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{money(Number(r.price_cents))}</td>
                  <td className="px-4 py-2 text-right font-mono">
                    {r.sale_mode === "weighted" ? (
                      <span className="text-muted">{packTotal.get(r.id) ?? 0}</span>
                    ) : (
                      Number(r.stock_on_hand)
                    )}
                  </td>
                  <td className="px-4 py-2 text-right font-mono text-muted">{r.reorder_level ?? "-"}</td>
                  <td className="px-4 py-2">{r.is_returnable_bottle ? "Returnable" : "-"}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      <button onClick={() => setStockFor(r)} className="text-sm text-primary underline">
                        Stock
                      </button>
                      <button onClick={() => setEditing(r)} className="text-sm text-primary underline">
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProductForm({
  initial,
  cats,
  busy,
  currency,
  onCancel,
  onSave,
  onAddCategory,
}: {
  initial: ProductRow | null;
  cats: Category[];
  busy: boolean;
  currency: string;
  onCancel: () => void;
  onSave: (payload: Record<string, unknown>, packs: PackRow[]) => Promise<boolean>;
  onAddCategory: (name: string) => Promise<Category | null>;
}) {
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    price: initial ? String(Number(initial.price_cents) / 100) : "",
    sku: initial?.sku ?? "",
    barcode: "",
    reorder: initial?.reorder_level != null ? String(initial.reorder_level) : "",
    bottle: initial?.is_returnable_bottle ?? false,
    color: initial?.color ?? "amber",
    category: initial?.category_id ?? "",
    opening: "",
    weighted: initial?.sale_mode === "weighted",
  });
  const [packs, setPacks] = useState<PackRow[]>([{ weightG: "250", price: "" }]);
  const [newCat, setNewCat] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [catBusy, setCatBusy] = useState(false);

  // Existing packet sizes, so editing a weighted product does not start from a blank list.
  useEffect(() => {
    if (!initial || initial.sale_mode !== "weighted") return;
    void (async () => {
      const { data } = await getSupabase()
        .from("pack_sizes")
        .select("id, weight_g, price_cents, is_active")
        .eq("product_id", initial.id)
        .eq("is_active", true)
        .order("weight_g");
      const rows = (data as { id: string; weight_g: number; price_cents: number }[] | null) ?? [];
      if (rows.length) {
        setPacks(rows.map((r) => ({ id: r.id, weightG: String(r.weight_g), price: String(Number(r.price_cents) / 100) })));
      }
    })();
  }, [initial]);

  const priceCents = Math.round(Number(form.price || "0") * 100);
  const packsValid =
    !form.weighted ||
    (packs.length > 0 && packs.every((p) => Number(p.weightG) > 0 && p.price !== "" && Number(p.price) >= 0));
  const valid = form.name.trim() !== "" && Number.isFinite(priceCents) && priceCents >= 0 && packsValid;

  const setPack = (i: number, patch: Partial<PackRow>) =>
    setPacks((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void onSave(
          {
            id: initial?.id ?? null,
            name: form.name.trim(),
            price_cents: priceCents,
            sku: form.sku.trim() || null,
            barcode: form.barcode.trim() || null,
            reorder_level: form.reorder ? Number(form.reorder) : 0,
            opening_stock: form.opening ? Number(form.opening) : 0,
            is_returnable_bottle: form.bottle,
            color: form.color,
            category_id: form.category || null,
            sale_mode: form.weighted ? "weighted" : "unit",
            is_active: initial?.is_active ?? true,
          },
          packs,
        );
      }}
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
    >
      <h2 className="font-semibold">{initial ? `Edit ${initial.name}` : "New product"}</h2>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-sm font-medium">Name</span>
          <input
            className="field"
            autoFocus
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Chilli Powder 100g"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            {form.weighted ? "Price (set per packet below)" : `Price (${currency})`}
          </span>
          <input
            className="field font-mono"
            inputMode="decimal"
            disabled={form.weighted}
            value={form.weighted ? "" : form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: digits(e.target.value) }))}
            placeholder={form.weighted ? "-" : "450.00"}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Barcode</span>
          <input
            className="field font-mono"
            value={form.barcode}
            onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))}
            placeholder="Scan to fill"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">SKU</span>
          <input
            className="field font-mono"
            value={form.sku}
            onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
            placeholder="Optional"
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Low stock warning at</span>
          <input
            className="field font-mono"
            inputMode="numeric"
            value={form.reorder}
            onChange={(e) => setForm((f) => ({ ...f, reorder: whole(e.target.value) }))}
            placeholder="5"
          />
        </label>

        {/* Only on create: the edit form used to offer this too, but it posted an opening movement
            rather than adding to the count, so it looked like restocking and did nothing. */}
        {!initial && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Opening stock</span>
            <input
              className="field font-mono"
              inputMode="numeric"
              value={form.opening}
              onChange={(e) => setForm((f) => ({ ...f, opening: whole(e.target.value) }))}
              placeholder="0"
            />
          </label>
        )}

        <div className="block">
          <span className="mb-1 block text-sm font-medium">Category</span>
          <div className="flex gap-2">
            <select
              className="field"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            >
              <option value="">Uncategorised</option>
              {cats.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setAddingCat((v) => !v)}
              title="New category"
              aria-label="New category"
              className="shrink-0 rounded-lg border border-border px-2.5 text-muted hover:bg-surface-2"
            >
              <Plus size={16} />
            </button>
          </div>
          {addingCat && (
            <div className="mt-2 flex gap-2">
              <input
                className="field"
                autoFocus
                value={newCat}
                onChange={(e) => setNewCat(e.target.value)}
                placeholder="e.g. Spices"
                maxLength={60}
              />
              <button
                type="button"
                disabled={!newCat.trim() || catBusy}
                onClick={async () => {
                  setCatBusy(true);
                  const made = await onAddCategory(newCat.trim());
                  setCatBusy(false);
                  if (made) {
                    setForm((f) => ({ ...f, category: made.id }));
                    setNewCat("");
                    setAddingCat(false);
                  }
                }}
                className="shrink-0 rounded-lg bg-primary px-3 text-sm font-medium text-primary-fg disabled:opacity-50"
              >
                {catBusy ? <Loader2 className="animate-spin" size={14} /> : "Add"}
              </button>
            </div>
          )}
        </div>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">Tile colour</span>
          <select
            className="field"
            value={form.color}
            onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
          >
            {COLORS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.weighted}
          onChange={(e) => setForm((f) => ({ ...f, weighted: e.target.checked }))}
        />
        <span className="text-sm">
          <span className="font-medium">Sold by weight (loose spice)</span>
          <span className="mt-0.5 block text-xs text-muted">
            The till asks which packet the customer took, then charges that packet&apos;s price.
          </span>
        </span>
      </label>

      {form.weighted && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Packet sizes</span>
            <button
              type="button"
              onClick={() => setPacks((ps) => [...ps, { weightG: "", price: "" }])}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-primary hover:bg-surface-2"
            >
              <Plus size={14} /> Add size
            </button>
          </div>
          {packs.map((p, i) => (
            <div key={p.id ?? `new-${i}`} className="flex items-center gap-2">
              <div className="flex flex-1 items-center gap-1">
                <input
                  className="field font-mono"
                  inputMode="numeric"
                  aria-label={`Weight ${i + 1} in grams`}
                  value={p.weightG}
                  onChange={(e) => setPack(i, { weightG: whole(e.target.value) })}
                  placeholder="250"
                />
                <span className="text-sm text-muted">g</span>
              </div>
              <div className="flex flex-1 items-center gap-1">
                <span className="text-sm text-muted">{currency}</span>
                <input
                  className="field font-mono"
                  inputMode="decimal"
                  aria-label={`Price for packet ${i + 1}`}
                  value={p.price}
                  onChange={(e) => setPack(i, { price: digits(e.target.value) })}
                  placeholder="180.00"
                />
              </div>
              <button
                type="button"
                aria-label={`Remove size ${i + 1}`}
                onClick={() => setPacks((ps) => ps.filter((_, j) => j !== i))}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {packs.length === 0 && <p className="text-xs text-danger">Add at least one packet size.</p>}
          <p className="text-xs text-muted">
            Packet stock starts at zero and is filled by stock movements, not typed here.
          </p>
        </div>
      )}

      <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3">
        <input
          type="checkbox"
          className="mt-0.5"
          checked={form.bottle}
          onChange={(e) => setForm((f) => ({ ...f, bottle: e.target.checked }))}
        />
        <span className="text-sm">
          <span className="font-medium">Comes in a returnable bottle</span>
          <span className="mt-0.5 block text-xs text-muted">
            Selling this records that the customer owes a bottle. The deposit is charged only if they do
            not bring it back on a later visit.
          </span>
        </span>
      </label>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!valid || busy}
          className="flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-fg disabled:opacity-50"
        >
          {busy && <Loader2 className="animate-spin" size={14} />} Save
        </button>
        <button type="button" onClick={onCancel} className="rounded-lg px-3 py-2 text-sm text-muted">
          Cancel
        </button>
      </div>
    </form>
  );
}
