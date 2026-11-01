/**
 * What kind of business a shop is, and what that changes (0030).
 *
 * A clothing shop and a grocery do not sell the same way. Rather than one screen per trade, every shop
 * gets the same catalogue and till, and its business type decides which of the selling modes and
 * features are switched on by default, which units are offered, and what the screens call things.
 * The owner can override any feature in Settings; `stores.features` holds only those overrides, so a
 * shop that never touched them follows its type's defaults, including improvements made later.
 *
 * Nothing here is a permission. The server accepts every selling mode from every shop: turning a
 * feature off only tidies the screens.
 */

export type BusinessType =
  | "retail"
  | "fashion"
  | "electronics"
  | "hardware"
  | "grocery"
  | "restaurant"
  | "bakery"
  | "pharmacy"
  | "beauty"
  | "books"
  | "services"
  | "wholesale"
  | "manufacturing"
  | "other";

export type Feature =
  | "packs" // the same product in fixed sizes, each its own price and stock (spice packets, paint tins)
  | "variants" // size / colour combinations (clothing, shoes)
  | "measured" // sold in a decimal amount of a unit (loose rice by the kg, cable by the metre)
  | "expiry" // batches and expiry dates on receipt, first-to-expire sold first
  | "bottles" // returnable bottles and containers, with deposits
  | "production" // turning raw stock into products (repacking, baking)
  | "services"; // items with no stock at all (a haircut, a repair)

export type Features = Record<Feature, boolean>;

export const FEATURES: { id: Feature; label: string; hint: string }[] = [
  { id: "variants", label: "Variants", hint: "One product in several sizes and colours, each with its own stock and barcode." },
  { id: "packs", label: "Pack sizes", hint: "The same product in fixed sizes, such as 100 g, 250 g and 1 kg packets." },
  { id: "measured", label: "Sell by measure", hint: "Ring up a decimal amount: 0.75 kg of rice, 2.5 m of cable." },
  { id: "services", label: "Services", hint: "Items with no stock, such as a haircut, a repair or delivery." },
  { id: "expiry", label: "Batches and expiry dates", hint: "Record batch and expiry on delivery; see what expires soon." },
  { id: "bottles", label: "Returnable bottles", hint: "Track bottles and containers customers owe back, with deposits." },
  { id: "production", label: "Production", hint: "Turn raw stock into products you sell, with the cost worked out." },
];

/** Counting units. Must match public.is_product_unit() in 0030. */
export const UNITS: { id: string; label: string; measured: boolean }[] = [
  { id: "pcs", label: "piece", measured: false },
  { id: "kg", label: "kg", measured: true },
  { id: "g", label: "g", measured: true },
  { id: "l", label: "litre", measured: true },
  { id: "ml", label: "ml", measured: true },
  { id: "m", label: "metre", measured: true },
  { id: "cm", label: "cm", measured: true },
  { id: "ft", label: "foot", measured: true },
  { id: "yd", label: "yard", measured: true },
  { id: "sqft", label: "sq ft", measured: true },
  { id: "pair", label: "pair", measured: false },
  { id: "box", label: "box", measured: false },
  { id: "pack", label: "pack", measured: false },
  { id: "dozen", label: "dozen", measured: false },
  { id: "set", label: "set", measured: false },
  { id: "roll", label: "roll", measured: false },
  { id: "bottle", label: "bottle", measured: false },
  { id: "hr", label: "hour", measured: true },
  { id: "session", label: "session", measured: false },
];

export const unitLabel = (id: string | undefined) => UNITS.find((u) => u.id === id)?.label ?? id ?? "piece";
export const isMeasuredUnit = (id: string | undefined) => UNITS.find((u) => u.id === id)?.measured ?? false;

/** A dimension of a variant product, with the values a shop of this type usually needs. */
export type VariantAxis = { name: string; values: string[] };

export interface BusinessProfile {
  id: BusinessType;
  label: string;
  /** Shown under the label at registration and in Settings. */
  hint: string;
  defaults: Partial<Features>;
  /** Units offered first on the product form. Every unit stays available. */
  units: string[];
  /** Starting axes for a new variant product. */
  axes: VariantAxis[];
  /** Placeholder text for a new product's name and category. */
  example: { product: string; category: string };
  /** A suggested starting look; the owner can change it in Settings. */
  theme: { accent: string; tone: Tone };
}

export type Tone = "warm" | "neutral" | "cool" | "fresh" | "rose" | "midnight";

const CLOTHING_SIZES = ["XS", "S", "M", "L", "XL", "XXL"];

