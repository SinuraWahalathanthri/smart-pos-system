-- Finance: operating expenses, inventory purchases as payables, production costing, and the cost
-- snapshots that make historical profit reporting truthful.
--
-- Conventions are 0001's, unchanged: surrogate uuid keys, integer cents, numeric(12,3) quantities,
-- store_id on every table, nothing important hard-deleted, RLS on everything.
--
-- What this migration deliberately does NOT do
--   * It does not create an income table. Revenue is already recorded once, in `sales`, and a second
--     copy would double-count it. Reports read sales directly.
--   * It does not treat an inventory purchase as an expense. A purchase is a stock movement plus a
--     payable (`goods_receipts`); it becomes cost of goods sold only when the goods are sold. See the
--     note on `expenses.kind` below.
--   * It does not hardcode a VAT rate. `stores.vat_rate_pct` defaults to 0 and the owner sets it.
--
-- Three accounting assumptions that could not be read off the existing code, stated once here so the
-- reports cannot silently disagree with each other:
--
--   1. COST IS SNAPSHOTTED AT SALE TIME. `sale_items.cost_cents` is filled by a trigger from the cost
--      that was current when the line was written. Reports therefore cost a sale at what the shop
--      actually paid, not at today's price. A null cost_cents means the shop never entered a cost for
--      that product: those lines are reported as `unknown_cost_lines`, never as zero-cost profit.
--   2. INVENTORY VALUE IS DERIVED, NOT STORED. on_hand x current cost, computed at read time. Storing
--      it would go stale the moment a sale posts.
--   3. EXPENSES ARE ACCRUAL BY DEFAULT. An expense counts in the period it belongs to (expense_on),
--      whether or not it has been paid. Cash paid is reported separately by summing the payments.
--      `expenses.kind` separates operating expenses from capital expenditure, so buying a freezer
--      does not make one month look unprofitable.

-- enums ------------------------------------------------------------------------------------
-- `bank` and `cheque` join the payment methods because an SME pays rent and suppliers that way, and
-- calling those "cash" in the ledger would make the cash reconciliation wrong.
alter type public.pay_method add value if not exists 'bank';
alter type public.pay_method add value if not exists 'cheque';

create type public.expense_kind as enum ('operating', 'capital');
create type public.expense_status as enum ('unpaid', 'partial', 'paid', 'void');
create type public.purchase_status as enum ('unpaid', 'partial', 'paid', 'void');
create type public.production_cost_category as enum
  ('labour', 'utilities', 'packaging', 'transport', 'other');
create type public.cost_method as enum ('moving_average', 'latest');

-- shop-level financial settings ------------------------------------------------------------
-- No default VAT rate: 0 means "not registered", and the owner sets the real figure. Thresholds,
-- filing deadlines and return formats are NOT stored here - the app prepares records, it does not
-- decide what is owed.
alter table public.stores add column if not exists is_vat_registered boolean not null default false;
alter table public.stores add column if not exists vat_rate_pct numeric(5,2) not null default 0
  check (vat_rate_pct >= 0 and vat_rate_pct < 100);
alter table public.stores add column if not exists tin text;
alter table public.stores add column if not exists cost_method public.cost_method not null default 'moving_average';
alter table public.stores add column if not exists fiscal_year_start_month int not null default 4
  check (fiscal_year_start_month between 1 and 12);

-- costs ------------------------------------------------------------------------------------
-- product_costs.cost_cents already existed but nothing ever wrote to it. It means: cost of ONE unit
-- of the product's own stock - per piece for a unit product, per kg for a weighted one (because that
-- is what products.stock_on_hand counts for each). A packet's cost lives in pack_sizes.cost_cents.
alter table public.pack_sizes add column if not exists cost_cents bigint check (cost_cents >= 0);

-- Every change to a cost, so a margin can be explained later.
create table public.product_cost_history (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id) on delete cascade,
  pack_size_id uuid references public.pack_sizes (id) on delete cascade,
  old_cost_cents bigint,
  new_cost_cents bigint not null check (new_cost_cents >= 0),
  source text not null default 'manual',   -- purchase | production | manual | opening
  ref_table text,
  ref_id uuid,
  reason text,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now()
);
create index product_cost_history_product_ix on public.product_cost_history (product_id, changed_at desc);

