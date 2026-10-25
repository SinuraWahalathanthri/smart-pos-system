"use client";

import { useLiveQuery } from "dexie-react-hooks";
import { getDb } from "@/lib/data/db";
import { isConnected } from "@/lib/supabase/client";
import { usePos } from "@/lib/store";
import { ReturnBottlesForm } from "../bottles/ReturnBottlesForm";
import { Dialog, Button } from "../ui/Dialog";

/**
 * Register bottles coming back, at the counter (F7).
 *
 * Only reachable once a customer is attached - a bottle belongs to a person, not to a bill, which is
 * what lets the dashboard say who still has them. The dialog is a thin wrapper: the same form backs
 * the owner's bottle screen, so the shop's rule cannot drift between the counter and the office.
 */
export function BottleReturnDialog({ onClose }: { onClose: () => void }) {
  const customerId = usePos((s) => s.customerId);
  const customerName = usePos((s) => s.customerName);
  const setCustomerBottles = usePos((s) => s.setCustomerBottles);
  const deposits = usePos((s) => s.deposits);
  const addDeposit = usePos((s) => s.addDeposit);

  // The deposit comes from the synced shop settings and nowhere else: it is what goes on the bill,
  // so a guessed default would charge the customer a number the owner never set. null = loading,
  // undefined = this till has not synced the settings yet.
  const feeCents = useLiveQuery(async () => {
    const till = (await getDb().meta.get("till"))?.value as { store?: { bottle_fee_cents?: number } } | undefined;
    const fee = till?.store?.bottle_fee_cents;
    return typeof fee === "number" && fee > 0 ? fee : undefined;
  }, [], null as number | null | undefined);
  const pending = Object.fromEntries((deposits ?? []).map((d) => [d.productId, d.qty]));

  if (!isConnected()) {
    return (
      <Dialog title="Bottles" onClose={onClose} onConfirm={onClose} width="max-w-sm">
        <p className="text-sm text-muted">Bottle returns need a database connection.</p>
      </Dialog>
    );
  }

  if (!customerId) {
    return (
      <Dialog title="Bottles" onClose={onClose} onConfirm={onClose} width="max-w-sm">
        <p className="text-sm text-muted">
          Attach the customer first (F5). Bottles belong to a person, so the shop can tell who still
          has them.
        </p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title={`Bottles - ${customerName ?? "customer"}`}
      onClose={onClose}
      width="max-w-md"
      footer={
        <Button variant="primary" onClick={onClose} keycap="Enter">
          Done
        </Button>
      }
    >
      <ReturnBottlesForm
        customerId={customerId}
        customerName={customerName ?? null}
        feeCents={feeCents ?? 0}
        withSale
        pending={pending}
        onCharge={
          feeCents
            ? (r) => addDeposit({ productId: r.product_id, name: r.name, unitPrice: feeCents })
            : undefined
        }
        onChanged={setCustomerBottles}
      />
      {feeCents === undefined && (
        <p className="mt-2 text-xs text-warning">
          The shop&apos;s bottle deposit has not reached this till yet, so a deposit cannot be added
          to the bill. Returns still work.
        </p>
      )}
    </Dialog>
  );
}

