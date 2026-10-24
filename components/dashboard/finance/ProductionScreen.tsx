"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { getSupabase } from "@/lib/supabase/client";
import { formatMoney, parseMoneyInput } from "@/lib/money";
import { Button, Dialog } from "@/components/ui/Dialog";
import { DashboardShell, NotAllowed } from "../DashboardShell";
import { permissions, useShop } from "../useShop";
import { Empty, ErrorNote, Loading, Money, Section, Table } from "./FinanceUI";

type Product = { id: string; name: string; sale_mode: "unit" | "weighted" };
type PackSize = { id: string; product_id: string; label: string; packets_on_hand: number; cost_cents: number | null };
type Run = {
  id: string;
  run_no: string;
  product_id: string;
  status: string;
  closed_on: string | null;
  material_cost_cents: number;
  extra_cost_cents: number;
  total_cost_cents: number;
  cost_per_unit_cents: number | null;
  notes: string | null;
};

type InputLine = { ref: string; qty: string };
type OutputLine = { packSizeId: string; qty: string };
type CostLine = { category: "labour" | "utilities" | "packaging" | "transport" | "other"; description: string; amount: string };

/**
 * Turning raw material into a finished product, and working out what one unit of it cost.
 *
 * This is the screen a spice shop needs and a generic POS does not have. Repacking bulk turmeric into
 * 250 g packets consumes raw material, uses labour and gas, produces packets, and yields a cost per
 * packet. Recording all of that in one place is what makes the margin on a packet something the owner
 * can check rather than guess.
 *
 * The run posts as one transaction: if any line is wrong, nothing moves. A half-posted batch would
 * leave the shelf and the cost disagreeing, which is worse than refusing the entry.
 */
export function ProductionScreen() {
  const { ctx } = useShop();
  const can = permissions(ctx?.role);
  return (
    <DashboardShell>
      {can.viewAnalytics ? <Production /> : <NotAllowed what="production" role={ctx?.role} />}
    </DashboardShell>
  );
}

