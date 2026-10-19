-- POS operations: suppliers, purchasing, customers, shifts, refunds, production, stock takes.
--
-- Extends the live schema in 0001 rather than replacing it. Everything here FOLLOWS 0001's
-- conventions so the two halves read as one schema:
--   * surrogate key `id uuid primary key default gen_random_uuid()`
--   * money in integer cents, quantities in numeric(12,3)
--   * `store_id` on every table, timestamptz timestamps, `created_at default now()`
--   * nothing important is hard-deleted: rows are voided, cancelled or closed
--
-- Where the design document (pos_db.html) and 0001 disagree, 0001 wins. Concretely:
--
--   design table          -> what this migration does
--   products.product_id   -> products.id           (0001 uses `id`)
--   pack_sizes.pack_size_id -> pack_sizes.id
--   sales.sale_id         -> sales.id
--   sale_items.sale_item_id -> sale_items.id
--   product_batches.batch_id -> product_batches.id
--   staff                 -> SKIPPED: `profiles` is the staff table in 0001
--   staff_credentials     -> SKIPPED: pin_hash/badge_hash/lockout live on `profiles`
--   store_memberships     -> SKIPPED: `profiles.role` + `profiles.store_id` already model this
--   audit_log             -> SKIPPED: `audit_logs` exists (note: singular in the design doc)
--   store_settings        -> SKIPPED: those columns live on `stores`; key/value goes in `settings`
--   notification_types    -> SKIPPED: `notification_type` enum exists
--   stock_move_types      -> SKIPPED: `stock_move_type` enum exists
--   bottle_event_types    -> SKIPPED: `bottle_event` enum exists
--   payment_methods       -> SKIPPED: `pay_method` enum exists
--   tax_classes           -> SKIPPED: `tax_rate_pct` is per product/line and already in use
--   receipt_sequences     -> SKIPPED: `receipt_no_seq` numbers receipts globally
--
-- Adding lookup tables for concepts that are already enums would create two sources of truth and
-- force a rewrite of every function in 0003 for no shop-visible gain.

-- enums ------------------------------------------------------------------------------------
create type public.po_status as enum ('draft', 'sent', 'partial', 'received', 'cancelled');
create type public.production_status as enum ('draft', 'drying', 'grinding', 'packing', 'closed', 'cancelled');
create type public.production_stage as enum ('raw', 'packaging');
create type public.stock_take_status as enum ('open', 'counting', 'posted', 'cancelled');
create type public.stock_take_scope as enum ('full', 'category', 'cycle');
create type public.allocation_type as enum ('sale', 'writeoff', 'transfer');
create type public.cash_move_type as enum
  ('float_in', 'cash_in', 'cash_out', 'bank_drop', 'petty_cash', 'refund_payout');
create type public.credit_entry_type as enum ('invoice', 'settlement', 'adjustment', 'write_off');
create type public.refund_condition as enum ('resellable', 'damaged', 'expired');
create type public.summary_status as enum ('draft', 'posted', 'locked');

-- tills ------------------------------------------------------------------------------------
-- One row per till/PC that can take sales. Needed before shifts, because a shift belongs to a device.
create table public.devices (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  device_code text not null,
  name text not null,
  receipt_prefix text,
  last_seen_at timestamptz,
  last_sync_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, device_code)
);

-- suppliers & purchasing -------------------------------------------------------------------
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  code text,
  name text not null,
  contact_name text,
  phone text,
  email text,
  vat_no text,
  payment_terms_days int not null default 0 check (payment_terms_days >= 0),
  default_lead_time_days int not null default 0 check (default_lead_time_days >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (store_id, code)
);

create table public.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  supplier_id uuid not null references public.suppliers (id),
  po_no text not null,
  status public.po_status not null default 'draft',
  ordered_on timestamptz,
  expected_on date,
  is_recurring boolean not null default false,
  recurrence_rule text,
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  tax_cents bigint not null default 0 check (tax_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),
  created_by uuid references public.profiles (id),
  notes text,
  created_at timestamptz not null default now(),
  unique (store_id, po_no)
);

