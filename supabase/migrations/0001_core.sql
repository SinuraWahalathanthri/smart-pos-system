-- POS core schema: store, staff, catalogue, stock ledger, sales, bottles, audit, notifications.
--
-- Conventions
--   * Money is stored as integer cents (LKR 1.00 = 100). The till works in cents too, so nothing is converted.
--   * Stock is an append-only ledger (stock_movements). products.stock_on_hand and
--     pack_sizes.packets_on_hand are maintained ONLY by a trigger; direct edits are rejected.
--   * Nothing important is hard-deleted: products are archived, sale lines are voided.
--   * store_id is on every table so a second branch is a data change, not a schema change.

create extension if not exists pgcrypto with schema extensions;

-- ── enums ───────────────────────────────────────────────────────────────────
create type public.user_role as enum ('owner', 'supervisor', 'cashier');
create type public.product_kind as enum ('raw_material', 'packaging', 'finished', 'trade', 'fee');
create type public.sale_mode as enum ('unit', 'weighted');
create type public.sale_status as enum ('completed', 'cancelled', 'refunded');
create type public.pay_method as enum ('cash', 'card', 'qr', 'credit');
create type public.line_kind as enum ('item', 'bottle_fee');
create type public.line_status as enum ('active', 'voided');
create type public.stock_move_type as enum
  ('sale', 'return', 'purchase', 'adjustment', 'void', 'opening', 'production_in', 'production_out', 'packing');
create type public.bottle_event as enum
  ('sold', 'returned_with_purchase', 'returned_later', 'fee_charged', 'fee_waived', 'fee_refunded', 'collected_by_dairy');
create type public.notification_type as enum
  ('low_stock', 'out_of_stock', 'expiry_soon', 'purchase_due', 'high_voids', 'system');

-- ── organisation & people ───────────────────────────────────────────────────
create table public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text,
  phone text,
  vat_no text,
  currency text not null default 'LKR',
  prices_include_tax boolean not null default true,
  max_cashier_discount_pct numeric(5,2) not null default 5,
  bottle_fee_cents bigint not null default 10000,
  created_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key default gen_random_uuid(),
  -- Owners/supervisors/till devices sign in with Supabase Auth. PIN-only cashiers have no auth user.
  auth_user_id uuid unique references auth.users (id) on delete set null,
  store_id uuid not null references public.stores (id),
  full_name text not null,
  staff_code text not null,
  role public.user_role not null,
  pin_hash text,    -- crypt(pin); never readable by the client (see 0002 column grants)
  badge_hash text,  -- crypt(badge barcode)
  is_active boolean not null default true,
  failed_attempts int not null default 0,
  locked_until timestamptz,
  created_at timestamptz not null default now(),
  unique (store_id, staff_code)
);

-- ── catalogue ───────────────────────────────────────────────────────────────
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  name text not null,
  sort_order int not null default 0,
  unique (store_id, name)
);

create table public.products (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  sku text,
  name text not null,
  category_id uuid references public.categories (id),
  kind public.product_kind not null default 'trade',
  sale_mode public.sale_mode not null default 'unit',
  price_cents bigint not null default 0 check (price_cents >= 0),   -- unit items; weighted items price per pack size
  price_per_kg_cents bigint,                                        -- optional, reporting / custom-weight mode
  tax_rate_pct numeric(5,2) not null default 0 check (tax_rate_pct >= 0),
  stock_on_hand numeric(12,3) not null default 0,                   -- trigger-maintained
  reorder_level numeric(12,3) not null default 0,
  has_expiry boolean not null default false,
  shelf_life_days int,
  is_returnable_bottle boolean not null default false,
  is_favourite boolean not null default false,
  color text,
  image_path text,
  is_active boolean not null default true,
  archived_at timestamptz,
  archived_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index products_store_active_idx on public.products (store_id, is_active);

-- Cost is kept apart so cashiers can never read it (owner-only RLS in 0002).
create table public.product_costs (
  product_id uuid primary key references public.products (id) on delete cascade,
  store_id uuid not null references public.stores (id),
  cost_cents bigint not null default 0 check (cost_cents >= 0)
);

-- Branded spice packets: each size is its own stock and its own price.
create table public.pack_sizes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id) on delete cascade,
  label text not null,
  weight_g int not null check (weight_g > 0),
  price_cents bigint not null check (price_cents >= 0),
  packets_on_hand numeric(12,3) not null default 0,                 -- trigger-maintained
  packaging_product_id uuid references public.products (id),        -- branded pouch used per packet
  sort_order int not null default 0,
  is_active boolean not null default true,
  unique (product_id, weight_g)
);

