"use client";

import { useMemo } from "react";
import { Star } from "lucide-react";
import { PACK_LOW_STOCK } from "@/lib/config";
import { formatMoney } from "@/lib/money";
import type { Product } from "@/lib/types";

export const FAVOURITES = "Favourites";
export const ALL = "All";

/**
 * All first, then every category A-Z. The till opens on All so nobody has to hunt for a category
 * before their first sale; Favourites stays available but is no longer the landing tab.
 */
export function categoriesOf(products: Product[]): string[] {
  const set = new Set(products.filter((p) => p.active).map((p) => p.category));
  return [ALL, ...Array.from(set).sort((a, b) => a.localeCompare(b))];
}

function stockState(p: Product): { label: string; tone: "ok" | "low" | "out" } {
  if (p.saleMode === "weighted") {
    const total = p.packSizes.reduce((n, s) => n + s.stock, 0);
    if (total <= 0) return { label: "OUT", tone: "out" };
    if (p.packSizes.some((s) => s.stock <= PACK_LOW_STOCK)) return { label: "LOW", tone: "low" };
    return { label: `${total} in`, tone: "ok" };
  }
  if (p.stock <= 0) return { label: "OUT", tone: "out" };
  if (p.stock <= p.reorderLevel) return { label: `LOW ${p.stock}`, tone: "low" };
  return { label: `${p.stock} in`, tone: "ok" };
}

const BADGE = {
  ok: "bg-surface-2 text-muted",
  low: "bg-warning-soft text-warning",
  out: "bg-danger-soft text-danger",
} as const;

export function ProductTile({ product, onPick }: { product: Product; onPick: (p: Product) => void }) {
  const stock = stockState(product);
  const cheapest = product.saleMode === "weighted" ? Math.min(...product.packSizes.map((s) => s.price)) : 0;
  const initials = product.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  return (
    <button
      type="button"
      data-tile
      onClick={() => onPick(product)}
      className={`group flex flex-col overflow-hidden rounded-xl border border-border bg-surface text-left transition hover:border-primary hover:shadow-md active:scale-[0.99] ${
        stock.tone === "out" ? "opacity-60" : ""
      }`}
    >
      <div
        className="relative flex h-20 items-center justify-center"
        style={{ background: product.imageUrl ? undefined : `${product.color}22` }}
      >
        {product.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={product.imageUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="text-3xl font-bold tracking-tight" style={{ color: product.color }}>
            {initials}
          </span>
        )}
        {product.favourite && <Star size={14} className="absolute left-2 top-2 fill-warning text-warning" />}
        <span className={`absolute right-2 top-2 rounded px-1.5 py-0.5 text-[10px] font-bold ${BADGE[stock.tone]}`}>
          {stock.label}
        </span>
      </div>
      <div className="flex flex-1 flex-col gap-0.5 px-3 py-2">
        <span className="line-clamp-2 min-h-[2.4em] text-[15px] font-semibold leading-tight">{product.name}</span>
        <span className="num text-sm text-muted">
          {product.saleMode === "weighted"
            ? `from ${formatMoney(cheapest, false)} · ${product.packSizes.length} sizes`
            : formatMoney(product.price)}
        </span>
      </div>
    </button>
  );
}

interface GridProps {
  products: Product[];
  loading?: boolean;
  category: string;
  onCategory: (c: string) => void;
  onPick: (p: Product) => void;
}

export function ProductGrid({ products, loading, category, onCategory, onPick }: GridProps) {
  const cats = useMemo(() => categoriesOf(products), [products]);
  const shown = useMemo(
    () =>
      products
        .filter((p) =>
          p.active && (category === ALL || (category === FAVOURITES ? p.favourite : p.category === category)),
        )
        .sort((a, b) => a.name.localeCompare(b.name)),
    [products, category],
  );

  /** Arrow keys move between tiles; Esc is handled by the screen (back to the scan bar). */
  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const keys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];
    if (!keys.includes(e.key)) return;
    const tiles = Array.from(e.currentTarget.querySelectorAll<HTMLElement>("[data-tile]"));
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    if (i === -1) return;
    e.preventDefault();
    if (e.key === "ArrowLeft") tiles[Math.max(0, i - 1)]?.focus();
    else if (e.key === "ArrowRight") tiles[Math.min(tiles.length - 1, i + 1)]?.focus();
    else {
      const cur = tiles[i].getBoundingClientRect();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      const candidates = tiles
        .map((t) => ({ t, r: t.getBoundingClientRect() }))
        .filter(({ r }) => (dir === 1 ? r.top > cur.top + 8 : r.top < cur.top - 8))
        .sort((a, b) => Math.abs(a.r.top - cur.top) - Math.abs(b.r.top - cur.top) || Math.abs(a.r.left - cur.left) - Math.abs(b.r.left - cur.left));
      candidates[0]?.t.focus();
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Categories" className="flex shrink-0 gap-1.5 overflow-x-auto pb-2">
        {cats.map((c, i) => (
          <button
            key={c}
            role="tab"
            type="button"
            aria-selected={c === category}
            onClick={() => onCategory(c)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition ${
              c === category
                ? "border-primary bg-primary text-primary-fg"
                : "border-border bg-surface text-muted hover:text-text"
            }`}
          >
            {c}
            {i < 9 && <span className="font-mono text-[10px] opacity-60">^{i + 1}</span>}
          </button>
        ))}
      </div>
      <div
        onKeyDown={onKeyDown}
        className="scroll-thin grid min-h-0 flex-1 grid-cols-[repeat(auto-fill,minmax(150px,1fr))] content-start gap-3 overflow-y-auto pr-1"
      >
        {shown.map((p) => (
          <ProductTile key={p.id} product={p} onPick={onPick} />
        ))}
        {loading &&
          Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-36 animate-pulse rounded-xl border border-border bg-surface-2" aria-hidden />
          ))}
        {!loading && shown.length === 0 && (
          <p className="col-span-full py-10 text-center text-muted">
            {category === ALL
              ? "No products yet. Add them in the dashboard."
              : category === FAVOURITES
                ? "No favourites yet. Mark products as favourites in the catalogue."
                : "No products in this category."}
          </p>
        )}
      </div>
    </div>
  );
}