create table public.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders (id) on delete cascade,
  product_id uuid not null references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  qty_ordered numeric(12,3) not null default 0 check (qty_ordered >= 0),
  qty_received numeric(12,3) not null default 0 check (qty_received >= 0),
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  line_total_cents bigint not null default 0 check (line_total_cents >= 0)
);

create table public.goods_receipts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  purchase_order_id uuid references public.purchase_orders (id),
  supplier_id uuid not null references public.suppliers (id),
  supplier_invoice_no text,
  received_on date not null default current_date,
  subtotal_cents bigint not null default 0 check (subtotal_cents >= 0),
  input_vat_cents bigint not null default 0 check (input_vat_cents >= 0),
  total_cents bigint not null default 0 check (total_cents >= 0),
  received_by uuid references public.profiles (id),
  notes text,
  created_at timestamptz not null default now()
);

-- Posting a receipt line is what creates the product_batches row and the stock movement.
create table public.goods_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.goods_receipts (id) on delete cascade,
  po_line_id uuid references public.purchase_order_lines (id),
  product_id uuid not null references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  qty_received numeric(12,3) not null default 0 check (qty_received >= 0),
  qty_rejected numeric(12,3) not null default 0 check (qty_rejected >= 0),
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  batch_no text,
  expires_on date,
  line_total_cents bigint not null default 0 check (line_total_cents >= 0)
);

-- customers & credit ----------------------------------------------------------------------
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  code text,
  name text not null,
  phone text,
  email text,
  address text,
  credit_limit_cents bigint not null default 0 check (credit_limit_cents >= 0),
  credit_terms_days int not null default 0 check (credit_terms_days >= 0),
  is_blocked boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  unique (store_id, code)
);

-- Running tab: an `invoice` adds to what the customer owes, a `settlement` reduces it.
create table public.customer_credit_entries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  customer_id uuid not null references public.customers (id),
  entry_type public.credit_entry_type not null,
  sale_id uuid references public.sales (id),
  amount_cents bigint not null,
  due_on date,
  method public.pay_method,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- shifts & cash ---------------------------------------------------------------------------
create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  device_id uuid references public.devices (id),
  cashier_id uuid references public.profiles (id),
  shift_no int not null,
  opened_at timestamptz not null default now(),
  closed_at timestamptz,
  is_open boolean not null default true,
  opening_float_cents bigint not null default 0 check (opening_float_cents >= 0),
  cash_sales_cents bigint not null default 0,
  cash_refunds_cents bigint not null default 0,
  expected_cash_cents bigint not null default 0,
  counted_cash_cents bigint,
  variance_cents bigint,
  opened_by uuid references public.profiles (id),
  closed_by uuid references public.profiles (id),
  notes text,
  unique (store_id, shift_no)
);

create table public.cash_movements (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  shift_id uuid not null references public.shifts (id) on delete cascade,
  movement_type public.cash_move_type not null,
  amount_cents bigint not null,
  reason text,
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now()
);

-- refunds ---------------------------------------------------------------------------------
-- A refund is its own document, not an edit of the sale, so the original bill stays auditable.
create table public.refunds (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  sale_id uuid not null references public.sales (id),
  shift_id uuid references public.shifts (id),
  refund_no bigint not null,
  reason_code text,
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  tax_refunded_cents bigint not null default 0 check (tax_refunded_cents >= 0),
  restock boolean not null default true,
  approved_by uuid references public.profiles (id),
  created_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (store_id, refund_no)
);

create table public.refund_lines (
  id uuid primary key default gen_random_uuid(),
  refund_id uuid not null references public.refunds (id) on delete cascade,
  sale_item_id uuid not null references public.sale_items (id),
  qty numeric(12,3) not null check (qty > 0),
  unit_price_cents bigint not null default 0 check (unit_price_cents >= 0),
  amount_cents bigint not null default 0 check (amount_cents >= 0),
  -- `condition` is a reserved word in several engines, so the column is named item_condition.
  item_condition public.refund_condition not null default 'resellable'
);

