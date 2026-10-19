-- Row Level Security and grants.
--
-- Model
--   * Every user sees only their own store.
--   * Owner: full control of the catalogue and settings; reads everything.
--   * Supervisor: reads sales, stock and notifications. Risky changes go through RPCs.
--   * Cashier / till device: reads the catalogue and today's bills. Writes NOTHING directly:
--     sales, stock and approvals are created only by the SECURITY DEFINER functions in 0003.
--   * pin_hash / badge_hash and product cost are not readable by any client role.

-- ── helpers (used inside policies) ──────────────────────────────────────────
create function public.app_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  select store_id from public.profiles where auth_user_id = auth.uid() and is_active limit 1
$$;

create function public.app_role() returns public.user_role
language sql stable security definer set search_path = public as $$
  select role from public.profiles where auth_user_id = auth.uid() and is_active limit 1
$$;

create function public.app_profile_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from public.profiles where auth_user_id = auth.uid() and is_active limit 1
$$;

-- ── start from nothing, then grant what is needed ───────────────────────────
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to authenticated;
grant execute on function public.app_store_id(), public.app_role(), public.app_profile_id() to authenticated;

-- Readable tables
grant select on
  public.stores, public.categories, public.products, public.pack_sizes, public.product_barcodes,
  public.stock_movements, public.product_batches, public.sales, public.sale_items, public.payments,
  public.bottle_ledger, public.notifications, public.audit_logs, public.settings, public.product_costs
  to authenticated;

-- Staff: client roles may read names and roles, never the credential hashes or lockout state.
grant select (id, auth_user_id, store_id, full_name, staff_code, role, is_active, created_at)
  on public.profiles to authenticated;

-- Catalogue edits are owner-only (enforced by policy); the grant lets those statements run.
grant insert, update, delete on
  public.stores, public.categories, public.products, public.pack_sizes, public.product_barcodes,
  public.settings, public.product_costs
  to authenticated;
grant update (is_read) on public.notifications to authenticated;

-- ── enable RLS everywhere ───────────────────────────────────────────────────
alter table public.stores            enable row level security;
alter table public.profiles          enable row level security;
alter table public.categories        enable row level security;
alter table public.products          enable row level security;
alter table public.product_costs     enable row level security;
alter table public.pack_sizes        enable row level security;
alter table public.product_barcodes  enable row level security;
alter table public.stock_movements   enable row level security;
alter table public.product_batches   enable row level security;
alter table public.sales             enable row level security;
alter table public.sale_items        enable row level security;
alter table public.payments          enable row level security;
alter table public.bottle_ledger     enable row level security;
alter table public.approvals         enable row level security;
alter table public.audit_logs        enable row level security;
alter table public.notifications     enable row level security;
alter table public.settings          enable row level security;

-- ── stores & people ─────────────────────────────────────────────────────────
create policy stores_read   on public.stores for select to authenticated using (id = public.app_store_id());
create policy stores_update on public.stores for update to authenticated
  using (id = public.app_store_id() and public.app_role() = 'owner')
  with check (id = public.app_store_id());

create policy profiles_read on public.profiles for select to authenticated
  using (store_id = public.app_store_id());

-- ── catalogue: everyone in the store reads, only the owner writes ───────────
create policy categories_read on public.categories for select to authenticated using (store_id = public.app_store_id());
create policy categories_write on public.categories for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy products_read on public.products for select to authenticated using (store_id = public.app_store_id());
create policy products_write on public.products for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy pack_sizes_read on public.pack_sizes for select to authenticated using (store_id = public.app_store_id());
create policy pack_sizes_write on public.pack_sizes for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy barcodes_read on public.product_barcodes for select to authenticated using (store_id = public.app_store_id());
create policy barcodes_write on public.product_barcodes for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

-- Cost and settings: owner only (read and write).
create policy product_costs_owner on public.product_costs for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

create policy settings_owner on public.settings for all to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner')
  with check (store_id = public.app_store_id() and public.app_role() = 'owner');

-- ── stock, batches, bottles: read only (writes happen in RPCs) ──────────────
create policy stock_movements_read on public.stock_movements for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy batches_read on public.product_batches for select to authenticated
  using (store_id = public.app_store_id());
create policy bottle_ledger_read on public.bottle_ledger for select to authenticated
  using (store_id = public.app_store_id());

-- ── sales: owner/supervisor read all; cashiers read the last day (bill history, reprint) ──
create policy sales_read on public.sales for select to authenticated
  using (
    store_id = public.app_store_id()
    and (public.app_role() in ('owner', 'supervisor') or created_at > now() - interval '1 day')
  );
create policy sale_items_read on public.sale_items for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id));   -- inherits the sales policy
create policy payments_read on public.payments for select to authenticated
  using (exists (select 1 from public.sales s where s.id = sale_id));

-- ── alerts and audit ────────────────────────────────────────────────────────
create policy notifications_read on public.notifications for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));
create policy notifications_mark_read on public.notifications for update to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id());

create policy audit_read on public.audit_logs for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() = 'owner');

-- approvals: no policy at all, so no client can read or write them.

-- ── nothing important is ever hard-deleted ──────────────────────────────────
create function public.block_hard_delete() returns trigger language plpgsql as $$
begin
  raise exception 'Hard delete of % is not allowed. Archive or void instead.', tg_table_name;
end $$;
create trigger sales_no_delete before delete on public.sales for each row execute function public.block_hard_delete();
create trigger products_no_delete before delete on public.products for each row execute function public.block_hard_delete();
