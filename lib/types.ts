import type { Cents } from "./money";

export type Role = "owner" | "supervisor" | "cashier";
export type SaleMode = "unit" | "weighted";
export type PayMethod = "cash" | "card" | "qr" | "credit";

export interface PackSize {
  id: string;
  label: string; // "250 g"
  weightG: number;
  price: Cents; // fixed price for this packet size, tax-inclusive
  barcode?: string;
  stock: number; // packets on hand
}

export interface Product {
  id: string;
  name: string;
  category: string;
  saleMode: SaleMode;
  price: Cents; // unit items only
  taxRate: number; // percent, prices include tax
  stock: number; // unit items: pieces
  barcode?: string;
  sku?: string;
  packSizes: PackSize[]; // weighted items only
  favourite: boolean;
  imageUrl?: string;
  color: string; // tile accent when there is no picture
  returnableBottle?: boolean; // glass-bottle milk: triggers the non-return fee rule
  reorderLevel: number;
  active: boolean;
}

export interface Staff {
  id: string;
  name: string;
  code: string; // till login code
  role: Role;
  salt: string;
  pinHash: string;
  badgeHash?: string; // supervisors: hash of the ID-badge barcode
  active: boolean;
}

/** One line on the bill. Voided portions stay on the bill as separate struck-through lines. */
export interface BillLine {
  id: string;
  productId: string;
  packSizeId?: string;
  name: string;
  label?: string; // pack size label
  qty: number;
  unitPrice: Cents;
  taxRate: number;
  returnableBottle?: boolean;
  voided?: { reason: string; by: string; at: number };
}

/**
 * A bottle the attached customer keeps and pays the deposit for, on this bill.
 *
 * The deposit is a bill line rather than a ledger row on its own, so the money is in the sale's
 * total, its payments and the shift's cash. complete_sale settles that loan from the line.
 */
export interface BottleDeposit {
  /** The bottled product whose loan this settles. */
  productId: string;
  name: string;
  qty: number;
  unitPrice: Cents;
}

export interface BillSnapshot {
  lines: BillLine[];
  /** Optional so bills saved by an older till (and fixtures) still load. */
  deposits?: BottleDeposit[];
  discount: Cents;
  /** Set when the cashier attached a customer; every bottled line then belongs to that person. */
  customerId?: string;
  customerName?: string;
}

export interface SaleLine {
  productId: string;
  packSizeId?: string;
  name: string;
  label?: string;
  qty: number;
  unitPrice: Cents;
  taxRate: number;
  lineTotal: Cents;
  taxAmount: Cents;
  kind: "item" | "bottle_fee";
}

export interface SaleRecord {
  id: string; // client-generated uuid, so offline sales can sync safely
  receiptNo: number;
  createdAt: number;
  cashierId: string;
  cashierName: string;
  lines: SaleLine[];
  voidedLines: {
    productId: string;
    packSizeId?: string;
    name: string;
    label?: string;
    qty: number;
    unitPrice: Cents;
    reason: string;
    by: string;
  }[];
  subtotal: Cents;
  discount: Cents;
  total: Cents;
  taxIncluded: Cents;
  bottlesReturned: number;
  bottleFeeCharged: Cents;
  customerId?: string;
  customerName?: string;
  payments: { method: PayMethod; amount: Cents; tendered?: Cents; change?: Cents; ref?: string }[];
  /** pending: waiting to upload. synced: the server has it. failed: the server refused it (see syncError). */
  syncStatus: "pending" | "synced" | "failed";
  serverReceiptNo?: number;
  syncError?: string;
}

export interface HeldBill extends BillSnapshot {
  id: string;
  createdAt: number;
  cashierName: string;
}