export const BUSINESS_PROFILES: BusinessProfile[] = [
  {
    id: "retail",
    label: "General retail",
    hint: "Gift shops, variety stores, anything sold by the piece",
    defaults: { variants: true },
    units: ["pcs", "pack", "box", "set"],
    axes: [{ name: "Size", values: [] }],
    example: { product: "Ceramic mug", category: "Kitchen" },
    theme: { accent: "#4f46e5", tone: "neutral" },
  },
  {
    id: "fashion",
    label: "Clothing, shoes and accessories",
    hint: "Sizes and colours, each with its own stock",
    defaults: { variants: true },
    units: ["pcs", "pair", "set"],
    axes: [
      { name: "Size", values: CLOTHING_SIZES },
      { name: "Colour", values: ["Black", "White", "Navy"] },
    ],
    example: { product: "Linen shirt", category: "Shirts" },
    theme: { accent: "#be185d", tone: "rose" },
  },
  {
    id: "electronics",
    label: "Electronics and mobile",
    hint: "Phones, accessories, repairs",
    defaults: { variants: true, services: true },
    units: ["pcs", "set", "box"],
    axes: [
      { name: "Storage", values: ["64 GB", "128 GB", "256 GB"] },
      { name: "Colour", values: ["Black", "Silver"] },
    ],
    example: { product: "USB-C charger 20W", category: "Chargers" },
    theme: { accent: "#4f46e5", tone: "cool" },
  },
  {
    id: "hardware",
    label: "Hardware and building supplies",
    hint: "Tools, paint, cable and pipe by the metre",
    defaults: { measured: true, packs: true, variants: true },
    units: ["pcs", "m", "kg", "ft", "box", "roll", "l"],
    axes: [{ name: "Size", values: [] }],
    example: { product: "Electrical cable 2.5 mm", category: "Electrical" },
    theme: { accent: "#c2410c", tone: "neutral" },
  },
  {
    id: "grocery",
    label: "Grocery or supermarket",
    hint: "Packaged and loose food, household goods",
    defaults: { measured: true, packs: true, expiry: true },
    units: ["pcs", "kg", "g", "l", "ml", "pack", "dozen", "bottle"],
    axes: [{ name: "Size", values: [] }],
    example: { product: "Basmati rice", category: "Rice and grains" },
    theme: { accent: "#15803d", tone: "fresh" },
  },
  {
    id: "restaurant",
    label: "Restaurant or café",
    hint: "Food and drink served to order",
    defaults: { variants: true, services: true, production: true },
    units: ["pcs", "set", "bottle"],
    axes: [{ name: "Portion", values: ["Regular", "Large"] }],
    example: { product: "Chicken kottu", category: "Mains" },
    theme: { accent: "#b45309", tone: "warm" },
  },
  {
    id: "bakery",
    label: "Bakery and sweets",
    hint: "Baked daily, sold by the piece or weight",
    defaults: { measured: true, expiry: true, production: true },
    units: ["pcs", "kg", "g", "dozen", "box"],
    axes: [{ name: "Size", values: ["Small", "Large"] }],
    example: { product: "Butter cake", category: "Cakes" },
    theme: { accent: "#a16207", tone: "warm" },
  },
  {
    id: "pharmacy",
    label: "Pharmacy",
    hint: "Medicines with batches and expiry dates",
    defaults: { expiry: true, packs: true },
    units: ["pcs", "box", "bottle", "pack", "ml"],
    axes: [{ name: "Strength", values: [] }],
    example: { product: "Paracetamol 500 mg", category: "Pain relief" },
    theme: { accent: "#0f766e", tone: "cool" },
  },
  {
    id: "beauty",
    label: "Beauty and cosmetics",
    hint: "Shades and sizes, with expiry dates",
    defaults: { variants: true, expiry: true, services: true },
    units: ["pcs", "ml", "g", "set"],
    axes: [{ name: "Shade", values: [] }],
    example: { product: "Matte lipstick", category: "Lips" },
    theme: { accent: "#9d174d", tone: "rose" },
  },
  {
    id: "books",
    label: "Books and stationery",
    hint: "Titles, school supplies, printing",
    defaults: { variants: true, services: true },
    units: ["pcs", "pack", "box", "set"],
    axes: [{ name: "Edition", values: [] }],
    example: { product: "A4 exercise book 80 pages", category: "Exercise books" },
    theme: { accent: "#1e40af", tone: "neutral" },
  },
  {
    id: "services",
    label: "Services",
    hint: "Salon, repairs, laundry, sold by the job or hour",
    defaults: { services: true },
    units: ["session", "hr", "pcs"],
    axes: [{ name: "Duration", values: ["30 min", "60 min"] }],
    example: { product: "Haircut", category: "Hair" },
    theme: { accent: "#7e22ce", tone: "neutral" },
  },
  {
    id: "wholesale",
    label: "Wholesale or distribution",
    hint: "Selling in bulk to other businesses",
    defaults: { packs: true, measured: true, expiry: true },
    units: ["box", "pcs", "kg", "pack", "dozen", "l"],
    axes: [{ name: "Pack", values: [] }],
    example: { product: "Sugar 50 kg sack", category: "Bulk" },
    theme: { accent: "#334155", tone: "cool" },
  },
  {
    id: "manufacturing",
    label: "Manufacturer with a shop",
    hint: "Makes what it sells: spices, dairy, snacks",
    defaults: { packs: true, measured: true, bottles: true, production: true, expiry: true },
    units: ["pcs", "kg", "g", "l", "pack", "bottle"],
    axes: [{ name: "Size", values: [] }],
    example: { product: "Chilli powder", category: "Spices" },
    theme: { accent: "#c2410c", tone: "warm" },
  },
  {
    id: "other",
    label: "Something else",
    hint: "Start simple and switch features on in Settings",
    defaults: { variants: true, measured: true, services: true },
    units: ["pcs", "kg", "l", "m", "hr"],
    axes: [{ name: "Option", values: [] }],
    example: { product: "Item name", category: "General" },
    theme: { accent: "#4f46e5", tone: "neutral" },
  },
];