-- production (drying, grinding, packing) --------------------------------------------------
create table public.production_runs (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  run_no text not null,
  product_id uuid not null references public.products (id),
  status public.production_status not null default 'draft',
  started_on date not null default current_date,
  closed_on date,
  raw_issued_kg numeric(12,3) not null default 0 check (raw_issued_kg >= 0),
  finished_kg numeric(12,3) not null default 0 check (finished_kg >= 0),
  yield_pct numeric(6,2) check (yield_pct >= 0),
  extra_cost_cents bigint not null default 0 check (extra_cost_cents >= 0),
  closed_by uuid references public.profiles (id),
  notes text,
  created_at timestamptz not null default now(),
  unique (store_id, run_no)
);

create table public.production_inputs (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null references public.production_runs (id) on delete cascade,
  product_id uuid not null references public.products (id),
  stage public.production_stage not null default 'raw',
  qty_kg numeric(12,3) not null default 0 check (qty_kg >= 0),
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  batch_id uuid references public.product_batches (id)
);

create table public.production_outputs (
  id uuid primary key default gen_random_uuid(),
  production_run_id uuid not null references public.production_runs (id) on delete cascade,
  pack_size_id uuid not null references public.pack_sizes (id),
  qty_packets numeric(12,3) not null default 0 check (qty_packets >= 0),
  wastage_g numeric(12,3) not null default 0 check (wastage_g >= 0),
  unit_cost_cents bigint not null default 0 check (unit_cost_cents >= 0),
  batch_id uuid references public.product_batches (id),
  expires_on date
);

-- stock takes -----------------------------------------------------------------------------
-- expected_qty is snapshotted at count time so the variance stays meaningful after later sales post.
create table public.stock_takes (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  reference text,
  status public.stock_take_status not null default 'open',
  scope public.stock_take_scope not null default 'full',
  started_by uuid references public.profiles (id),
  posted_by uuid references public.profiles (id),
  started_at timestamptz not null default now(),
  posted_at timestamptz,
  notes text
);

create table public.stock_take_lines (
  id uuid primary key default gen_random_uuid(),
  stock_take_id uuid not null references public.stock_takes (id) on delete cascade,
  product_id uuid not null references public.products (id),
  pack_size_id uuid references public.pack_sizes (id),
  batch_id uuid references public.product_batches (id),
  expected_qty numeric(12,3) not null default 0,
  counted_qty numeric(12,3),
  variance_qty numeric(12,3)
);

-- Which batch a sale line actually consumed. This is what makes expiry reporting (FIFO/FEFO) real.
create table public.batch_allocations (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.product_batches (id),
  sale_item_id uuid references public.sale_items (id) on delete cascade,
  qty numeric(12,3) not null check (qty > 0),
  allocated_at timestamptz not null default now(),
  allocation_type public.allocation_type not null default 'sale'
);

-- catalogue helpers -----------------------------------------------------------------------
-- The fixed weights (50 g, 100 g, ...) the weighing scale can print.
create table public.weight_labels (
  weight_g int primary key check (weight_g > 0),
  label text not null,
  sort_order int not null default 0
);

-- Every price change, so a disputed price can be traced to who changed it and why.
create table public.product_price_history (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  product_id uuid not null references public.products (id) on delete cascade,
  pack_size_id uuid references public.pack_sizes (id) on delete cascade,
  old_price_cents bigint not null default 0 check (old_price_cents >= 0),
  new_price_cents bigint not null default 0 check (new_price_cents >= 0),
  reason text,
  changed_by uuid references public.profiles (id),
  changed_at timestamptz not null default now()
);

-- reporting -------------------------------------------------------------------------------
-- Derived table, rebuilt by a job: it is deleted per day and re-inserted, so it carries a
-- surrogate key rather than a composite one. A composite key here would need pack_size_id NOT NULL,
-- and a unit product with no pack size has no such row.
create table public.daily_sales_rollup (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  business_date date not null,
  product_id uuid not null references public.products (id) on delete cascade,
  pack_size_id uuid references public.pack_sizes (id) on delete cascade,
  qty_sold numeric(14,3) not null default 0,
  gross_cents bigint not null default 0,
  discount_cents bigint not null default 0,
  net_cents bigint not null default 0,
  tax_cents bigint not null default 0,
  cogs_cents bigint not null default 0,
  qty_refunded numeric(14,3) not null default 0,
  qty_voided numeric(14,3) not null default 0,
  bill_count int not null default 0,
  rebuilt_at timestamptz not null default now()
);

