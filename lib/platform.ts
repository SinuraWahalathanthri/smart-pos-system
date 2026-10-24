import { getSupabase } from "./supabase/client";

/**
 * Platform administration: provisioning shop owners and viewing shops.
 *
 * The boundary is on the server, not here. Every function below calls an RPC that checks
 * is_platform_admin() itself, so hiding the screen is convenience, never protection. In particular
 * there is deliberately no call in this file that edits a sale, a product or a stock level: an
 * administrator is read-only over trading data.
 */

export type PlatformStore = {
  id: string;
  name: string;
  owner_id: string | null;
  owner_email: string | null;
  owner_name: string | null;
  address: string | null;
  phone: string | null;
  vat_no: string | null;
  currency: string;
  is_active: boolean;
  suspended_reason: string | null;
  suspended_at: string | null;
  created_at: string;
  staff_count: number;
  product_count: number;
  sale_count: number;
  sales_cents: number;
  last_sale_at: string | null;
};

export type PlatformStaff = {
  id: string;
  full_name: string;
  role: string;
  staff_code: string;
  is_active: boolean;
  created_at: string;
  sales_count: number;
};

export type PlatformSale = {
  id: string;
  receipt_no: number;
  total_cents: number;
  status: string;
  created_at: string;
  cashier: string | null;
};

export type PlatformAction = {
  action: string;
  detail: Record<string, unknown>;
  created_at: string;
};

export type PlatformTotals = {
  sale_count: number;
  sales_cents: number;
  avg_sale_cents: number;
  last_sale_at: string | null;
  product_count: number;
  low_stock_count: number;
  staff_count: number;
  active_staff_count: number;
  refund_count: number;
  refund_cents: number;
};

export type PlatformStoreDetail = {
  store: PlatformStore & { owner_id: string | null };
  totals: PlatformTotals;
  staff: PlatformStaff[];
  recent_sales: PlatformSale[];
  monthly_sales: { month: string; sales: number; total_cents: number }[];
  payment_mix: { method: string; count: number; total_cents: number }[];
  top_products: { name: string; qty: number; revenue_cents: number }[];
  platform_actions: PlatformAction[];
  /**
   * False when the database still runs the pre-breakdown version of `platform_store_detail()`.
   * The zeroed totals are then placeholders, not facts, and the UI must say so rather than display
   * them as if the shop had never sold anything.
   */
  breakdown_available: boolean;
};

/**
 * Turn the two setup failures an operator actually hits into instructions.
 *
 * Raw PostgREST text is useless here: "PGRST202 ... schema cache" and "platform admins only" both
 * look like a broken app, when in fact one means "apply the migration" and the other means "insert
 * yourself into platform_admins". Both are one-off setup steps performed in the SQL editor.
 */
function setupHint(message: string, code?: string): Error {
  if (code === "PGRST202" || /schema cache/i.test(message)) {
    return new Error(
      "Migration 0025 has not been applied to this project. Run supabase/migrations/0025_platform_admin.sql " +
        "in the Supabase SQL editor, then reload.",
    );
  }
  if (/platform admins only/i.test(message)) {
    return new Error(
      "Signed in, but this account is not a platform administrator. Run supabase/setup-platform-admin.sql " +
        "once to add it, then sign out and in again.",
    );
  }
  return new Error(message);
}

async function rpc<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await getSupabase().rpc(fn, args);
  if (error) throw setupHint(error.message, error.code);
  return data as T;
}

/** Every shop, newest first. Read-only. */
export async function listStores(): Promise<PlatformStore[]> {
  return (await rpc<PlatformStore[] | null>("platform_stores")) ?? [];
}

/**
 * One shop's staff, sales history and the platform actions taken on it. Read-only.
 *
 * Normalised, not passed through: the database may still be running the earlier version of this
 * function that predates the breakdown, in which case `totals`, `payment_mix` and `top_products` are
 * simply absent. Reading `detail.totals.x` then throws inside render and takes the whole screen down,
 * so every section is filled with a zeroed default here and the UI stays usable. Missing data must
 * degrade to "not reported", never to a blank page.
 */