/** Registration and Settings list these; ids must match public.is_business_type() in 0030. */
export const BUSINESS_TYPES = BUSINESS_PROFILES.map(({ id, label, hint }) => ({ id, label, hint }));

const NONE: Features = {
  packs: false,
  variants: false,
  measured: false,
  expiry: false,
  bottles: false,
  production: false,
  services: false,
};

/**
 * A shop that existed before business types (business_type null) keeps exactly what it had: every
 * feature the original spice-and-dairy shop used stays on.
 */
const LEGACY: Features = { ...NONE, packs: true, bottles: true, production: true };

export function profileFor(type: string | null | undefined): BusinessProfile {
  return BUSINESS_PROFILES.find((p) => p.id === type) ?? BUSINESS_PROFILES.find((p) => p.id === "manufacturing")!;
}

/** The features in force: the type's defaults with the owner's overrides on top. */
export function effectiveFeatures(type: string | null | undefined, overrides?: Partial<Features> | null): Features {
  const base = type ? { ...NONE, ...(BUSINESS_PROFILES.find((p) => p.id === type)?.defaults ?? {}) } : LEGACY;
  const out = { ...base };
  for (const f of Object.keys(NONE) as Feature[]) {
    if (typeof overrides?.[f] === "boolean") out[f] = overrides[f] as boolean;
  }
  return out;
}

/** Only the features that differ from the type's defaults, which is what stores.features keeps. */
export function featureOverrides(type: string | null | undefined, chosen: Features): Partial<Features> {
  const base = effectiveFeatures(type, null);
  const out: Partial<Features> = {};
  for (const f of Object.keys(NONE) as Feature[]) if (chosen[f] !== base[f]) out[f] = chosen[f];
  return out;
}

/** The shape stores carry in my_shop() / get_till_context(). */
export interface ShopProfile {
  business_type?: string | null;
  features?: Partial<Features> | null;
  theme?: { accent?: string; tone?: Tone; mode?: "light" | "dark" | "system" } | null;
}

/** How a product is sold. Must match the sale_mode enum (0001 + 0030). */
export type SaleModeId = "unit" | "weighted" | "variant" | "measured";

/**
 * Every combination of the axes' values, in order: Size × Colour gives S/Black, S/White, M/Black...
 * Axes with no values are skipped, so a half-filled form still produces something sensible.
 */
export function variantMatrix(axes: VariantAxis[]): Record<string, string>[] {
  const used = axes.filter((a) => a.name.trim() && a.values.length > 0);
  if (used.length === 0) return [];
  let out: Record<string, string>[] = [{}];
  for (const axis of used) {
    const next: Record<string, string>[] = [];
    for (const partial of out) for (const v of axis.values) next.push({ ...partial, [axis.name.trim()]: v });
    out = next;
  }
  return out;
}

/** "M / Black" - the same rule save_pack_sizes uses when no label is given. */
export const variantLabel = (attrs: Record<string, string>) => Object.values(attrs).join(" / ");

/** A product the till sells by picking one of its options (packets or variants), never on its own. */
export const hasOptions = (p: { saleMode: string }) => p.saleMode === "weighted" || p.saleMode === "variant";