create table public.monthly_summaries (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  period_year int not null check (period_year between 2000 and 2100),
  period_month int not null check (period_month between 1 and 12),
  status public.summary_status not null default 'draft',
  gross_sales_cents bigint not null default 0,
  discounts_cents bigint not null default 0,
  refunds_cents bigint not null default 0,
  net_sales_cents bigint not null default 0,
  output_vat_cents bigint not null default 0,
  input_vat_cents bigint not null default 0,
  vat_payable_cents bigint not null default 0,
  cogs_cents bigint not null default 0,
  gross_profit_cents bigint not null default 0,
  bottle_fees_cents bigint not null default 0,
  generated_at timestamptz not null default now(),
  unique (store_id, period_year, period_month)
);

-- fine-grained permissions ----------------------------------------------------------------
-- `profiles.role` stays the coarse gate used by 0002/0003. These tables add per-action limits
-- (for example "a cashier may discount up to LKR 200") without touching those functions.
create table public.roles (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  rank int not null default 0
);

create table public.permissions (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  description text
);

create table public.role_permissions (
  role_id uuid not null references public.roles (id) on delete cascade,
  permission_id uuid not null references public.permissions (id) on delete cascade,
  -- null = unlimited; otherwise the money ceiling for this action
  limit_cents bigint check (limit_cents >= 0),
  primary key (role_id, permission_id)
);

-- indexes ---------------------------------------------------------------------------------
-- Only the access paths the till and the reports actually use.
create index devices_store_ix on public.devices (store_id);
create index suppliers_store_ix on public.suppliers (store_id);
create index purchase_orders_store_status_ix on public.purchase_orders (store_id, status);
create index purchase_orders_expected_on_ix on public.purchase_orders (expected_on);
create index purchase_order_lines_po_ix on public.purchase_order_lines (purchase_order_id);
create index purchase_order_lines_product_ix on public.purchase_order_lines (product_id);
create index goods_receipts_store_received_ix on public.goods_receipts (store_id, received_on desc);
create index goods_receipts_po_ix on public.goods_receipts (purchase_order_id);
create index goods_receipt_lines_receipt_ix on public.goods_receipt_lines (goods_receipt_id);
create index goods_receipt_lines_product_ix on public.goods_receipt_lines (product_id);
create index customers_store_ix on public.customers (store_id);
create index customer_credit_entries_customer_ix on public.customer_credit_entries (customer_id, created_at desc);
create index customer_credit_entries_sale_ix on public.customer_credit_entries (sale_id);
create index refunds_store_created_ix on public.refunds (store_id, created_at desc);
create index refunds_sale_ix on public.refunds (sale_id);
create index refund_lines_refund_ix on public.refund_lines (refund_id);
create index refund_lines_sale_item_ix on public.refund_lines (sale_item_id);
create index shifts_store_opened_ix on public.shifts (store_id, opened_at desc);
create index shifts_open_ix on public.shifts (store_id, device_id) where is_open;
create index cash_movements_shift_ix on public.cash_movements (shift_id, created_at);
create index production_runs_store_started_ix on public.production_runs (store_id, started_on desc);
create index production_inputs_run_ix on public.production_inputs (production_run_id);
create index production_outputs_run_ix on public.production_outputs (production_run_id);
create index stock_takes_store_started_ix on public.stock_takes (store_id, started_at desc);
create index stock_take_lines_take_ix on public.stock_take_lines (stock_take_id);
create index stock_take_lines_product_ix on public.stock_take_lines (product_id);
create index batch_allocations_batch_ix on public.batch_allocations (batch_id);
create index batch_allocations_sale_item_ix on public.batch_allocations (sale_item_id);
create index product_price_history_product_ix on public.product_price_history (product_id, changed_at desc);
create index daily_sales_rollup_day_ix on public.daily_sales_rollup (store_id, business_date);
create index daily_sales_rollup_product_ix on public.daily_sales_rollup (product_id, business_date);