function Production() {
  const [products, setProducts] = useState<Product[]>([]);
  const [packs, setPacks] = useState<PackSize[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const sb = getSupabase();
    const [prod, pack, run] = await Promise.all([
      sb.from("products").select("id, name, sale_mode").is("archived_at", null).order("name"),
      sb.from("pack_sizes").select("id, product_id, label, packets_on_hand, cost_cents").eq("is_active", true),
      sb
        .from("production_runs")
        .select(
          "id, run_no, product_id, status, closed_on, material_cost_cents, extra_cost_cents, total_cost_cents, cost_per_unit_cents, notes",
        )
        .order("created_at", { ascending: false })
        .limit(50),
    ]);
    setLoading(false);
    if (prod.error) return setError(prod.error.message);
    setError(null);
    setProducts((prod.data as Product[] | null) ?? []);
    setPacks((pack.data as PackSize[] | null) ?? []);
    setRuns((run.data as Run[] | null) ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const productName = useMemo(
    () => Object.fromEntries(products.map((p) => [p.id, p.name])) as Record<string, string>,
    [products],
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Production</h1>
          <p className="text-sm text-muted">Batches made in the shop, and what each unit cost.</p>
        </div>
        <Button variant="primary" onClick={() => setRecording(true)} disabled={products.length === 0}>
          <Plus size={16} /> Record a batch
        </Button>
      </div>

      {error && <ErrorNote message={error} onRetry={() => void load()} />}

      <Section title="Batches">
        {loading ? (
          <Loading what="batches" />
        ) : runs.length === 0 ? (
          <Empty>
            No batches recorded yet. Record one when you repack or blend a product: it takes the raw material
            out of stock, adds the finished units, and works out the cost of each one.
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <th className="py-2 pr-3 font-medium">Run</th>
                <th className="py-2 pr-3 font-medium">Product</th>
                <th className="py-2 pr-3 font-medium">Closed</th>
                <th className="py-2 pr-3 text-right font-medium">Material</th>
                <th className="py-2 pr-3 text-right font-medium">Other costs</th>
                <th className="py-2 pr-3 text-right font-medium">Total</th>
                <th className="py-2 text-right font-medium">Cost per unit</th>
              </tr>
            }
          >
            {runs.map((r) => (
              <tr key={r.id}>
                <td className="py-2 pr-3 font-mono text-xs">{r.run_no}</td>
                <td className="py-2 pr-3">{productName[r.product_id] ?? "—"}</td>
                <td className="py-2 pr-3 whitespace-nowrap text-muted">{r.closed_on ?? "—"}</td>
                <td className="py-2 pr-3 text-right">
                  <Money cents={r.material_cost_cents} muted />
                </td>
                <td className="py-2 pr-3 text-right">
                  <Money cents={r.extra_cost_cents} muted />
                </td>
                <td className="py-2 pr-3 text-right">
                  <Money cents={r.total_cost_cents} />
                </td>
                <td className="py-2 text-right font-medium">
                  <Money cents={r.cost_per_unit_cents} />
                </td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-3 text-xs text-muted">
          Material cost is what the issued stock was recorded at. Other costs are labour, gas, electricity,
          packaging and transport, itemised per batch so the cost per unit can be explained.
        </p>
      </Section>

      {recording && (
        <RunDialog
          products={products}
          packs={packs}
          onClose={() => setRecording(false)}
          onSaved={async () => {
            setRecording(false);
            await load();
          }}
        />
      )}
    </div>
  );
}

/**
 * One batch, entered as a single unit of work.
 *
 * The live total at the bottom is the point of the dialog: an owner entering four lines of cost can
 * see what a unit will cost before committing, rather than discovering it after the stock has moved.
 */
function RunDialog({
  products,
  packs,
  onClose,
  onSaved,
}: {
  products: Product[];
  packs: PackSize[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [madeProduct, setMadeProduct] = useState(products[0]?.id ?? "");
  const [runNo, setRunNo] = useState("");
  const [closedOn, setClosedOn] = useState(new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [inputs, setInputs] = useState<InputLine[]>([{ ref: "", qty: "" }]);
  const [outputs, setOutputs] = useState<OutputLine[]>([{ packSizeId: "", qty: "" }]);
  const [costs, setCosts] = useState<CostLine[]>([{ category: "labour", description: "", amount: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outputPacks = packs.filter((p) => p.product_id === madeProduct);
  const inputProducts = products.filter((p) => p.id !== madeProduct);

  const materialTotal = inputs.reduce((n, l) => {
    const qty = Number(l.qty) || 0;
    const pack = packs.find((p) => `pack:${p.id}` === l.ref);
    // An input chosen as a packet carries that packet's recorded cost. Chosen as a product, it has no
    // cost here; the server falls back to the product's own recorded cost.
    return n + Math.round(qty * (pack?.cost_cents ?? 0));
  }, 0);
  const extraTotal = costs.reduce((n, l) => n + (parseMoneyInput(l.amount) ?? 0), 0);
  const units = outputs.reduce((n, l) => n + (Number(l.qty) || 0), 0);
  const perUnit = units > 0 ? Math.round((materialTotal + extraTotal) / units) : null;

  function update<T>(list: T[], set: (v: T[]) => void, i: number, patch: Partial<T>) {
    set(list.map((item, idx) => (idx === i ? { ...item, ...patch } : item)));
  }

  async function save() {
    if (!madeProduct) return setError("Choose the product being made.");
    const parsedOutputs = outputs
      .map((o) => ({ pack_size_id: o.packSizeId || null, qty_units: Number(o.qty) || 0 }))
      .filter((o) => o.qty_units > 0);
    if (parsedOutputs.length === 0) return setError("Enter how many units were produced.");
    if (parsedOutputs.some((o) => !o.pack_size_id)) {
      return setError("Choose a packet size for each output, or add one under Products.");
    }

    const parsedInputs = inputs
      .map((l) => {
        const isPack = l.ref.startsWith("pack:");
        const id = l.ref.replace(/^pack:/, "");
        return {
          product_id: isPack ? (packs.find((pk) => pk.id === id)?.product_id ?? "") : id,
          pack_size_id: isPack ? id : null,
          qty: Number(l.qty) || 0,
        };
      })
      .filter((l) => l.product_id && l.qty > 0);
    if (parsedInputs.length === 0) return setError("Enter at least one raw material used.");

    const parsedCosts = costs
      .map((c) => ({ category: c.category, description: c.description, amount_cents: parseMoneyInput(c.amount) ?? 0 }))
      .filter((c) => c.amount_cents > 0);
    if (parsedCosts.some((c) => c.amount_cents <= 0)) return setError("Enter an amount for each cost line.");

    setBusy(true);
    const { error: err } = await getSupabase().rpc("save_production_run", {
      p_run: {
        product_id: madeProduct,
        run_no: runNo.trim() || null,
        status: "closed",
        started_on: closedOn,
        closed_on: closedOn,
        notes: notes.trim() || null,
        inputs: parsedInputs,
        outputs: parsedOutputs,
        cost_entries: parsedCosts,
      },
    });
    setBusy(false);
    if (err) return setError(err.message);
    onSaved();
  }

  return (
    <Dialog
      title="Record a production batch"
      onClose={onClose}
      onConfirm={() => void save()}
      width="max-w-3xl"
      footer={
        <>
          <span className="mr-auto text-sm text-muted">
            {perUnit !== null ? (
              <>
                Cost per unit: <strong className="text-text">{formatMoney(perUnit)}</strong> for {units} units
              </>
            ) : (
              "Enter outputs to see the cost per unit"
            )}
          </span>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => void save()} disabled={busy}>
            {busy ? "Posting..." : "Post batch"}
          </Button>
        </>
      }
    >
      <div className="max-h-[65vh] space-y-4 overflow-y-auto scroll-thin">
        {error && <ErrorNote message={error} />}

        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Product made</span>
            <select className="field" value={madeProduct} onChange={(e) => setMadeProduct(e.target.value)}>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Batch reference</span>
            <input className="field" value={runNo} onChange={(e) => setRunNo(e.target.value)} placeholder="Generated if blank" />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Date</span>
            <input className="field" type="date" value={closedOn} onChange={(e) => setClosedOn(e.target.value)} />
          </label>
        </div>

        <LineSection
          title="Raw material used"
          hint="Comes out of stock at the cost it is already recorded at."
          columns={["Material", "Qty", ""]}
          onAdd={() => setInputs((l) => [...l, { ref: "", qty: "" }])}
        >
          {inputs.map((line, i) => (
            <div
              key={i}
              className="grid gap-2 sm:grid-cols-[1fr_6rem_2.25rem] sm:items-center"
            >
              <LineField label="Material">
                <select
                  className="field"
                  value={line.ref}
                  onChange={(e) => update(inputs, setInputs, i, { ref: e.target.value })}
                  aria-label={`Material for line ${i + 1}`}
                >
                  <option value="">Choose material or packet...</option>
                  <optgroup label="Whole products">
                    {inputProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="Specific packets">
                    {packs
                      .filter((p) => p.product_id !== madeProduct)
                      .map((p) => (
                        <option key={p.id} value={`pack:${p.id}`}>
                          {products.find((x) => x.id === p.product_id)?.name} — {p.label}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </LineField>
              <LineField label="Qty">
                <input
                  className="field"
                  value={line.qty}
                  onChange={(e) => update(inputs, setInputs, i, { qty: e.target.value })}
                  placeholder="Qty"
                  inputMode="decimal"
                  aria-label={`Quantity for line ${i + 1}`}
                />
              </LineField>
              <button
                className="justify-self-start rounded p-2 text-muted hover:bg-surface-2 disabled:opacity-30 sm:justify-self-auto"
                onClick={() => setInputs((l) => l.filter((_, idx) => idx !== i))}
                aria-label={`Remove material line ${i + 1}`}
                disabled={inputs.length === 1}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <p className="text-xs text-muted">
            Quantity is in the material&apos;s own units: kilograms for a whole product, packets for a packet.
          </p>
        </LineSection>

        <LineSection
          title="What the batch produced"
          hint="Each output adds stock and receives the calculated cost per unit."
          columns={["Packet size", "Units", ""]}
          onAdd={() => setOutputs((l) => [...l, { packSizeId: "", qty: "" }])}
        >
          {outputs.map((line, i) => (
            <div
              key={i}
              className="grid gap-2 sm:grid-cols-[1fr_6rem_2.25rem] sm:items-center"
            >
              <LineField label="Packet size">
                <select
                  className="field"
                  value={line.packSizeId}
                  onChange={(e) => update(outputs, setOutputs, i, { packSizeId: e.target.value })}
                  aria-label={`Packet size for line ${i + 1}`}
                >
                  <option value="">Choose packet size...</option>
                  {outputPacks.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label} ({p.packets_on_hand} on hand)
                    </option>
                  ))}
                </select>
              </LineField>
              <LineField label="Units">
                <input
                  className="field"
                  value={line.qty}
                  onChange={(e) => update(outputs, setOutputs, i, { qty: e.target.value })}
                  placeholder="Units"
                  inputMode="decimal"
                  aria-label={`Units produced on line ${i + 1}`}
                />
              </LineField>
              <button
                className="justify-self-start rounded p-2 text-muted hover:bg-surface-2 disabled:opacity-30 sm:justify-self-auto"
                onClick={() => setOutputs((l) => l.filter((_, idx) => idx !== i))}
                aria-label={`Remove output line ${i + 1}`}
                disabled={outputs.length === 1}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          {outputPacks.length === 0 && (
            <p className="text-xs text-warning">
              This product has no packet sizes. Add one under Products before recording a batch.
            </p>
          )}
        </LineSection>

        <LineSection
          title="Labour and other costs"
          hint="Gas, electricity, wages, pouches, transport. Itemised so the cost per unit can be explained."
          columns={["Cost type", "What it was for", "Amount (LKR)", ""]}
          onAdd={() => setCosts((l) => [...l, { category: "other", description: "", amount: "" }])}
        >
          {costs.map((line, i) => (
            <div
              key={i}
              className="grid gap-2 sm:grid-cols-[9rem_1fr_7rem_2.25rem] sm:items-center"
            >
              <LineField label="Cost type">
                <select
                  className="field"
                  value={line.category}
                  onChange={(e) => update(costs, setCosts, i, { category: e.target.value as CostLine["category"] })}
                  aria-label={`Cost type for line ${i + 1}`}
                >
                  <option value="labour">Labour</option>
                  <option value="utilities">Gas / electricity</option>
                  <option value="packaging">Packaging</option>
                  <option value="transport">Transport</option>
                  <option value="other">Other</option>
                </select>
              </LineField>
              <LineField label="What it was for">
                <input
                  className="field"
                  value={line.description}
                  onChange={(e) => update(costs, setCosts, i, { description: e.target.value })}
                  placeholder="Two workers, half a day"
                  aria-label={`Description for cost line ${i + 1}`}
                />
              </LineField>
              <LineField label="Amount (LKR)">
                <input
                  className="field"
                  value={line.amount}
                  onChange={(e) => update(costs, setCosts, i, { amount: e.target.value })}
                  placeholder="0.00"
                  inputMode="decimal"
                  aria-label={`Amount for cost line ${i + 1}`}
                />
              </LineField>
              <button
                className="justify-self-start rounded p-2 text-muted hover:bg-surface-2 disabled:opacity-30 sm:justify-self-auto"
                onClick={() => setCosts((l) => l.filter((_, idx) => idx !== i))}
                aria-label={`Remove cost line ${i + 1}`}
                disabled={costs.length === 1}
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </LineSection>

        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-muted">Notes</span>
          <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} data-no-enter />
        </label>

        <div className="rounded-lg bg-surface-2 p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted">Material</span>
            <Money cents={materialTotal} />
          </div>
          <div className="flex justify-between">
            <span className="text-muted">Labour and other</span>
            <Money cents={extraTotal} />
          </div>
          <div className="mt-1 flex justify-between border-t border-border pt-1 font-semibold">
            <span>Total batch cost</span>
            <Money cents={materialTotal + extraTotal} />
          </div>
          <p className="mt-1 text-xs text-muted">
            Posting moves stock immediately. If any line is wrong the whole batch is refused, so the shelf and
            the cost never disagree.
          </p>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * A row field. The label is only shown on narrow screens: on wider ones the column headings above the
 * rows already say what each control is, so repeating it would be noise.
 */
function LineField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-0.5 block text-[10px] font-medium uppercase tracking-wide text-muted sm:hidden">
        {label}
      </span>
      {children}
    </label>
  );
}

function LineSection({
  title,
  hint,
  columns,
  onAdd,
  children,
}: {
  title: string;
  hint: string;
  /** Column headings for the row grid, so a bare `select` is never unexplained. */
  columns?: string[];
  onAdd: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <p className="text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
        <button className="text-xs underline text-muted hover:text-text" onClick={onAdd}>
          Add line
        </button>
      </div>
      {columns && (
        <div className="mb-1 hidden text-[10px] font-medium uppercase tracking-wide text-muted sm:block" aria-hidden>
          <div
            className={
              columns.length === 4
                ? "grid grid-cols-[9rem_1fr_7rem_2.25rem] gap-2"
                : "grid grid-cols-[1fr_6rem_2.25rem] gap-2"
            }
          >
            {columns.map((c, i) => (
              <span key={i}>{c}</span>
            ))}
          </div>
        </div>
      )}
      <div className="space-y-2">{children}</div>
      <p className="mt-1 text-xs text-muted">{hint}</p>
    </div>
  );
}