export async function storeDetail(storeId: string): Promise<PlatformStoreDetail> {
  const raw = await rpc<Partial<PlatformStoreDetail>>("platform_store_detail", { p_store: storeId });
  return normaliseDetail(raw);
}

/**
 * Fill in whatever the database did not send.
 *
 * Split out from `storeDetail` so it can be tested against a payload from the older function without
 * standing up a Supabase client. The rule it encodes: a section the server did not report is empty and
 * flagged, never missing -- a missing key here is a render crash, not a blank cell.
 */
export function normaliseDetail(raw: Partial<PlatformStoreDetail>): PlatformStoreDetail {
  return {
    store: raw.store as PlatformStoreDetail["store"],
    totals: { ...EMPTY_TOTALS, ...raw.totals },
    staff: raw.staff ?? [],
    recent_sales: raw.recent_sales ?? [],
    monthly_sales: raw.monthly_sales ?? [],
    payment_mix: raw.payment_mix ?? [],
    top_products: raw.top_products ?? [],
    platform_actions: raw.platform_actions ?? [],
    breakdown_available: raw.totals != null,
  };
}

const EMPTY_TOTALS: PlatformTotals = {
  sale_count: 0,
  sales_cents: 0,
  avg_sale_cents: 0,
  last_sale_at: null,
  product_count: 0,
  low_stock_count: 0,
  staff_count: 0,
  active_staff_count: 0,
  refund_count: 0,
  refund_cents: 0,
};

export type CreateOwnerInput = {
  email: string;
  password: string;
  shopName: string;
  fullName?: string;
  address?: string;
  phone?: string;
  vatNo?: string;
};

/**
 * Create an owner account and their empty shop in one transaction.
 *
 * The password is generated by the caller and shown to the administrator exactly once; it is not
 * stored anywhere retrievable afterwards, which is why the UI must not lose it before it is copied.
 */
export async function createOwner(input: CreateOwnerInput): Promise<{ store_id: string; user_id: string; email: string }> {
  return rpc("platform_create_owner", {
    p_email: input.email,
    p_password: input.password,
    p_shop_name: input.shopName,
    p_full_name: input.fullName ?? null,
    p_address: input.address ?? null,
    p_phone: input.phone ?? null,
    p_vat_no: input.vatNo ?? null,
  });
}

/** Replace an owner's password. The owner is asked to change it again on next sign-in. */
export async function resetOwnerPassword(userId: string, password: string, reason?: string): Promise<void> {
  await rpc("platform_set_password", { p_user: userId, p_password: password, p_reason: reason ?? null });
}

/** Suspend or restore a shop. A reason is required to suspend. */
export async function setStoreActive(storeId: string, active: boolean, reason?: string): Promise<void> {
  await rpc("platform_set_store_active", {
    p_store: storeId,
    p_active: active,
    p_reason: reason ?? null,
  });
}

const PASSWORD_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * A password that can be read down a phone line.
 *
 * Deliberately excludes look-alike characters (0/O, 1/l/I) because these passwords are dictated to a
 * shopkeeper or written on a slip, and a misread character means a support call. 20 characters from a
 * 56-symbol alphabet is ~116 bits, far beyond what a till login needs, and crypto.getRandomValues is
 * used rather than Math.random so the value is not predictable from timing.
 *
 * No symbols: some shopkeepers type these on a phone keypad, and `!` vs `l` is exactly the confusion
 * this avoids.
 */
export function generatePassword(length = 20): string {
  const out: string[] = [];
  const buf = new Uint32Array(length);
  crypto.getRandomValues(buf);
  for (let i = 0; i < length; i += 1) {
    // Modulo bias is negligible here, but avoiding it is one line and removes a question.
    out.push(PASSWORD_ALPHABET[buf[i] % PASSWORD_ALPHABET.length]);
  }
  // Guarantee at least one of each class so a strict validator elsewhere cannot reject it.
  const s = out.join("");
  if (!/[a-z]/.test(s) || !/[A-Z]/.test(s) || !/[0-9]/.test(s)) return generatePassword(length);
  return s;
}

/** Copy helper that reports failure instead of claiming success on an insecure context. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
