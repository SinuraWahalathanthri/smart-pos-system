import { makeEan13 } from "../barcode";
import { toCents } from "../money";
import type { PackSize, Product, Staff } from "../types";

/**
 * Demo catalogue so the till works before any backend is connected.
 * It mirrors the shop: spices sold in branded weighted packets, plus grocery items.
 * Spice packs have barcodes on SOME sizes only, to exercise both selling routes (PLAN.md §4.1b).
 */

const SIZES: { label: string; weightG: number }[] = [
  { label: "50 g", weightG: 50 },
  { label: "100 g", weightG: 100 },
  { label: "250 g", weightG: 250 },
  { label: "500 g", weightG: 500 },
  { label: "1 kg", weightG: 1000 },
];

let serial = 1;
const code = () => makeEan13("479", serial++);

function spice(
  id: string,
  name: string,
  color: string,
  prices: [number, number, number, number, number],
  barcoded: string[],
  stock: [number, number, number, number, number],
): Product {
  const packSizes: PackSize[] = SIZES.map((s, i) => ({
    id: `${id}-${s.weightG}`,
    label: s.label,
    weightG: s.weightG,
    price: toCents(prices[i]),
    barcode: barcoded.includes(s.label) ? code() : undefined,
    stock: stock[i],
  }));
  return {
    id,
    name,
    category: "Spices",
    saleMode: "weighted",
    price: 0,
    taxRate: 0,
    stock: 0,
    packSizes,
    favourite: true,
    color,
    reorderLevel: 0,
    active: true,
  };
}

function unit(
  id: string,
  name: string,
  category: string,
  price: number,
  color: string,
  opts: Partial<Product> = {},
): Product {
  return {
    id,
    name,
    category,
    saleMode: "unit",
    price: toCents(price),
    taxRate: 0,
    stock: 40,
    barcode: code(),
    packSizes: [],
    favourite: false,
    color,
    reorderLevel: 10,
    active: true,
    ...opts,
  };
}

export function seedProducts(): Product[] {
  serial = 1;
  return [
    spice("curry", "Curry Powder", "#b45309", [95, 180, 430, 840, 1650], ["250 g", "1 kg"], [24, 12, 3, 30, 8]),
    spice("chilli", "Chilli Powder", "#b91c1c", [110, 210, 500, 980, 1900], ["250 g"], [18, 20, 14, 9, 6]),
    spice("turmeric", "Turmeric Powder", "#ca8a04", [120, 230, 550, 1080, 2100], [], [10, 10, 10, 5, 4]),
    spice("pepper", "Pepper Powder", "#44403c", [160, 310, 760, 1480, 2900], [], [8, 8, 6, 4, 0]),
    unit("marie", "Marie Biscuit", "Biscuits", 120, "#d97706", { taxRate: 18, favourite: true, stock: 60 }),
    unit("choc-cream", "Chocolate Cream Biscuit", "Biscuits", 150, "#78350f", { taxRate: 18, favourite: true }),
    unit("cream-cracker", "Cream Cracker", "Biscuits", 135, "#a16207", { taxRate: 18, stock: 6 }),
    unit("milk-glass", "Fresh Milk (glass bottle)", "Milk", 250, "#2563eb", {
      favourite: true,
      returnableBottle: true,
      stock: 36,
    }),
    unit("milk-packet", "Milk Packet 1 L", "Milk", 290, "#0891b2", { favourite: true }),
    unit("milk-powder", "Milk Powder 400 g", "Milk", 980, "#7c3aed"),
    unit("chilli-5kg", "Chilli Powder Business Pack 5 kg", "Business packs", 9200, "#991b1b", { stock: 5 }),
    unit("curry-5kg", "Curry Powder Business Pack 5 kg", "Business packs", 8100, "#92400e", { stock: 4 }),
  ];
}

/** Demo staff. PINs and badge codes are for development only; production verifies on the server. */
export const DEMO_STAFF: { staff: Omit<Staff, "salt" | "pinHash" | "badgeHash">; pin: string; badge?: string }[] = [
  { staff: { id: "owner", name: "Shop Owner", code: "1", role: "owner", active: true }, pin: "9999" },
  { staff: { id: "kamal", name: "Kamal (Supervisor)", code: "2", role: "supervisor", active: true }, pin: "2222", badge: "SUP-0002" },
  { staff: { id: "nimal", name: "Nimal (Cashier)", code: "3", role: "cashier", active: true }, pin: "3333" },
];
