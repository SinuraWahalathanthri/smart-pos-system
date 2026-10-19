"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useLiveQuery } from "dexie-react-hooks";
import { activeLines, computeBill, newId } from "@/lib/bill";
import { ALLOW_SELL_OUT_OF_STOCK } from "@/lib/config";
import { ensureSeeded, getDb } from "@/lib/data/db";
import { formatMoney } from "@/lib/money";
import { SHORTCUTS, shortcutForEvent } from "@/lib/shortcuts";
import { playCue } from "@/lib/sound";
import { shouldOpenGate, usePos } from "@/lib/store";
import { asSbClient, getSupabase, isConnected } from "@/lib/supabase/client";
import { startSync } from "@/lib/sync/engine";
import type { PackSize, Product } from "@/lib/types";
import { ApprovalDialog } from "./ApprovalDialog";
import { BillPanel } from "./BillPanel";
import { CalculatorDialog } from "./CalculatorDialog";
import { Header } from "./Header";
import { PaymentDialog } from "./PaymentDialog";
import { PickerDialog, type PickItem } from "./PickerDialog";
import { ALL, categoriesOf, ProductGrid } from "./ProductGrid";
import { ScanBar } from "./ScanBar";
import { ShortcutBar } from "./ShortcutBar";
import { DiscountDialog, HeldDialog, HelpDialog, LockScreen, QtyDialog, SuccessDialog } from "./SmallDialogs";
import { CustomerDialog } from "./CustomerDialog";
import { CustomerGate, type CustomerCard } from "./CustomerGate";
import { BottleReturnDialog } from "./BottleReturnDialog";
import { Toaster } from "./Toaster";
import { VoidDialog } from "./VoidDialog";
import { WeightPicker } from "./WeightPicker";

const isTextField = (el: Element | null) =>
  !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || (el as HTMLElement).isContentEditable);