-- A product (or one of its pack sizes) can carry several barcodes; unique per store.
create table public.product_barcodes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id) on delete cascade,
  pack_size_id uuid references public.pack_sizes (id) on delete cascade,
  barcode text not null,
  is_primary boolean not null default true,
  unique (store_id, barcode)
);
create index product_barcodes_product_idx on public.product_barcodes (product_id);

-- ── stock ledger ────────────────────────────────────────────────────────────
create table public.stock_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  qty_change numeric(12,3) not null,
  type public.stock_move_type not null,
  ref_table text,
  ref_id uuid,
  unit_cost_cents bigint,
  reason text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);
create index stock_movements_product_idx on public.stock_movements (product_id, created_at);

-- Expiry tracking per batch (FEFO). Populated by receiving / packing in later phases.
create table public.product_batches (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  batch_no text,
  manufacture_date date,
  expiry_date date,
  qty_received numeric(12,3) not null,
  qty_remaining numeric(12,3) not null,
  unit_cost_cents bigint,
  received_at timestamptz not null default now()
);

-- ── sales ───────────────────────────────────────────────────────────────────
create sequence public.receipt_no_seq start 10001;

create table public.sales (
  id uuid primary key,                       -- generated on the till, so an offline sale syncs safely and only once
  store_id uuid not null references public.stores (id),
  receipt_no bigint not null default nextval('public.receipt_no_seq'),
  local_receipt_no bigint,                   -- the number the till showed while offline
  cashier_id uuid references public.profiles (id),
  recorded_by uuid references public.profiles (id),   -- the signed-in till / user that submitted it
  status public.sale_status not null default 'completed',
  subtotal_cents bigint not null,
  discount_cents bigint not null default 0,
  total_cents bigint not null,
  tax_included_cents bigint not null default 0,
  bottles_returned int not null default 0,
  bottle_fee_cents bigint not null default 0,
  created_at timestamptz not null,           -- when the sale happened on the till
  received_at timestamptz not null default now(),
  unique (store_id, receipt_no)
);
create index sales_store_created_idx on public.sales (store_id, created_at);

create table public.sale_items (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  product_id uuid references public.products (id),     -- null for the bottle-fee line
  pack_size_id uuid references public.pack_sizes (id),
  kind public.line_kind not null default 'item',
  name_snapshot text not null,
  label_snapshot text,
  qty numeric(12,3) not null check (qty > 0),
  unit_price_cents bigint not null,
  tax_rate_pct numeric(5,2) not null default 0,
  tax_cents bigint not null default 0,
  line_total_cents bigint not null,
  status public.line_status not null default 'active',
  void_reason text,
  voided_by_name text                                   -- supervisor named on the till (approval may have been offline)
);
create index sale_items_sale_idx on public.sale_items (sale_id);

create table public.payments (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales (id) on delete cascade,
  method public.pay_method not null,
  amount_cents bigint not null check (amount_cents >= 0),
  tendered_cents bigint,
  change_cents bigint,
  reference text
);

-- ── glass-bottle milk (LKR 100 non-return fee) ──────────────────────────────
create table public.bottle_ledger (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid references public.products (id),
  sale_id uuid references public.sales (id),
  event public.bottle_event not null,
  qty int not null,
  amount_cents bigint not null default 0,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- ── control: approvals, audit, notifications, settings ──────────────────────
-- A short-lived, single-use proof that a supervisor approved ONE action (badge + PIN).
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  approver_id uuid not null references public.profiles (id),
  requested_by uuid references public.profiles (id),
  action text not null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  action text not null,
  entity text,
  entity_id uuid,
  requested_by uuid references public.profiles (id),
  approved_by uuid references public.profiles (id),
  before jsonb,
  after jsonb,
  reason text,
  created_at timestamptz not null default now()
);
create index audit_logs_store_created_idx on public.audit_logs (store_id, created_at desc);

