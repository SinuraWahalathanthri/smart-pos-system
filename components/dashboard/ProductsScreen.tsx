"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, Loader2, PackagePlus, Plus, Search, Trash2, Wand2, X } from "lucide-react";
import {
  UNITS,
  effectiveFeatures,
  profileFor,
  unitLabel,
  variantLabel,
  variantMatrix,
  type BusinessProfile,
  type Features,
  type VariantAxis,
} from "@/lib/business";
import { formatMoney } from "@/lib/money";
import { getSupabase } from "@/lib/supabase/client";
import { TILE_COLORS, tileColor } from "@/lib/sync/mappers";
import { Button, Dialog } from "../ui/Dialog";
import { DashboardShell, NotAllowed } from "./DashboardShell";
import { ExpiringPanel } from "./ExpiringPanel";
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
  unit: string | null;
  track_stock: boolean | null;
  has_expiry: boolean | null;
};

export type Category = { id: string; name: string };

/** One option on the form: a packet (weightG) or a variant (attributes). Numbers stay strings while typed. */
type OptionRow = {
  id?: string;
  label: string;
  weightG: string;
  price: string;
  attributes: Record<string, string>;
  barcode: string;
  sku: string;
  opening: string;
};

/** How the form asks "how is it sold?". `service` is a unit item that keeps no stock. */
type SellAs = "unit" | "weighted" | "variant" | "measured" | "service";

const hasOptionRows = (m: string | null | undefined) => m === "weighted" || m === "variant";

/**
 * The catalogue. Owner and supervisor only; a cashier is refused by save_product server side.
 *
 * There are no product images: this build deliberately avoids object storage. The tile colour is a
 * label so the till grid stays readable without paying for a bucket.
 */
export function ProductsScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  const store = ctx?.store;

  return (
    <DashboardShell>
      {can.manageProducts ? (
        <ProductList
          currency={store?.currency ?? "LKR"}
          canArchive={ctx?.role === "owner"}
          features={effectiveFeatures(store?.business_type, store?.features)}
          profile={profileFor(store?.business_type)}
        />
      ) : (
        <NotAllowed what="products" role={ctx?.role} />
      )}
    </DashboardShell>
  );
}

/** Strip anything that is not part of a decimal, so a stray keypress cannot become a letter. */
const digits = (v: string) => v.replace(/[^0-9.]/g, "").replace(/(\..*)\./g, "$1");
const whole = (v: string) => v.replace(/[^0-9]/g, "");
const toCents = (v: string) => Math.round(Number(v || "0") * 100);

