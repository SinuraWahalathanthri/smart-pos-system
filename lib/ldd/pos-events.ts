/**
 * The POS event vocabulary. Every fact the business can record is one of these events, and each is
 * validated before it enters the ledger. Nothing in the application may mutate state directly.
 */

import { z } from "zod";
import type { EventDef } from "./types";

const money = z.int().min(0);
const qty = z.int().min(1);
const grams = z.int().min(1);
const iso = z.iso.datetime({ offset: true });

/* --------------------------------------------------------------- catalogue */

export const productRegistered = z.object({
  productId: z.uuid(),
  sku: z.string().min(1).max(64),
  name: z.string().min(1).max(190),
  categoryId: z.uuid(),
  /** Product-level stock when there are no pack sizes (raw material, unit items). */
  unitGrams: grams.nullable(),
});

export const productPriced = z.object({
  productId: z.uuid(),
  packSizeId: z.uuid().nullable(),
  priceCents: money,
  taxRateBp: z.int().min(0).max(10_000),
  reason: z.string().min(1).max(190),
});

/* ------------------------------------------------------------------- stock */

export const stockReceived = z.object({
  productId: z.uuid(),
  packSizeId: z.uuid().nullable(),
  qty,
  unitCostCents: money,
  batchNo: z.string().min(1).max(64).nullable(),
  expiresOn: z.iso.date().nullable(),
  supplierRef: z.string().max(64).nullable(),
});

export const stockIssued = z.object({
  productId: z.uuid(),
  packSizeId: z.uuid().nullable(),
  qty,
  reason: z.enum(["damage", "expiry", "sample", "transfer"]),
  batchId: z.uuid().nullable(),
});

export const stockAdjusted = z.object({
  productId: z.uuid(),
  packSizeId: z.uuid().nullable(),
  countedQty: z.int().min(0),
  /** The ledger's opinion at the moment of counting; kept so the variance is reproducible. */
  expectedQty: z.int(),
  reason: z.string().min(1).max(190),
});

/* ------------------------------------------------------------------- sales */

export const saleLine = z.object({
  lineId: z.uuid(),
  productId: z.uuid(),
  packSizeId: z.uuid().nullable(),
  qty,
  unitPriceCents: money,
  taxRateBp: z.int().min(0).max(10_000),
  /** Bottle-fee lines carry no stock movement. */
  kind: z.enum(["item", "bottle_fee"]),
});

export const saleCompleted = z.object({
  saleId: z.uuid(),
  receiptNo: z.int().min(1),
  deviceId: z.uuid(),
  cashierId: z.uuid(),
  shiftId: z.uuid().nullable(),
  lines: z.array(saleLine).min(1),
  discountCents: money.default(0),
  tenderedCents: money,
  method: z.enum(["cash", "card", "qr"]),
  /** Business time on the till; may precede `recordedAt` by hours when it syncs late. */
  occurredAt: iso,
});

export const saleLineVoided = z.object({
  saleId: z.uuid(),
  lineId: z.uuid(),
  qty,
  reason: z.enum(["wrong_item", "double_scan", "customer_changed_mind", "price_issue"]),
  approvedByStaffId: z.uuid(),
});

export const saleRefunded = z.object({
  refundId: z.uuid(),
  saleId: z.uuid(),
  lineId: z.uuid(),
  qty,
  restock: z.boolean(),
  reason: z.enum(["damaged", "expired", "customer_return", "wrong_item"]),
  approvedByStaffId: z.uuid(),
});

/* ----------------------------------------------------------------- bottles */

export const bottleReturned = z.object({
  productId: z.uuid(),
  saleId: z.uuid().nullable(),
  qty,
  feeUnitCents: money,
});

export const bottleFeeCharged = z.object({
  productId: z.uuid(),
  saleId: z.uuid(),
  qty,
  feeUnitCents: money,
});

/* ------------------------------------------------------------- definitions */

const def = <T>(type: string, schema: z.ZodType<T>, version = 1): EventDef<T> => ({
  type,
  version,
  schema: schema as unknown as EventDef<T>["schema"],
});

export const POS_EVENTS: EventDef<unknown>[] = [
  def("product.registered", productRegistered),
  def("product.priced", productPriced),
  def("stock.received", stockReceived),
  def("stock.issued", stockIssued),
  def("stock.adjusted", stockAdjusted),
  def("sale.completed", saleCompleted),
  def("sale.line_voided", saleLineVoided),
  def("sale.refunded", saleRefunded),
  def("bottle.returned", bottleReturned),
  def("bottle.fee_charged", bottleFeeCharged),
] as EventDef<unknown>[];

export const POS_EVENT_TYPES = POS_EVENTS.map((e) => e.type);

export type ProductRegistered = z.infer<typeof productRegistered>;
export type ProductPriced = z.infer<typeof productPriced>;
export type StockReceived = z.infer<typeof stockReceived>;
export type StockIssued = z.infer<typeof stockIssued>;
export type StockAdjusted = z.infer<typeof stockAdjusted>;
export type SaleLine = z.infer<typeof saleLine>;
export type SaleCompleted = z.infer<typeof saleCompleted>;
export type SaleLineVoided = z.infer<typeof saleLineVoided>;
export type SaleRefunded = z.infer<typeof saleRefunded>;
export type BottleReturned = z.infer<typeof bottleReturned>;
export type BottleFeeCharged = z.infer<typeof bottleFeeCharged>;