create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  type public.notification_type not null,
  product_id uuid references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  title text not null,
  body text,
  is_read boolean not null default false,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index notifications_open_idx on public.notifications (store_id, is_read, created_at desc);

create table public.settings (
  store_id uuid not null references public.stores (id),
  key text not null,
  value jsonb not null,
  primary key (store_id, key)
);

-- ── stock ledger -> on-hand quantities ──────────────────────────────────────
-- Direct edits to the on-hand columns are rejected; only apply_stock_movement() may change them.
create function public.guard_stock_columns() returns trigger
language plpgsql as $$
begin
  if coalesce(current_setting('app.stock_write', true), 'off') <> 'on' then
    if tg_table_name = 'products' then
      if tg_op = 'INSERT' then
        new.stock_on_hand := 0;
      elsif new.stock_on_hand is distinct from old.stock_on_hand then
        raise exception 'stock_on_hand is maintained by stock_movements and cannot be edited directly';
      end if;
    elsif tg_table_name = 'pack_sizes' then
      if tg_op = 'INSERT' then
        new.packets_on_hand := 0;
      elsif new.packets_on_hand is distinct from old.packets_on_hand then
        raise exception 'packets_on_hand is maintained by stock_movements and cannot be edited directly';
      end if;
    end if;
  end if;
  return new;
end $$;

create trigger products_guard_stock before insert or update on public.products
  for each row execute function public.guard_stock_columns();
create trigger pack_sizes_guard_stock before insert or update on public.pack_sizes
  for each row execute function public.guard_stock_columns();

create function public.touch_updated_at() returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- Applies a movement and raises (or clears) low-stock / out-of-stock notifications.
create function public.apply_stock_movement() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_stock numeric;
  v_level numeric;
  v_name text;
  v_pack_low constant numeric := 3;   -- packets; mirrors PACK_LOW_STOCK in the app
  v_type public.notification_type;
begin
  perform set_config('app.stock_write', 'on', true);

  if new.pack_size_id is not null then
    update public.pack_sizes set packets_on_hand = packets_on_hand + new.qty_change
      where id = new.pack_size_id
      returning packets_on_hand, (select p.name from public.products p where p.id = product_id) || ' ' || label
      into v_stock, v_name;
    v_level := v_pack_low;
  else
    update public.products set stock_on_hand = stock_on_hand + new.qty_change
      where id = new.product_id
      returning stock_on_hand, reorder_level, name
      into v_stock, v_level, v_name;
  end if;

  perform set_config('app.stock_write', 'off', true);

  if v_stock is null then
    return new;
  end if;

  if v_stock <= 0 or v_stock <= v_level then
    v_type := case when v_stock <= 0 then 'out_of_stock' else 'low_stock' end;
    -- one open alert per product/size until it is restocked
    update public.notifications set resolved_at = now()
      where store_id = new.store_id and product_id = new.product_id
        and pack_size_id is not distinct from new.pack_size_id
        and resolved_at is null and type in ('low_stock', 'out_of_stock') and type <> v_type;
    if not exists (
      select 1 from public.notifications
      where store_id = new.store_id and product_id = new.product_id
        and pack_size_id is not distinct from new.pack_size_id
        and resolved_at is null and type = v_type
    ) then
      insert into public.notifications (store_id, type, product_id, pack_size_id, title, body)
      values (
        new.store_id, v_type, new.product_id, new.pack_size_id,
        case when v_type = 'out_of_stock' then v_name || ' is out of stock' else v_name || ' is running low' end,
        'On hand: ' || v_stock::text
      );
    end if;
  else
    update public.notifications set resolved_at = now()
      where store_id = new.store_id and product_id = new.product_id
        and pack_size_id is not distinct from new.pack_size_id
        and resolved_at is null and type in ('low_stock', 'out_of_stock');
  end if;

  return new;
end $$;

create trigger stock_movements_apply after insert on public.stock_movements
  for each row execute function public.apply_stock_movement();

-- The ledger itself is append-only.
create function public.block_ledger_changes() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger stock_movements_immutable before update or delete on public.stock_movements
  for each row execute function public.block_ledger_changes();
create trigger bottle_ledger_immutable before update or delete on public.bottle_ledger
  for each row execute function public.block_ledger_changes();
create trigger audit_logs_immutable before update or delete on public.audit_logs
  for each row execute function public.block_ledger_changes();