-- The cost a sale line was sold at, frozen. Null = never costed.
alter table public.sale_items add column if not exists cost_cents bigint;
alter table public.sale_items add column if not exists cogs_cents bigint not null default 0;

-- Refund lines carry their own cost so returning goods reverses COGS at the same rate.
alter table public.refund_lines add column if not exists cost_cents bigint;
alter table public.refunds add column if not exists method public.pay_method not null default 'cash';
alter table public.refunds add column if not exists voided_at timestamptz;
alter table public.refunds add column if not exists voided_by uuid references public.profiles (id);
alter table public.refunds add column if not exists void_reason text;

-- expenses ---------------------------------------------------------------------------------
-- The category is plain text on the expense, not a foreign key: a shopkeeper must be able to type
-- "Gas cylinder" at the till without first visiting a settings screen. `expense_categories` is the
-- suggestion list, and save_expense() adds the name to it on first use.
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  voucher_no bigint not null,
  -- operating = day-to-day running cost. capital = an asset (freezer, till, vehicle), kept apart so
  -- it never makes a month look loss-making.
  kind public.expense_kind not null default 'operating',
  category text not null,
  description text not null,
  amount_cents bigint not null check (amount_cents > 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  expense_on date not null default current_date,
  due_on date,
  status public.expense_status not null default 'paid',
  paid_cents bigint not null default 0 check (paid_cents >= 0),
  payment_method public.pay_method,
  payee text,
  reference text,
  notes text,
  is_recurring boolean not null default false,
  recurrence_rule text,           -- 'monthly' | 'weekly' | 'quarterly' | 'yearly'
  created_by uuid references public.profiles (id),
  voided_at timestamptz,
  voided_by uuid references public.profiles (id),
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (store_id, voucher_no),
  check (paid_cents <= amount_cents),
  check (expense_on >= date '2000-01-01')
);
create index expenses_store_date_ix on public.expenses (store_id, expense_on desc);
create index expenses_store_category_ix on public.expenses (store_id, category);
create index expenses_open_ix on public.expenses (store_id, due_on) where voided_at is null;

-- A bill can be settled in instalments; each one is a row here and money is never edited away.
create table public.expense_payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  expense_id uuid not null references public.expenses (id),
  amount_cents bigint not null check (amount_cents > 0),
  method public.pay_method not null,
  paid_on date not null default current_date,
  reference text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index expense_payments_expense_ix on public.expense_payments (expense_id, paid_on);
create index expense_payments_store_ix on public.expense_payments (store_id, paid_on desc);

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  name text not null,
  is_default boolean not null default false,
  is_operating boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now(),
  unique (store_id, name)
);

-- Receipts and invoices. The bytes live in the row because a shop counter may have no object store
-- configured, and an attachment that silently failed to upload is worse than no feature.
create table public.expense_attachments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  expense_id uuid not null references public.expenses (id) on delete cascade,
  name text not null,
  mime text not null default 'image/jpeg',
  size_bytes int not null check (size_bytes > 0 and size_bytes <= 3000000),
  content text not null,          -- base64
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  check (length(content) <= 4000000)
);
create index expense_attachments_expense_ix on public.expense_attachments (expense_id);

-- purchases as payables --------------------------------------------------------------------
-- goods_receipts already models "stock arrived from a supplier with an invoice". What it lacked was
-- the money side, so a purchase could never be outstanding.
alter table public.goods_receipts add column if not exists status public.purchase_status not null default 'unpaid';
alter table public.goods_receipts add column if not exists paid_cents bigint not null default 0
  check (paid_cents >= 0);
alter table public.goods_receipts add column if not exists due_on date;
alter table public.goods_receipts add column if not exists payment_method public.pay_method;
alter table public.goods_receipts add column if not exists voided_at timestamptz;
alter table public.goods_receipts add column if not exists void_reason text;
-- Freight, duty and handling paid to bring the goods in. Capitalised into unit cost, NOT expensed,
-- which is why it is a column here and not a row in `expenses`.
alter table public.goods_receipts add column if not exists additional_cost_cents bigint not null default 0
  check (additional_cost_cents >= 0);
alter table public.goods_receipts add column if not exists additional_cost_note text;