export function PosScreen() {
  const router = useRouter();
  // false during server render and hydration, true once running in the browser.
  const hydrated = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const [category, setCategory] = useState(ALL);
  const scanRef = useRef<HTMLInputElement>(null);

  const session = usePos((s) => s.session);
  const locked = usePos((s) => s.locked);
  const dialog = usePos((s) => s.dialog);
  const approval = usePos((s) => s.approval);
  const gating = usePos((s) => s.gating);
  const billCustomer = usePos((s) => s.customerId);
  const billLineCount = usePos((s) => s.lines.length);

  useEffect(() => {
    void ensureSeeded();
  }, []);

  // Connected: upload queued sales and refresh the catalogue in the background (lib/sync/engine.ts).
  const staffId = session?.id;
  useEffect(() => {
    if (!isConnected() || !hydrated || !staffId) return;
    return startSync(asSbClient(getSupabase()), getDb());
  }, [hydrated, staffId]);

  useEffect(() => {
    if (hydrated && !session) router.replace("/login");
  }, [hydrated, session, router]);
  // Ask who the sale is for before the first item is scanned. See shouldOpenGate for the rule.
  const gateOpen = shouldOpenGate({
    gating,
    hydrated,
    session,
    locked,
    approval,
    dialog,
    // "a line" is all the rule needs, and subscribing to the count (not the array) avoids
    // re-rendering on every quantity nudge.
    lines: billLineCount ? [1] : [],
    customerId: billCustomer,
  });
  const finishGate = useCallback((c: CustomerCard | null) => {
    const s = usePos.getState();
    // setCustomerCard carries the points/tab/bottles the bill panel and the invoice both show.
    s.setCustomerCard(c);
    s.setGating(false);
    if (c && c.bottles_out > 0) {
      s.notify(`${c.name} has ${c.bottles_out} bottle${c.bottles_out === 1 ? "" : "s"} to return`, "warn");
    }
    setTimeout(() => scanRef.current?.focus(), 0);
  }, []);

  // undefined until the first read finishes, so the grid can show "loading" instead of "empty".
  const liveProducts = useLiveQuery(() => getDb().products.toArray(), [], undefined);
  const products = useMemo<Product[]>(() => liveProducts ?? [], [liveProducts]);
  const productsLoading = liveProducts === undefined;

  /** barcode / sku -> what to add. Spice pack barcodes resolve to a specific pack size. */
  const lookup = useMemo(() => {
    const map = new Map<string, { product: Product; pack?: PackSize }>();
    for (const p of products) {
      if (!p.active) continue;
      if (p.barcode) map.set(p.barcode, { product: p });
      if (p.sku) map.set(p.sku.toLowerCase(), { product: p });
      for (const ps of p.packSizes) if (ps.barcode) map.set(ps.barcode, { product: p, pack: ps });
    }
    return map;
  }, [products]);

  // A timeout, not requestAnimationFrame: rAF never fires in a page that isn't being painted.
  // It re-checks when it fires: a dialog may have opened in the meantime and must keep focus.
  const focusScan = useCallback(() => {
    setTimeout(() => {
      const s = usePos.getState();
      if (!s.dialog && !s.approval && !s.locked) scanRef.current?.focus();
    }, 0);
  }, []);

  // Return focus to the scan bar whenever nothing is open (DESIGN.md §7.1).
  useEffect(() => {
    if (hydrated && session && !dialog && !approval && !locked) focusScan();
  }, [hydrated, session, dialog, approval, locked, focusScan]);

  const addWithChecks = useCallback((p: Product, pack?: PackSize) => {
    const s = usePos.getState();
    const out = pack ? pack.stock <= 0 : p.saleMode === "unit" && p.stock <= 0;
    if (out && !ALLOW_SELL_OUT_OF_STOCK) {
      s.notify(`${p.name}${pack ? " " + pack.label : ""} is out of stock`, "error");
      playCue("error");
      return;
    }
    s.addProduct(p, pack);
    playCue("ok");
    if (out) s.notify(`Stock shows 0 for ${p.name}${pack ? " " + pack.label : ""}. Check the shelf.`, "warn");
  }, []);

  const pickProduct = useCallback(
    (p: Product) => {
      if (p.saleMode === "weighted") usePos.getState().openDialog({ type: "weight", product: p });
      else addWithChecks(p);
    },
    [addWithChecks],
  );

  const handleScan = useCallback(
    (code: string) => {
      const hit = lookup.get(code) ?? lookup.get(code.toLowerCase());
      if (!hit) {
        playCue("error");
        usePos.getState().notify(`Not found: ${code}. Ask a supervisor to add this product.`, "error");
        return;
      }
      if (hit.product.saleMode === "weighted" && !hit.pack) {
        pickProduct(hit.product);
        return;
      }
      addWithChecks(hit.product, hit.pack);
    },
    [lookup, addWithChecks, pickProduct],
  );

  const startVoid = useCallback(async () => {
    const s = usePos.getState();
    const active = activeLines(s.lines);
    if (active.length === 0) return s.notify("Nothing on the bill to remove", "warn");
    const target = active.find((l) => l.id === s.selectedId) ?? active[active.length - 1];
    playCue("attention");
    const who = await s.requestApproval(
      `Remove from bill: ${target.name}${target.label ? " " + target.label : ""} (${target.qty} × ${formatMoney(target.unitPrice, false)})`,
    );
    if (who) s.openDialog({ type: "void", lineId: target.id, approver: who.name });
    else focusScan();
  }, [focusScan]);

  const hold = useCallback(async () => {
    const s = usePos.getState();
    if (s.lines.length === 0) return s.openDialog({ type: "held" });
    await getDb().held.add({
      id: newId(),
      createdAt: Date.now(),
      cashierName: s.session?.name ?? "",
      ...s.snapshot(),
    });
    s.clearBill();
    s.notify("Bill held. Press F9 on an empty bill to recall it.", "success");
    playCue("ok");
  }, []);

  const runAction = useCallback(
    (id: string) => {
      const s = usePos.getState();
      switch (id) {
        case "qty":
          return s.selectedId ? s.openDialog({ type: "qty" }) : s.notify("Select a bill line first (↑/↓)", "warn");
        case "search": return s.openDialog({ type: "search" });
        case "calc": return s.openDialog({ type: "calc" });
        case "customer": return s.openDialog({ type: "customer" });
        case "discount":
          return s.lines.length ? s.openDialog({ type: "discount" }) : s.notify("Add items before a discount", "warn");
        case "bottle": return s.openDialog({ type: "bottles" });
        case "bottle-undo": return s.openDialog({ type: "bottles" });
        case "void": return void startVoid();
        case "hold": return void hold();
        case "exact":
          return computeBill(s.snapshot()).total > 0 ? s.openDialog({ type: "pay", exact: true }) : s.notify("Nothing to pay", "warn");
        case "pay":
          return computeBill(s.snapshot()).total > 0 ? s.openDialog({ type: "pay" }) : s.notify("Add items to the bill first", "warn");
        case "palette": return s.openDialog({ type: "palette" });
        case "help": return s.openDialog({ type: "help" });
        case "lock": return s.setLocked(true);
      }
    },
    [startVoid, hold],
  );

  // Global keyboard handling (only while no dialog, approval or lock is open).
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const s = usePos.getState();
      if (s.locked || s.approval || s.dialog || !s.session) return;

      const id = shortcutForEvent(e);
      if (id) {
        e.preventDefault();
        runAction(id);
        return;
      }

      const scan = scanRef.current;
      const active = document.activeElement;
      const scanEmpty = !!scan && scan.value === "";
      const onScanOrBody = active === scan || active === document.body;

      if (e.ctrlKey && /^[1-9]$/.test(e.key)) {
        const cats = categoriesOf(products);
        const c = cats[Number(e.key) - 1];
        if (c) {
          e.preventDefault();
          setCategory(c);
        }
        return;
      }

      if (e.key === "Escape") {
        if (active !== scan) {
          e.preventDefault();
          scan?.focus();
        }
        return;
      }

      if (onScanOrBody && scanEmpty) {
        if (e.key === "?") return (e.preventDefault(), runAction("help"));
        if (e.key === "ArrowDown") return (e.preventDefault(), s.moveSelection(1));
        if (e.key === "ArrowUp") return (e.preventDefault(), s.moveSelection(-1));
        if ((e.key === "+" || e.key === "=") && s.selectedId) return (e.preventDefault(), s.nudgeQty(s.selectedId, 1));
        if ((e.key === "-" || e.key === "_") && s.selectedId) return (e.preventDefault(), s.nudgeQty(s.selectedId, -1));
        if (e.key === "Delete") return (e.preventDefault(), void startVoid());
      }

      // A scanner types into whatever has focus. Send printable keys to the scan bar.
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextField(active)) {
        if (e.key === " " && active instanceof HTMLButtonElement) return; // Space activates a focused tile
        scan?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [products, runAction, startVoid]);

  // Items for F3 search and the Ctrl+K palette.
  const productItems = useMemo<PickItem[]>(
    () =>
      products
        .filter((p) => p.active)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((p) => ({
          id: p.id,
          title: p.name,
          subtitle: `${p.category}${p.saleMode === "weighted" ? " · choose a pack size" : p.barcode ? " · " + p.barcode : ""}`,
          right: p.saleMode === "weighted" ? `from ${formatMoney(Math.min(...p.packSizes.map((x) => x.price)), false)}` : formatMoney(p.price, false),
          haystack: [p.name, p.category, p.barcode, p.sku, ...p.packSizes.map((x) => x.barcode)].filter(Boolean).join(" ").toLowerCase(),
          run: () => pickProduct(p),
        })),
    [products, pickProduct],
  );

  const actionItems = useMemo<PickItem[]>(
    () =>
      SHORTCUTS.filter((s) => ["qty", "search", "calc", "customer", "discount", "bottle", "void", "hold", "exact", "pay", "help", "lock"].includes(s.id)).map((s) => ({
        id: "act-" + s.id,
        title: s.label,
        subtitle: "Action",
        keys: s.keys,
        haystack: (s.label + " " + s.id).toLowerCase(),
        run: () => runAction(s.id),
      })),
    [runAction],
  );

  if (!hydrated || !session) {
    return <div className="grid h-dvh place-items-center text-muted">Loading till…</div>;
  }

  const close = () => usePos.getState().closeDialog();
  const attachCustomer = (c: { id: string; name: string } | null) => usePos.getState().attachCustomer(c);

  return (
    <div className="flex h-dvh flex-col">
      <Header />
      <main className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(380px,34%)] gap-4 p-4">
        <div className="flex min-h-0 flex-col gap-3">
          <ScanBar ref={scanRef} onScan={handleScan} onEmptyEnter={() => runAction("pay")} />
          <ProductGrid products={products} loading={productsLoading} category={category} onCategory={setCategory} onPick={pickProduct} />
        </div>
        <BillPanel />
      </main>
      <ShortcutBar onRun={runAction} />
      <Toaster />

      {dialog?.type === "weight" && (
        <WeightPicker
          product={dialog.product}
          onClose={close}
          onAdd={(pack, qty) => {
            const s = usePos.getState();
            s.addProduct(dialog.product, pack, qty);
            playCue("ok");
            if (pack.stock <= 0) s.notify(`Stock shows 0 for ${dialog.product.name} ${pack.label}. Check the shelf.`, "warn");
            close();
          }}
        />
      )}
      {dialog?.type === "pay" && <PaymentDialog exact={dialog.exact} onClose={close} />}
      {dialog?.type === "search" && (
        <PickerDialog title="Find product" placeholder="Name, barcode or code…" items={productItems} empty="No matching product" onClose={close} />
      )}
      {dialog?.type === "palette" && (
        <PickerDialog title="Command palette" placeholder="Type an action or product…" items={[...actionItems, ...productItems]} empty="Nothing matches" onClose={close} />
      )}
      {dialog?.type === "calc" && <CalculatorDialog onClose={close} />}
      {dialog?.type === "help" && <HelpDialog onClose={close} />}
      {dialog?.type === "held" && <HeldDialog onClose={close} />}
      {dialog?.type === "qty" && <QtyDialog onClose={close} />}
      {dialog?.type === "discount" && <DiscountDialog onClose={close} />}
      {dialog?.type === "customer" && <CustomerDialog onClose={close} />}
      {gateOpen && <CustomerGate onDone={finishGate} />}
      {dialog?.type === "void" && <VoidDialog lineId={dialog.lineId} approver={dialog.approver} products={products} onClose={close} />}
      {dialog?.type === "success" && <SuccessDialog sale={dialog.sale} change={dialog.change} onClose={close} />}

      {approval && <ApprovalDialog />}
      {locked && <LockScreen />}
    </div>
  );
}
