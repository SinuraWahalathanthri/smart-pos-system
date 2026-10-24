"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { getSupabase } from "@/lib/supabase/client";

export type Shop = {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  vat_no: string | null;
  currency: string;
  bottle_fee_cents: number;
  max_cashier_discount_pct: number;
  prices_include_tax: boolean;
};

export type Role = "owner" | "supervisor" | "cashier";

export type ShopContext = {
  onboarded: boolean;
  store?: Shop;
  role?: Role;
  stores?: { id: string; name: string; role: Role }[];
};

/**
 * Who is signed in and which shop they are looking at.
 *
 * Every dashboard screen needs this, and every screen must decide what to show from the ROLE, not
 * from what the server happened to return. The server is still the real boundary: the RPCs refuse
 * a supervisor who tries to manage staff. This hook only decides what to put on screen.
 */
export function useShop() {
  const router = useRouter();
  const [ctx, setCtx] = useState<ShopContext | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sb = getSupabase();
      const { data: session } = await sb.auth.getSession();
      if (!session.session) {
        router.replace("/login");
        return;
      }

      const [{ data: shop, error: shopErr }, { data: list }] = await Promise.all([
        sb.rpc("my_shop"),
        sb.rpc("my_stores"),
      ]);
      if (shopErr) {
        setError(shopErr.message);
        return;
      }

      const parsed = shop as ShopContext;
      if (!parsed.onboarded) {
        router.replace("/onboarding");
        return;
      }
      setCtx({
        ...parsed,
        stores: (list as { id: string; name: string; role: Role }[] | null) ?? [],
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load your shop.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Switch the store the dashboard is working in, then reload what it shows. */
  const switchStore = useCallback(
    async (id: string) => {
      // A failed switch leaves the previous shop selected, which is the safe outcome.
      try {
        await getSupabase().rpc("set_current_store", { p_store: id });
      } catch {
        /* keep the current shop */
      }
      await load();
    },
    [load],
  );

  const signOut = useCallback(async () => {
    await getSupabase().auth.signOut();
    router.replace("/login");
  }, [router]);

  return { ctx, loading, error, reload: load, switchStore, signOut };
}

/** What each role may do in the dashboard. The server enforces the same thing. */
export function permissions(role: Role | undefined) {
  return {
    manageStaff: role === "owner",
    manageProducts: role === "owner" || role === "supervisor",
    viewAnalytics: role === "owner" || role === "supervisor",
    // Lending money and recording repayments are owner/supervisor decisions, never a cashier's.
    manageCredit: role === "owner" || role === "supervisor",
    settleCredit: role === "owner" || role === "supervisor",
    // The audit trail is the owner's alone, matching 0002's audit_read policy. A supervisor reading
    // it would be able to see what the owner changed, which is not a supervisor's business.
    viewAudit: role === "owner",
    // Setting costs and the VAT rate changes what every report says, so it is owner-only. The RPCs
    // refuse a supervisor regardless of what this returns.
    manageFinanceSettings: role === "owner",
    useTill: true,
  };
}
