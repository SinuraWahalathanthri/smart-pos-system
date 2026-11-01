"use client";

import { useEffect, useState } from "react";
import { CalendarClock } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";

type Batch = {
  batch_id: string;
  product_name: string;
  option_label: string | null;
  batch_no: string | null;
  expiry_date: string;
  days_left: number;
  qty_remaining: number | string;
};

/**
 * What is about to expire (expiring_batches, 0030). Only drawn when there is something to say, so a
 * shop with nothing close to its date is not shown an empty box every time it opens Products.
 */
export function ExpiringPanel({ days = 30 }: { days?: number }) {
  const [rows, setRows] = useState<Batch[] | null>(null);

  useEffect(() => {
    void (async () => {
      const { data, error } = await getSupabase().rpc("expiring_batches", { p_days: days });
      setRows(error ? [] : ((data as Batch[] | null) ?? []));
    })();
  }, [days]);

  if (!rows || rows.length === 0) return null;
  const expired = rows.filter((r) => r.days_left < 0).length;

  return (
    <details className="rounded-xl border border-warning/40 bg-warning-soft p-3" open={expired > 0}>
      <summary className="flex cursor-pointer items-center gap-2 text-sm font-medium text-warning">
        <CalendarClock size={16} />
        {expired > 0 ? `${expired} batch${expired === 1 ? " has" : "es have"} expired · ` : ""}
        {rows.length} expiring within {days} days
      </summary>
      <table className="mt-2 w-full text-sm">
        <thead className="text-left text-xs uppercase text-muted">
          <tr>
            <th className="py-1">Product</th>
            <th className="py-1">Batch</th>
            <th className="py-1">Expires</th>
            <th className="py-1 text-right">Left</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.batch_id} className="border-t border-warning/20">
              <td className="py-1">
                {r.product_name}
                {r.option_label && <span className="text-muted"> · {r.option_label}</span>}
              </td>
              <td className="py-1 font-mono text-muted">{r.batch_no ?? "-"}</td>
              <td className={`py-1 ${r.days_left < 0 ? "font-semibold text-danger" : ""}`}>
                {new Date(r.expiry_date).toLocaleDateString()}{" "}
                <span className="text-xs text-muted">
                  ({r.days_left < 0 ? `${-r.days_left} days ago` : r.days_left === 0 ? "today" : `in ${r.days_left} days`})
                </span>
              </td>
              <td className="py-1 text-right font-mono">{Number(r.qty_remaining)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-xs text-muted">
        Take expired stock off the shelf and record it with Stock → Correct → Expired.
      </p>
    </details>
  );
}