function ProductList({
  currency,
  canArchive,
  features,
  profile,
}: {
  currency: string;
  canArchive: boolean;
  features: Features;
  profile: BusinessProfile;
}) {
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [cats, setCats] = useState<Category[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProductRow | "new" | null>(null);
  const [stockFor, setStockFor] = useState<ProductRow | null>(null);
  const [archiving, setArchiving] = useState<ProductRow | null>(null);
  const [optionStock, setOptionStock] = useState<Map<string, { total: number; count: number }>>(new Map());

  const money = (c: number) => formatMoney(c);
  const catName = useMemo(() => new Map(cats.map((c) => [c.id, c.name])), [cats]);

  async function load() {
    setLoading(true);
    const sb = getSupabase();
    const [{ data: prods, error: e1 }, { data: cats }, { data: sizes }] = await Promise.all([
      sb
        .from("products")
        .select(
          "id, name, price_cents, reorder_level, is_returnable_bottle, is_active, color, sku, kind, sale_mode, category_id, stock_on_hand, unit, track_stock, has_expiry",
        )
        .is("archived_at", null)
        .order("name"),
      sb.from("categories").select("id, name").order("sort_order"),
      // A product with options keeps its stock on them, not on the product row.
      sb.from("pack_sizes").select("product_id, packets_on_hand").eq("is_active", true),
    ]);
    setLoading(false);
    if (e1) {
      setError(e1.message);
      return;
    }
    setRows((prods as ProductRow[] | null) ?? []);
    setCats((cats as Category[] | null) ?? []);
    const totals = new Map<string, { total: number; count: number }>();
    for (const s of (sizes as { product_id: string; packets_on_hand: number | string }[] | null) ?? []) {
      const t = totals.get(s.product_id) ?? { total: 0, count: 0 };
      totals.set(s.product_id, { total: t.total + Number(s.packets_on_hand), count: t.count + 1 });
    }
    setOptionStock(totals);
  }

  useEffect(() => {
    void load();
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => r.name.toLowerCase().includes(q) || (r.sku ?? "").toLowerCase().includes(q));
  }, [rows, query]);

  async function save(payload: Record<string, unknown>, options: OptionRow[]) {
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
    // Options live in their own table and their stock may only move through stock_movements, so they
    // are written separately from the product row.
    if (id && hasOptionRows(payload.sale_mode as string)) {
      const { error: packErr } = await getSupabase().rpc("save_pack_sizes", {
        p_product: id,
        p_sizes: options.map((o, i) => ({
          id: o.id ?? null,
          label: o.label.trim() || null,
          weight_g: o.weightG ? Number(o.weightG) : null,
          attributes: o.attributes,
          price_cents: toCents(o.price),
          barcode: o.barcode.trim() || null,
          sku: o.sku.trim() || null,
          opening_stock: !o.id && o.opening ? Number(o.opening) : 0,
          sort_order: i,
        })),
      });
      if (packErr) {
        setBusy(false);
        // The product row is saved; say so, so a retry does not look like it created a duplicate.
        setError(`The product was saved, but its options were not: ${packErr.message}`);
        await load();
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

  function stockCell(r: ProductRow) {
    if (r.track_stock === false) return <span className="text-muted">—</span>;
    if (hasOptionRows(r.sale_mode)) return <span className="text-muted">{optionStock.get(r.id)?.total ?? 0}</span>;
    const n = Number(r.stock_on_hand);
    return r.sale_mode === "measured" ? `${n} ${unitLabel(r.unit ?? undefined)}` : n;
  }

  function modeTag(r: ProductRow) {
    if (r.track_stock === false) return "service";
    if (r.sale_mode === "weighted") return `${optionStock.get(r.id)?.count ?? 0} sizes`;
    if (r.sale_mode === "variant") return `${optionStock.get(r.id)?.count ?? 0} variants`;
    if (r.sale_mode === "measured") return `per ${unitLabel(r.unit ?? undefined)}`;
    return null;
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

      {features.expiry && <ExpiringPanel />}

      {editing && (
        <ProductForm
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          cats={cats}
          busy={busy}
          currency={currency}
          features={features}
          profile={profile}
          onCancel={() => setEditing(null)}
          onSave={save}
          onAddCategory={addCategory}
        />
      )}

      {archiving && (
        <ArchiveDialog
          product={archiving}
          onClose={() => setArchiving(null)}
          onDone={async () => {
            setMessage(`${archiving.name} archived. It is gone from the till and this list; its sales stay in every report.`);
            setArchiving(null);
            if (editing !== "new" && editing?.id === archiving.id) setEditing(null);
            if (stockFor?.id === archiving.id) setStockFor(null);
            await load();
          }}
        />
      )}

      {stockFor && (
        <StockPanel
          product={stockFor}
          weighted={hasOptionRows(stockFor.sale_mode)}
          variant={stockFor.sale_mode === "variant"}
          measured={stockFor.sale_mode === "measured"}
          unit={stockFor.unit ?? "pcs"}
          batches={features.expiry || !!stockFor.has_expiry}
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
        <div className="overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs uppercase text-muted">
              <tr>
                <th className="px-4 py-2">Product</th>
                <th className="px-4 py-2">Category</th>
                <th className="px-4 py-2 text-right">Price</th>
                <th className="px-4 py-2 text-right">Stock</th>
                <th className="px-4 py-2 text-right">Reorder at</th>
                {features.bottles && <th className="px-4 py-2">Bottle</th>}
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: tileColor(r.color) }} />
                      <span className="font-medium">{r.name}</span>
                      {modeTag(r) && <span className="text-xs text-muted">({modeTag(r)})</span>}
                      {!r.is_active && <span className="text-xs text-muted">(inactive)</span>}
                    </div>
                  </td>
                  <td className="px-4 py-2 text-muted">
                    {r.category_id ? (catName.get(r.category_id) ?? "-") : "-"}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {hasOptionRows(r.sale_mode) ? <span className="text-muted">per option</span> : money(Number(r.price_cents))}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">{stockCell(r)}</td>
                  <td className="px-4 py-2 text-right font-mono text-muted">
                    {r.track_stock === false || r.reorder_level == null ? "-" : Number(r.reorder_level)}
                  </td>
                  {features.bottles && <td className="px-4 py-2">{r.is_returnable_bottle ? "Returnable" : "-"}</td>}
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-3">
                      {r.track_stock !== false && (
                        <button onClick={() => setStockFor(r)} className="text-sm text-primary underline">
                          Stock
                        </button>
                      )}
                      <button onClick={() => setEditing(r)} className="text-sm text-primary underline">
                        Edit
                      </button>
                      {canArchive && (
                        <button
                          onClick={() => setArchiving(r)}
                          title="Archive (owner only)"
                          aria-label={`Archive ${r.name}`}
                          className="rounded p-1 text-muted hover:bg-surface-2 hover:text-danger"
                        >
                          <Archive size={15} />
                        </button>
                      )}
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

const SELL_AS: { id: SellAs; label: string; hint: string; needs?: keyof Features }[] = [
  { id: "unit", label: "Each", hint: "One price, counted in whole items" },
  { id: "variant", label: "Variants", hint: "Sizes, colours or styles, each with its own stock", needs: "variants" },
  { id: "weighted", label: "Pack sizes", hint: "Fixed packets such as 100 g, 250 g, 1 kg", needs: "packs" },
  { id: "measured", label: "By measure", hint: "A price per kg, litre or metre; any amount", needs: "measured" },
  { id: "service", label: "Service", hint: "No stock: a haircut, a repair, delivery", needs: "services" },
];

function sellAsOf(p: ProductRow | null): SellAs {
  if (!p) return "unit";
  if (p.track_stock === false) return "service";
  return (p.sale_mode as SellAs) ?? "unit";
}

const emptyOption = (price = ""): OptionRow => ({
  label: "",
  weightG: "",
  price,
  attributes: {},
  barcode: "",
  sku: "",
  opening: "",
});

function ProductForm({
  initial,
  cats,
  busy,
  currency,
  features,
  profile,
  onCancel,
  onSave,
  onAddCategory,
}: {
  initial: ProductRow | null;
  cats: Category[];
  busy: boolean;
  currency: string;
  features: Features;
  profile: BusinessProfile;
  onCancel: () => void;
  onSave: (payload: Record<string, unknown>, options: OptionRow[]) => Promise<boolean>;
  onAddCategory: (name: string) => Promise<Category | null>;
}) {
  const startAs = sellAsOf(initial);
  const [form, setForm] = useState({
    name: initial?.name ?? "",
    price: initial ? String(Number(initial.price_cents) / 100) : "",
    sku: initial?.sku ?? "",
    barcode: "",
    reorder: initial?.reorder_level != null ? String(initial.reorder_level) : "",
    bottle: initial?.is_returnable_bottle ?? false,
    expiry: initial?.has_expiry ?? false,
    color: tileColor(initial?.color ?? profile.theme.accent),
    category: initial?.category_id ?? "",
    opening: "",
    sellAs: startAs,
    unit: initial?.unit ?? (startAs === "service" ? "session" : "pcs"),
    active: initial?.is_active ?? true,
  });
  const [options, setOptions] = useState<OptionRow[]>(
    startAs === "weighted" || (!initial && profile.defaults.packs && !profile.defaults.variants)
      ? [{ ...emptyOption(), weightG: "250", label: "250 g" }]
      : [],
  );
  const [axes, setAxes] = useState<VariantAxis[]>(profile.axes.map((a) => ({ ...a, values: [...a.values] })));
  const [newCat, setNewCat] = useState("");
  const [addingCat, setAddingCat] = useState(false);
  const [catBusy, setCatBusy] = useState(false);

  // The modes this shop uses, plus whatever the product already is (a product made before a feature
  // was switched off must still be editable as what it is).
  const modes = SELL_AS.filter((m) => !m.needs || features[m.needs] || m.id === startAs);

  // Existing options and barcodes, so editing does not start from a blank list.
  useEffect(() => {
    if (!initial) return;
    void (async () => {
      const sb = getSupabase();
      const [{ data: sizes }, { data: codes }] = await Promise.all([
        hasOptionRows(initial.sale_mode)
          ? sb
              .from("pack_sizes")
              .select("id, label, weight_g, price_cents, attributes, sku, sort_order")
              .eq("product_id", initial.id)
              .eq("is_active", true)
              .order("sort_order")
          : Promise.resolve({ data: [] }),
        sb.from("product_barcodes").select("barcode, pack_size_id").eq("product_id", initial.id),
      ]);
      const byPack = new Map<string, string>();
      let own = "";
      for (const c of (codes as { barcode: string; pack_size_id: string | null }[] | null) ?? []) {
        if (c.pack_size_id) byPack.set(c.pack_size_id, c.barcode);
        else own ||= c.barcode;
      }
      setForm((f) => ({ ...f, barcode: own }));
      type SizeRow = {
        id: string;
        label: string;
        weight_g: number | null;
        price_cents: number;
        attributes: Record<string, string> | null;
        sku: string | null;
      };
      const rows = (sizes as SizeRow[] | null) ?? [];
      if (rows.length) {
        setOptions(
          rows.map((r) => ({
            id: r.id,
            label: r.label,
            weightG: r.weight_g ? String(r.weight_g) : "",
            price: String(Number(r.price_cents) / 100),
            attributes: r.attributes ?? {},
            barcode: byPack.get(r.id) ?? "",
            sku: r.sku ?? "",
            opening: "",
          })),
        );
        // Rebuild the axes from the saved variants so "Generate" adds to them rather than replacing.
        const found = new Map<string, string[]>();
        for (const r of rows)
          for (const [k, v] of Object.entries(r.attributes ?? {})) {
            const vals = found.get(k) ?? [];
            if (!vals.includes(v)) vals.push(v);
            found.set(k, vals);
          }
        if (found.size) setAxes([...found.entries()].map(([name, values]) => ({ name, values })));
      }
    })();
  }, [initial]);

  const sellAs = form.sellAs;
  const withOptions = sellAs === "weighted" || sellAs === "variant";
  const measured = sellAs === "measured";
  const priceCents = toCents(form.price);
  const optionsValid =
    !withOptions ||
    (options.length > 0 &&
      options.every(
        (o) =>
          o.price !== "" &&
          Number(o.price) >= 0 &&
          (sellAs === "weighted" ? Number(o.weightG) > 0 : (o.label.trim() || variantLabel(o.attributes)) !== ""),
      ));
  const valid = form.name.trim() !== "" && Number.isFinite(priceCents) && priceCents >= 0 && optionsValid;

  const setOption = (i: number, patch: Partial<OptionRow>) =>
    setOptions((os) => os.map((o, j) => (j === i ? { ...o, ...patch } : o)));

  /** Units that make sense for the chosen mode, the business type's usual ones first. */
  const unitChoices = useMemo(() => {
    const fits = UNITS.filter((u) =>
      measured ? u.measured : sellAs === "service" ? ["session", "hr", "pcs"].includes(u.id) : !u.measured,
    );
    const rank = (id: string) => {
      const i = profile.units.indexOf(id);
      return i === -1 ? 99 : i;
    };
    return [...fits].sort((a, b) => rank(a.id) - rank(b.id));
  }, [measured, sellAs, profile.units]);

  function chooseMode(m: SellAs) {
    setForm((f) => {
      const fits = UNITS.find((u) => u.id === f.unit);
      const ok = m === "measured" ? fits?.measured : m === "service" ? ["session", "hr", "pcs"].includes(f.unit) : !fits?.measured;
      const fallback = m === "measured" ? (profile.units.find((u) => UNITS.find((x) => x.id === u)?.measured) ?? "kg") : m === "service" ? "session" : "pcs";
      return { ...f, sellAs: m, unit: ok ? f.unit : fallback };
    });
    if (m === "weighted" && options.length === 0) setOptions([{ ...emptyOption(), weightG: "250", label: "250 g" }]);
  }

  /** Add every Size × Colour combination that is not on the list yet; existing rows keep their prices. */
  function generate() {
    const have = new Set(options.map((o) => (o.label.trim() || variantLabel(o.attributes)).toLowerCase()));
    const add = variantMatrix(axes)
      .filter((attrs) => !have.has(variantLabel(attrs).toLowerCase()))
      .map((attrs) => ({ ...emptyOption(form.price), attributes: attrs, label: variantLabel(attrs) }));
    setOptions((os) => [...os, ...add]);
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        void onSave(
          {
            id: initial?.id ?? null,
            name: form.name.trim(),
            price_cents: withOptions ? Math.min(...options.map((o) => toCents(o.price))) : priceCents,
            sku: form.sku.trim() || null,
            barcode: withOptions ? null : form.barcode.trim() || null,
            reorder_level: form.reorder ? Number(form.reorder) : 0,
            opening_stock: !withOptions && sellAs !== "service" && form.opening ? Number(form.opening) : 0,
            is_returnable_bottle: form.bottle,
            has_expiry: form.expiry,
            color: form.color,
            category_id: form.category || null,
            sale_mode: sellAs === "service" ? "unit" : sellAs,
            unit: withOptions ? "pcs" : form.unit,
            track_stock: sellAs !== "service",
            is_active: form.active,
          },
          options,
        );
      }}
      className="space-y-3 rounded-xl border border-border bg-surface p-4"
    >
      <h2 className="font-semibold">{initial ? `Edit ${initial.name}` : "New product"}</h2>

      <fieldset>
        <legend className="mb-1 block text-sm font-medium">How is it sold?</legend>
        <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {modes.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={sellAs === m.id}
              onClick={() => chooseMode(m.id)}
              className={`rounded-lg border-2 p-2 text-left ${sellAs === m.id ? "border-primary bg-primary-soft" : "border-border hover:border-muted"}`}
            >
              <span className="block text-sm font-semibold">{m.label}</span>
              <span className="block text-xs text-muted">{m.hint}</span>
            </button>
          ))}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block sm:col-span-2">
          <span className="mb-1 block text-sm font-medium">Name</span>
          <input
            className="field"
            autoFocus
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder={profile.example.product}
          />
        </label>

        <label className="block">
          <span className="mb-1 block text-sm font-medium">
            {sellAs === "weighted"
              ? "Price (set per packet below)"
              : sellAs === "variant"
                ? `Usual price (${currency}), for new variants`
                : measured
                  ? `Price per ${unitLabel(form.unit)} (${currency})`
                  : `Price (${currency})`}
          </span>
          <input
            className="field font-mono"
            inputMode="decimal"
            disabled={sellAs === "weighted"}
            value={sellAs === "weighted" ? "" : form.price}
            onChange={(e) => setForm((f) => ({ ...f, price: digits(e.target.value) }))}
            placeholder={sellAs === "weighted" ? "-" : "450.00"}
          />
        </label>

        {!withOptions && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium">{measured ? "Sold in" : "Counted in"}</span>
            <select className="field" value={form.unit} onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}>
              {unitChoices.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.label}
                </option>
              ))}
            </select>
          </label>
        )}

        {!withOptions && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Barcode</span>
            <input
              className="field font-mono"
              value={form.barcode}
              onChange={(e) => setForm((f) => ({ ...f, barcode: e.target.value }))}
              placeholder="Scan to fill"
            />
          </label>
        )}

        <label className="block">
          <span className="mb-1 block text-sm font-medium">SKU</span>
          <input
            className="field font-mono"
            value={form.sku}
            onChange={(e) => setForm((f) => ({ ...f, sku: e.target.value }))}
            placeholder="Optional"
          />
        </label>

        {sellAs !== "service" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Low stock warning at</span>
            <input
              className="field font-mono"
              inputMode="decimal"
              value={form.reorder}
              onChange={(e) => setForm((f) => ({ ...f, reorder: measured ? digits(e.target.value) : whole(e.target.value) }))}
              placeholder="5"
            />
          </label>
        )}

        {/* Only on create: the edit form used to offer this too, but it posted an opening movement
            rather than adding to the count, so it looked like restocking and did nothing. A product
            with options takes its opening count per option, below. */}
        {!initial && !withOptions && sellAs !== "service" && (
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Opening stock{measured ? ` (${unitLabel(form.unit)})` : ""}</span>
            <input
              className="field font-mono"
              inputMode={measured ? "decimal" : "numeric"}
              value={form.opening}
              onChange={(e) => setForm((f) => ({ ...f, opening: measured ? digits(e.target.value) : whole(e.target.value) }))}
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
                placeholder={`e.g. ${profile.example.category}`}
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

        <div className="block">
          <span className="mb-1 block text-sm font-medium">Tile colour</span>
          <div className="flex flex-wrap items-center gap-1.5">
            {Object.entries(TILE_COLORS).map(([name, hex]) => (
              <button
                key={name}
                type="button"
                title={name}
                aria-label={`Tile colour ${name}`}
                aria-pressed={form.color === hex}
                onClick={() => setForm((f) => ({ ...f, color: hex }))}
                className={`h-7 w-7 rounded-full border-2 ${form.color === hex ? "border-text" : "border-transparent"}`}
                style={{ background: hex }}
              />
            ))}
            <input
              type="color"
              value={form.color}
              aria-label="Custom tile colour"
              onChange={(e) => setForm((f) => ({ ...f, color: e.target.value }))}
              className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
            />
          </div>
        </div>
      </div>

      {sellAs === "variant" && (
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <span className="text-sm font-medium">Variant options</span>
            <p className="text-xs text-muted">
              List what varies, then generate every combination. Each variant gets its own stock, price and barcode.
            </p>
          </div>
          {axes.map((a, i) => (
            <AxisEditor
              key={i}
              axis={a}
              onChange={(next) => setAxes((xs) => xs.map((x, j) => (j === i ? next : x)))}
              onRemove={() => setAxes((xs) => xs.filter((_, j) => j !== i))}
            />
          ))}
          <div className="flex flex-wrap gap-2">
            {axes.length < 3 && (
              <button
                type="button"
                onClick={() => setAxes((xs) => [...xs, { name: xs.some((x) => x.name === "Colour") ? "Style" : "Colour", values: [] }])}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-primary hover:bg-surface-2"
              >
                <Plus size={14} /> Add option
              </button>
            )}
            <button
              type="button"
              onClick={generate}
              disabled={variantMatrix(axes).length === 0}
              className="flex items-center gap-1 rounded-lg bg-primary-soft px-2 py-1 text-sm font-medium text-primary disabled:opacity-50"
            >
              <Wand2 size={14} /> Generate variants ({variantMatrix(axes).length})
            </button>
            <button
              type="button"
              onClick={() => setOptions((os) => [...os, emptyOption(form.price)])}
              className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-primary hover:bg-surface-2"
            >
              <Plus size={14} /> Add one by hand
            </button>
          </div>
        </div>
      )}

      {withOptions && (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{sellAs === "weighted" ? "Packet sizes" : `Variants (${options.length})`}</span>
            {sellAs === "weighted" && (
              <button
                type="button"
                onClick={() => setOptions((os) => [...os, emptyOption()])}
                className="flex items-center gap-1 rounded-lg px-2 py-1 text-sm text-primary hover:bg-surface-2"
              >
                <Plus size={14} /> Add size
              </button>
            )}
          </div>
          {options.length > 0 && (
            <div className="hidden gap-2 px-0.5 text-[11px] font-semibold uppercase text-muted sm:flex">
              <span className="flex-[1.4]">{sellAs === "weighted" ? "Weight" : "Variant"}</span>
              <span className="flex-1">Price</span>
              <span className="flex-1">Barcode</span>
              {!initial || options.some((o) => !o.id) ? <span className="w-20">Opening</span> : null}
              <span className="w-8" />
            </div>
          )}
          {options.map((o, i) => (
            <div key={o.id ?? `new-${i}`} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              {sellAs === "weighted" ? (
                <div className="flex flex-[1.4] items-center gap-1">
                  <input
                    className="field font-mono"
                    inputMode="numeric"
                    aria-label={`Weight ${i + 1} in grams`}
                    value={o.weightG}
                    onChange={(e) => {
                      const g = whole(e.target.value);
                      setOption(i, { weightG: g, label: g ? (Number(g) >= 1000 && Number(g) % 1000 === 0 ? `${Number(g) / 1000} kg` : `${g} g`) : "" });
                    }}
                    placeholder="250"
                  />
                  <span className="text-sm text-muted">g</span>
                </div>
              ) : (
                <input
                  className="field flex-[1.4]"
                  aria-label={`Variant ${i + 1} name`}
                  value={o.label}
                  onChange={(e) => setOption(i, { label: e.target.value })}
                  placeholder="M / Black"
                />
              )}
              <div className="flex flex-1 items-center gap-1">
                <span className="text-sm text-muted">{currency}</span>
                <input
                  className="field font-mono"
                  inputMode="decimal"
                  aria-label={`Price for option ${i + 1}`}
                  value={o.price}
                  onChange={(e) => setOption(i, { price: digits(e.target.value) })}
                  placeholder="180.00"
                />
              </div>
              <input
                className="field flex-1 font-mono"
                aria-label={`Barcode for option ${i + 1}`}
                value={o.barcode}
                onChange={(e) => setOption(i, { barcode: e.target.value })}
                placeholder="Scan"
              />
              {!o.id ? (
                <input
                  className="field w-20 font-mono"
                  inputMode="numeric"
                  aria-label={`Opening stock for option ${i + 1}`}
                  value={o.opening}
                  onChange={(e) => setOption(i, { opening: whole(e.target.value) })}
                  placeholder="0"
                />
              ) : (
                options.some((x) => !x.id) && <span className="w-20" />
              )}
              <button
                type="button"
                aria-label={`Remove option ${i + 1}`}
                onClick={() => setOptions((os) => os.filter((_, j) => j !== i))}
                className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-danger"
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {options.length === 0 && (
            <p className="text-xs text-danger">
              {sellAs === "weighted" ? "Add at least one packet size." : "Generate or add at least one variant."}
            </p>
          )}
          <p className="text-xs text-muted">
            Opening stock is set once, when an option is created. After that, stock moves only through deliveries, sales
            and corrections (the Stock button).
          </p>
        </div>
      )}

      {(features.expiry || form.expiry) && sellAs !== "service" && (
        <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.expiry}
            onChange={(e) => setForm((f) => ({ ...f, expiry: e.target.checked }))}
          />
          <span className="text-sm">
            <span className="font-medium">Has an expiry date</span>
            <span className="mt-0.5 block text-xs text-muted">
              Deliveries ask for the batch and expiry date, and the first batch to expire is sold first.
            </span>
          </span>
        </label>
      )}

      {(features.bottles || form.bottle) && (
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
      )}

      {initial && (
        <label className="flex items-start gap-2 rounded-lg bg-surface-2 p-3">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={form.active}
            onChange={(e) => setForm((f) => ({ ...f, active: e.target.checked }))}
          />
          <span className="text-sm">
            <span className="font-medium">Sell this at the till</span>
            <span className="mt-0.5 block text-xs text-muted">
              Untick to take it off the till for now (out of season, recalled). It stays in this list and can be
              switched back on. To remove it for good, archive it instead.
            </span>
          </span>
        </label>
      )}

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

/** One axis of a variant product: its name ("Size") and its values as removable chips. */
function AxisEditor({
  axis,
  onChange,
  onRemove,
}: {
  axis: VariantAxis;
  onChange: (a: VariantAxis) => void;
  onRemove: () => void;
}) {
  const [draft, setDraft] = useState("");
  function addValues(text: string) {
    const vals = text
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v && !axis.values.some((x) => x.toLowerCase() === v.toLowerCase()));
    if (vals.length) onChange({ ...axis, values: [...axis.values, ...vals] });
    setDraft("");
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        className="field w-28"
        aria-label="Option name"
        value={axis.name}
        onChange={(e) => onChange({ ...axis, name: e.target.value })}
        placeholder="Size"
      />
      {axis.values.map((v) => (
        <span key={v} className="flex items-center gap-1 rounded-full bg-surface-2 py-0.5 pl-2.5 pr-1 text-sm">
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange({ ...axis, values: axis.values.filter((x) => x !== v) })}
            className="rounded-full p-0.5 text-muted hover:text-danger"
          >
            <X size={12} />
          </button>
        </span>
      ))}
      <input
        className="field w-40"
        aria-label={`Add ${axis.name || "option"} values`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            addValues(draft);
          }
        }}
        onBlur={() => draft.trim() && addValues(draft)}
        placeholder="Type, then Enter"
      />
      <button type="button" onClick={onRemove} aria-label={`Remove ${axis.name || "option"}`} className="rounded p-1 text-muted hover:text-danger">
        <Trash2 size={14} />
      </button>
    </div>
  );
}

