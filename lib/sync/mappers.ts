import type { PackSize, Product, SaleRecord } from "../types";

/** Rows as PostgREST returns them for the catalogue query (numeric columns arrive as strings). */
export interface ServerProductRow {
  id: string;
  name: string;
  sku: string | null;
  kind: string;
  sale_mode: "unit" | "weighted";
  price_cents: number | string;
  tax_rate_pct: number | string;
  stock_on_hand: number | string;
  reorder_level: number | string;
  is_favourite: boolean;
  is_returnable_bottle: boolean;
  color: string | null;
  image_path: string | null;
  is_active: boolean;
  categories: { name: string } | null;
  pack_sizes: {
    id: string;
    label: string;
    weight_g: number;
    price_cents: number | string;
    packets_on_hand: number | string;
    sort_order: number;
    is_active: boolean;
  }[];
  product_barcodes: { barcode: string; pack_size_id: string | null; is_primary: boolean }[];
}

/**
 * pack_sizes has two foreign keys to products (product_id, and packaging_product_id for the pouch a
 * packet is sold in). PostgREST refuses an embed it cannot resolve: PGRST201, "more than one
 * relationship was found". Naming the constraint picks the ownership one, so a product's own packet
 * sizes come down and the packaging link is ignored.
 */
export const CATALOGUE_SELECT =
  "id,name,sku,kind,sale_mode,price_cents,tax_rate_pct,stock_on_hand,reorder_level,is_favourite," +
  "is_returnable_bottle,color,image_path,is_active,categories(name)," +
  "pack_sizes!pack_sizes_product_id_fkey(id,label,weight_g,price_cents,packets_on_hand,sort_order,is_active)," +
  "product_barcodes(barcode,pack_size_id,is_primary)";

const num = (v: number | string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));

/** Server product row -> the shape the till uses. */
export function mapProduct(row: ServerProductRow): Product {
  const barcodes = row.product_barcodes ?? [];
  const byPack = new Map<string, string>();
  for (const b of barcodes) if (b.pack_size_id && !byPack.has(b.pack_size_id)) byPack.set(b.pack_size_id, b.barcode);
  const unitBarcode = barcodes.find((b) => !b.pack_size_id && b.is_primary) ?? barcodes.find((b) => !b.pack_size_id);

  const packSizes: PackSize[] = [...(row.pack_sizes ?? [])]
    .filter((p) => p.is_active)
    .sort((a, b) => a.sort_order - b.sort_order || a.weight_g - b.weight_g)
    .map((p) => ({
      id: p.id,
      label: p.label,
      weightG: p.weight_g,
      price: num(p.price_cents),
      barcode: byPack.get(p.id),
      stock: num(p.packets_on_hand),
    }));

  return {
    id: row.id,
    name: row.name,
    category: row.categories?.name ?? "Other",
    saleMode: row.sale_mode,
    price: num(row.price_cents),
    taxRate: num(row.tax_rate_pct),
    stock: num(row.stock_on_hand),
    barcode: unitBarcode?.barcode,
    sku: row.sku ?? undefined,
    packSizes,
    favourite: row.is_favourite,
    // Only a full URL is shown for now; Storage paths are resolved when image upload is added.
    imageUrl: row.image_path && /^https?:\/\//.test(row.image_path) ? row.image_path : undefined,
    color: row.color ?? "#78716c",
    returnableBottle: row.is_returnable_bottle,
    reorderLevel: num(row.reorder_level),
    active: row.is_active,
  };
}

/**
 * Take sales that the server has not seen yet off the pulled stock, so the till's counts stay right
 * between selling and syncing. (The server only knows about sales it has received.)
 */
export function applyUnsyncedSales(products: Product[], unsynced: SaleRecord[]): Product[] {
  if (unsynced.length === 0) return products;
  const byId = new Map(products.map((p) => [p.id, { ...p, packSizes: p.packSizes.map((s) => ({ ...s })) }]));
  for (const sale of unsynced) {
    for (const l of sale.lines) {
      if (l.kind !== "item") continue;
      const p = byId.get(l.productId);
      if (!p) continue;
      if (l.packSizeId) {
        const ps = p.packSizes.find((s) => s.id === l.packSizeId);
        if (ps) ps.stock -= l.qty;
      } else {
        p.stock -= l.qty;
      }
    }
  }
  return [...byId.values()];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuidOrNull = (v: string | undefined | null) => (v && UUID.test(v) ? v : null);

/** A completed sale -> the payload `complete_sale` expects (see supabase/migrations/0003). */
export function toSalePayload(sale: SaleRecord): Record<string, unknown> {
  return {
    id: sale.id,
    created_at: new Date(sale.createdAt).toISOString(),
    local_receipt_no: sale.receiptNo,
    cashier_id: uuidOrNull(sale.cashierId),
    subtotal_cents: sale.subtotal,
    discount_cents: sale.discount,
    total_cents: sale.total,
    tax_included_cents: sale.taxIncluded,
    bottles_returned: sale.bottlesReturned,
    bottle_fee_cents: sale.bottleFeeCharged,
    customer_id: uuidOrNull(sale.customerId),
    lines: sale.lines.map((l) => ({
      // A deposit line carries the bottled product it settles. An older till's fee line used the
      // placeholder "bottle-fee", which is not a uuid and so still maps to null.
      product_id: uuidOrNull(l.productId),
      pack_size_id: uuidOrNull(l.packSizeId),
      kind: l.kind,
      name: l.name,
      label: l.label ?? null,
      qty: l.qty,
      unit_price_cents: l.unitPrice,
      tax_rate_pct: l.taxRate,
      tax_cents: l.taxAmount,
      line_total_cents: l.lineTotal,
    })),
    voided: sale.voidedLines.map((v) => ({
      product_id: uuidOrNull(v.productId),
      pack_size_id: uuidOrNull(v.packSizeId),
      name: v.name,
      label: v.label ?? null,
      qty: v.qty,
      unit_price_cents: v.unitPrice,
      reason: v.reason,
      by: v.by,
    })),
    payments: sale.payments.map((p) => ({
      method: p.method,
      amount_cents: p.amount,
      tendered_cents: p.tendered ?? null,
      change_cents: p.change ?? null,
      reference: p.ref ?? null,
    })),
  };
}