create table public.purchase_payments (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  purchase_id uuid not null references public.goods_receipts (id),
  amount_cents bigint not null check (amount_cents > 0),
  method public.pay_method not null,
  paid_on date not null default current_date,
  reference text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index purchase_payments_purchase_ix on public.purchase_payments (purchase_id, paid_on);
create index purchase_payments_store_ix on public.purchase_payments (store_id, paid_on desc);

-- production costing ----------------------------------------------------------------------
-- production_inputs.qty_kg only makes sense for spices sold by weight. A pouch, a label or a bottle
-- is counted, not weighed, so a generic quantity is added; `coalesce(qty, qty_kg)` is what the
-- functions consume, which keeps existing rows meaningful.
alter table public.production_inputs add column if not exists qty numeric(12,3) check (qty >= 0);
alter table public.production_inputs add column if not exists pack_size_id uuid
  references public.pack_sizes (id);

alter table public.production_outputs alter column pack_size_id drop not null;
alter table public.production_outputs add column if not exists product_id uuid
  references public.products (id);
alter table public.production_outputs add column if not exists qty_units numeric(12,3)
  not null default 0 check (qty_units >= 0);

alter table public.production_runs add column if not exists wastage_g numeric(12,3) not null default 0
  check (wastage_g >= 0);
alter table public.production_runs add column if not exists total_cost_cents bigint not null default 0
  check (total_cost_cents >= 0);
alter table public.production_runs add column if not exists cost_per_unit_cents bigint;
alter table public.production_runs add column if not exists material_cost_cents bigint not null default 0
  check (material_cost_cents >= 0);

-- Labour, electricity, gas, transport: itemised so the per-unit cost can be explained, not just quoted.
create table public.production_cost_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  production_run_id uuid not null references public.production_runs (id) on delete cascade,
  category public.production_cost_category not null,
  description text,
  amount_cents bigint not null check (amount_cents > 0),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index production_cost_entries_run_ix on public.production_cost_entries (production_run_id);

-- voucher numbering, per store, allocated server side so two tills cannot collide
create sequence public.expense_voucher_seq start 1;

-- triggers ---------------------------------------------------------------------------------
-- Freeze the cost on every sale line. Doing it in a trigger rather than inside complete_sale() means
-- it also covers offline syncs, refunds and any future writer, and complete_sale() stays untouched.
create or replace function public.set_sale_item_cost() returns trigger
language plpgsql security definer set search_path = public as $$
declare v_cost bigint;
begin
  if new.kind is distinct from 'item' or new.product_id is null then
    new.cost_cents := 0;
    new.cogs_cents := 0;
    return new;
  end if;

  if new.pack_size_id is not null then
    select ps.cost_cents into v_cost from public.pack_sizes ps where ps.id = new.pack_size_id;
  else
    select pc.cost_cents into v_cost from public.product_costs pc where pc.product_id = new.product_id;
  end if;

  -- v_cost stays null when the shop has never entered one: "unknown", not "free".
  new.cost_cents := v_cost;
  new.cogs_cents := case when v_cost is null then 0 else round(new.qty * v_cost)::bigint end;
  return new;
end $$;

create trigger sale_items_cost before insert on public.sale_items
  for each row execute function public.set_sale_item_cost();

-- Keep the running cost up to date when stock comes in with a known price.
-- A BEFORE INSERT trigger sees the pre-movement on_hand, which is exactly what the average needs.
create or replace function public.apply_inbound_cost() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_method public.cost_method;
  v_old_qty numeric;
  v_old_cost bigint;
  v_new_cost bigint;
  v_weight int;
begin
  if new.unit_cost_cents is null or new.qty_change <= 0 then
    return new;
  end if;
  if new.type not in ('purchase', 'production_in', 'opening', 'adjustment') then
    return new;
  end if;

  select st.cost_method into v_method from public.stores st where st.id = new.store_id;

  if new.pack_size_id is not null then
    select coalesce(ps.cost_cents, 0), ps.packets_on_hand, ps.weight_g
      into v_old_cost, v_old_qty, v_weight
      from public.pack_sizes ps where ps.id = new.pack_size_id;
    if v_old_qty is null then
      return new;
    end if;

    v_new_cost := case
      when v_method = 'latest' then new.unit_cost_cents
      when v_old_qty > 0 and v_old_cost > 0
        then round((v_old_qty * v_old_cost + new.qty_change * new.unit_cost_cents)
                   / (v_old_qty + new.qty_change))::bigint
      else new.unit_cost_cents
    end;

    update public.pack_sizes set cost_cents = v_new_cost where id = new.pack_size_id;
    -- A weighted product's stock_on_hand is kilograms, so its own cost is per kg. Deriving it here
    -- keeps inventory valuation and packet margins telling the same story.
    insert into public.product_costs (product_id, store_id, cost_cents)
    select new.product_id, new.store_id, round(v_new_cost * 1000.0 / v_weight)::bigint
    on conflict (product_id) do update set cost_cents = excluded.cost_cents;
  else
    select coalesce(pc.cost_cents, 0), p.stock_on_hand
      into v_old_cost, v_old_qty
      from public.products p
      left join public.product_costs pc on pc.product_id = p.id
     where p.id = new.product_id;
    if v_old_qty is null then
      return new;
    end if;

    v_new_cost := case
      when v_method = 'latest' then new.unit_cost_cents
      when v_old_qty > 0 and v_old_cost > 0
        then round((v_old_qty * v_old_cost + new.qty_change * new.unit_cost_cents)
                   / (v_old_qty + new.qty_change))::bigint
      else new.unit_cost_cents
    end;

    insert into public.product_costs (product_id, store_id, cost_cents)
    values (new.product_id, new.store_id, v_new_cost)
    on conflict (product_id) do update set cost_cents = excluded.cost_cents;
  end if;

  insert into public.product_cost_history
    (store_id, product_id, pack_size_id, old_cost_cents, new_cost_cents, source, ref_table, ref_id, changed_by)
  values (new.store_id, new.product_id, new.pack_size_id, nullif(v_old_cost, 0), v_new_cost,
          case new.type when 'production_in' then 'production' when 'purchase' then 'purchase'
               when 'opening' then 'opening' else 'manual' end,
          new.ref_table, new.ref_id, new.created_by);

  return new;
end $$;

create trigger stock_movements_inbound_cost before insert on public.stock_movements
  for each row execute function public.apply_inbound_cost();

create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();

-- Nothing financial is ever hard-deleted; a mistake is voided and stays visible.
-- Only the tables that are never legitimately removed get the guard: attachments and production
-- cost entries cascade from a parent, so blocking them outright would block a draft being discarded.
create trigger expenses_no_delete before delete on public.expenses
  for each row execute function public.block_hard_delete();
create trigger expense_payments_no_delete before delete on public.expense_payments
  for each row execute function public.block_hard_delete();
create trigger purchase_payments_no_delete before delete on public.purchase_payments
  for each row execute function public.block_hard_delete();

-- RLS --------------------------------------------------------------------------------------
-- Financial tables are read by the owner and supervisor, and written ONLY through the RPCs in 0022.
-- No INSERT/UPDATE/DELETE grant exists, so a browser cannot post a journal entry even by hand.
revoke all on
  public.expenses, public.expense_payments, public.expense_categories, public.expense_attachments,
  public.purchase_payments, public.production_cost_entries, public.product_cost_history
  from anon, authenticated;

grant select on
  public.expenses, public.expense_payments, public.expense_categories, public.expense_attachments,
  public.purchase_payments, public.production_cost_entries, public.product_cost_history
  to authenticated;

alter table public.expenses                  enable row level security;
alter table public.expense_payments          enable row level security;
alter table public.expense_categories        enable row level security;
alter table public.expense_attachments       enable row level security;
alter table public.purchase_payments         enable row level security;
alter table public.production_cost_entries   enable row level security;
alter table public.product_cost_history      enable row level security;

create policy expenses_read on public.expenses for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy expense_payments_read on public.expense_payments for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy expense_categories_read on public.expense_categories for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy expense_attachments_read on public.expense_attachments for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy purchase_payments_read on public.purchase_payments for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy production_cost_entries_read on public.production_cost_entries for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- Costs are the owner's business alone. 0002 keeps product_costs owner-only; this history follows.
create policy product_cost_history_read on public.product_cost_history for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner');
