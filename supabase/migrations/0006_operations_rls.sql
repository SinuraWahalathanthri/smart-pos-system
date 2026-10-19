-- Row Level Security for the operations tables added in 0005.
--
-- Same model as 0002, so the two files can be read together:
--   * every row is visible only inside its own store (public.app_store_id())
--   * owner: full control of purchasing, customers, production and reporting
--   * supervisor: may trade (shifts, refunds, stock takes) but not change master data
--   * cashier / till: reads what the till needs, writes nothing directly - RPCs do the writing
--
-- These tables are new, so nothing in the app breaks if a role cannot write: the existing selling
-- path in 0001-0004 is untouched by this file.

-- start from nothing, then grant what is needed (mirrors 0002)
revoke all on
  public.devices, public.suppliers, public.purchase_orders, public.purchase_order_lines,
  public.goods_receipts, public.goods_receipt_lines, public.customers,
  public.customer_credit_entries, public.shifts, public.cash_movements, public.refunds,
  public.refund_lines, public.production_runs, public.production_inputs, public.production_outputs,
  public.stock_takes, public.stock_take_lines, public.batch_allocations, public.weight_labels,
  public.product_price_history, public.daily_sales_rollup, public.monthly_summaries,
  public.roles, public.permissions, public.role_permissions
  from anon, authenticated;

revoke all on all sequences in schema public from anon, authenticated;

-- Readable by everyone signed in: the till needs weights for the scale, and the back office reads
-- the rest. Sensitive financial tables are limited to owner/supervisor by policy below.
grant select on
  public.devices, public.suppliers, public.purchase_orders, public.purchase_order_lines,
  public.goods_receipts, public.goods_receipt_lines, public.customers,
  public.customer_credit_entries, public.shifts, public.cash_movements, public.refunds,
  public.refund_lines, public.production_runs, public.production_inputs, public.production_outputs,
  public.stock_takes, public.stock_take_lines, public.batch_allocations, public.weight_labels,
  public.product_price_history, public.daily_sales_rollup, public.monthly_summaries,
  public.roles, public.permissions, public.role_permissions
  to authenticated;

-- Writes the back office performs directly. Policies decide who may actually succeed.
grant insert, update, delete on
  public.devices, public.suppliers, public.purchase_orders, public.purchase_order_lines,
  public.goods_receipts, public.goods_receipt_lines, public.customers,
  public.customer_credit_entries, public.production_runs, public.production_inputs,
  public.production_outputs, public.product_price_history
  to authenticated;

-- Shifts and stock takes are operational records; supervisors open and close them.
grant insert, update on
  public.shifts, public.cash_movements, public.stock_takes, public.stock_take_lines, public.refunds,
  public.refund_lines
  to authenticated;

grant delete on public.stock_take_lines to authenticated;

-- Reporting tables and permission tables are written by owner-level tooling only.
grant insert, update, delete on
  public.daily_sales_rollup, public.monthly_summaries,
  public.roles, public.permissions, public.role_permissions
  to authenticated;

alter table public.devices                 enable row level security;
alter table public.suppliers               enable row level security;
alter table public.purchase_orders         enable row level security;
alter table public.purchase_order_lines    enable row level security;
alter table public.goods_receipts          enable row level security;
alter table public.goods_receipt_lines     enable row level security;
alter table public.customers               enable row level security;
alter table public.customer_credit_entries enable row level security;
alter table public.shifts                  enable row level security;
alter table public.cash_movements          enable row level security;
alter table public.refunds                 enable row level security;
alter table public.refund_lines            enable row level security;
alter table public.production_runs         enable row level security;
alter table public.production_inputs       enable row level security;
alter table public.production_outputs      enable row level security;
alter table public.stock_takes             enable row level security;
alter table public.stock_take_lines        enable row level security;
alter table public.batch_allocations       enable row level security;
alter table public.weight_labels           enable row level security;
alter table public.product_price_history   enable row level security;
alter table public.daily_sales_rollup      enable row level security;
alter table public.monthly_summaries       enable row level security;
alter table public.roles                   enable row level security;
alter table public.permissions             enable row level security;
alter table public.role_permissions        enable row level security;

-- -- devices ---------------------------------------------------------------------------------
create policy devices_read on public.devices for select to authenticated
  using (store_id = public.app_store_id());
create policy devices_write on public.devices for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

-- -- suppliers & purchasing (owner only) -----------------------------------------------------
create policy suppliers_read on public.suppliers for select to authenticated
  using (store_id = public.app_store_id());
create policy suppliers_write on public.suppliers for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy purchase_orders_read on public.purchase_orders for select to authenticated
  using (store_id = public.app_store_id());
create policy purchase_orders_write on public.purchase_orders for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

-- Lines have no store_id of their own, so they inherit it from the parent order.
create policy purchase_order_lines_read on public.purchase_order_lines for select to authenticated
  using (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_id and po.store_id = public.app_store_id()));
create policy purchase_order_lines_write on public.purchase_order_lines for all to authenticated
  using (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_id and po.store_id = public.app_store_id())
    and public.app_role() = 'owner')
  with check (exists (
    select 1 from public.purchase_orders po
     where po.id = purchase_order_id and po.store_id = public.app_store_id())
    and public.app_role() = 'owner');

create policy goods_receipts_read on public.goods_receipts for select to authenticated
  using (store_id = public.app_store_id());
create policy goods_receipts_write on public.goods_receipts for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy goods_receipt_lines_read on public.goods_receipt_lines for select to authenticated
  using (exists (
    select 1 from public.goods_receipts gr
     where gr.id = goods_receipt_id and gr.store_id = public.app_store_id()));
