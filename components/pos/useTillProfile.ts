"use client";

import { useEffect } from "react";
import { useLiveQuery } from "dexie-react-hooks";
import { effectiveFeatures, profileFor, type Features, type ShopProfile } from "@/lib/business";
import { getDb } from "@/lib/data/db";
import { setCurrency } from "@/lib/money";
import { applyShopTheme } from "@/lib/theme";

/**
 * The shop's business type and features, as the till last pulled them (get_till_context, kept in
 * Dexie so it survives going offline). Before the first pull, and in local demo mode, it is the
 * legacy profile: every feature the original shop used stays on, so nothing disappears by surprise.
 */
export function useTillProfile(): { features: Features; type: string | null } {
  const store = useLiveQuery(
    async () =>
      ((await getDb().meta.get("till"))?.value as { store?: ShopProfile & { currency?: string } } | undefined)?.store ?? null,
    [],
    null,
  );
  const theme = store?.theme;
  setCurrency(store?.currency);
  // The owner's colours reach the till with the shop context; adopt them as soon as they arrive.
  useEffect(() => applyShopTheme(theme), [theme]);
  const type = store?.business_type ?? null;
  return { features: effectiveFeatures(type, store?.features), type: type ? profileFor(type).id : null };
}