/**
 * Archive a product: the owner's soft delete (archive_product()).
 *
 * Nothing is deleted - sales, stock movements and costs keep pointing at the row, so every report
 * still adds up - but the product leaves the till and this list. A reason is required because the
 * audit trail is the only place that will ever say why it went.
 */
function ArchiveDialog({
  product,
  onClose,
  onDone,
}: {
  product: ProductRow;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    if (!reason.trim()) return setError("Say why this product is being archived.");
    setBusy(true);
    setError(null);
    const { error: err } = await getSupabase().rpc("archive_product", { p_product: product.id, p_reason: reason.trim() });
    setBusy(false);
    if (err) return setError(err.message);
    await onDone();
  }

  return (
    <Dialog
      title={`Archive ${product.name}?`}
      tone="danger"
      onClose={onClose}
      onConfirm={() => void go()}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button variant="danger" onClick={() => void go()} disabled={busy}>
            {busy ? "Archiving..." : "Archive"}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <p className="text-sm text-muted">
          It disappears from the till and from this list. Past sales, stock history and costs are kept, so reports do
          not change. If you only want to stop selling it for a while, untick <b>Sell this at the till</b> in Edit
          instead.
        </p>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Why?</span>
          <input
            className="field"
            data-autofocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="No longer stocked"
          />
        </label>
      </div>
    </Dialog>
  );
}