create policy goods_receipt_lines_write on public.goods_receipt_lines for all to authenticated
  using (exists (
    select 1 from public.goods_receipts gr
     where gr.id = goods_receipt_id and gr.store_id = public.app_store_id())
    and public.app_role() = 'owner')
  with check (exists (
    select 1 from public.goods_receipts gr
     where gr.id = goods_receipt_id and gr.store_id = public.app_store_id())
    and public.app_role() = 'owner');

-- -- customers & credit ----------------------------------------------------------------------
create policy customers_read on public.customers for select to authenticated
  using (store_id = public.app_store_id());
create policy customers_write on public.customers for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

create policy customer_credit_read on public.customer_credit_entries for select to authenticated
  using (store_id = public.app_store_id());
create policy customer_credit_write on public.customer_credit_entries for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- -- shifts & cash ---------------------------------------------------------------------------
create policy shifts_read on public.shifts for select to authenticated
  using (store_id = public.app_store_id());
-- A cashier opens and closes their own shift; only a supervisor may edit someone else's.
create policy shifts_insert on public.shifts for insert to authenticated
  with check (store_id = public.app_store_id());
create policy shifts_update on public.shifts for update to authenticated
  using (store_id = public.app_store_id())
  with check (store_id = public.app_store_id());

create policy cash_movements_read on public.cash_movements for select to authenticated
  using (store_id = public.app_store_id());
create policy cash_movements_insert on public.cash_movements for insert to authenticated
  with check (store_id = public.app_store_id());
create policy cash_movements_update on public.cash_movements for update to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- -- refunds (supervisor and up) ------------------------------------------------------------
create policy refunds_read on public.refunds for select to authenticated
  using (store_id = public.app_store_id());
create policy refunds_insert on public.refunds for insert to authenticated
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

create policy refund_lines_read on public.refund_lines for select to authenticated
  using (exists (
    select 1 from public.refunds r
     where r.id = refund_id and r.store_id = public.app_store_id()));
create policy refund_lines_insert on public.refund_lines for insert to authenticated
  with check (exists (
    select 1 from public.refunds r
     where r.id = refund_id and r.store_id = public.app_store_id())
    and public.app_role() in ('owner', 'supervisor'));

-- -- production (owner) ---------------------------------------------------------------------
create policy production_runs_read on public.production_runs for select to authenticated
  using (store_id = public.app_store_id());
create policy production_runs_write on public.production_runs for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy production_inputs_read on public.production_inputs for select to authenticated
  using (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id()));
create policy production_inputs_write on public.production_inputs for all to authenticated
  using (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id())
    and public.app_role() = 'owner')
  with check (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id())
    and public.app_role() = 'owner');

create policy production_outputs_read on public.production_outputs for select to authenticated
  using (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id()));
create policy production_outputs_write on public.production_outputs for all to authenticated
  using (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id())
    and public.app_role() = 'owner')
  with check (exists (
    select 1 from public.production_runs pr
     where pr.id = production_run_id and pr.store_id = public.app_store_id())
    and public.app_role() = 'owner');

-- -- stock takes (supervisor and up) --------------------------------------------------------
create policy stock_takes_read on public.stock_takes for select to authenticated
  using (store_id = public.app_store_id());
create policy stock_takes_insert on public.stock_takes for insert to authenticated
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy stock_takes_update on public.stock_takes for update to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

create policy stock_take_lines_read on public.stock_take_lines for select to authenticated
  using (exists (
    select 1 from public.stock_takes st
     where st.id = stock_take_id and st.store_id = public.app_store_id()));
create policy stock_take_lines_write on public.stock_take_lines for all to authenticated
  using (exists (
    select 1 from public.stock_takes st
     where st.id = stock_take_id and st.store_id = public.app_store_id())
    and public.app_role() in ('owner', 'supervisor'))
  with check (exists (
    select 1 from public.stock_takes st
     where st.id = stock_take_id and st.store_id = public.app_store_id())
    and public.app_role() in ('owner', 'supervisor'));

-- -- batch allocations ----------------------------------------------------------------------
-- Written by the sale RPC, which runs as definer; clients only read them.
create policy batch_allocations_read on public.batch_allocations for select to authenticated
  using (exists (
    select 1 from public.product_batches pb
     where pb.id = batch_id and pb.store_id = public.app_store_id()));

-- -- catalogue helpers ----------------------------------------------------------------------
-- Weight labels are reference data shared by every store, so every signed-in user reads them.
create policy weight_labels_read on public.weight_labels for select to authenticated
  using (true);
create policy weight_labels_write on public.weight_labels for all to authenticated
  using (public.app_role() = 'owner')
  with check (public.app_role() = 'owner');

create policy product_price_history_read on public.product_price_history for select to authenticated
  using (store_id = public.app_store_id());
create policy product_price_history_insert on public.product_price_history for insert to authenticated
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- -- reporting (owner) ---------------------------------------------------------------------
create policy daily_sales_rollup_read on public.daily_sales_rollup for select to authenticated
  using (store_id = public.app_store_id());
create policy daily_sales_rollup_write on public.daily_sales_rollup for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy monthly_summaries_read on public.monthly_summaries for select to authenticated
  using (store_id = public.app_store_id());
create policy monthly_summaries_write on public.monthly_summaries for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

-- -- permissions (owner) -------------------------------------------------------------------
-- roles/permissions are global reference data, but only an owner may change them.
create policy roles_read on public.roles for select to authenticated using (true);
create policy roles_write on public.roles for all to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

create policy permissions_read on public.permissions for select to authenticated using (true);
create policy permissions_write on public.permissions for all to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');

create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
create policy role_permissions_write on public.role_permissions for all to authenticated
  using (public.app_role() = 'owner') with check (public.app_role() = 'owner');
