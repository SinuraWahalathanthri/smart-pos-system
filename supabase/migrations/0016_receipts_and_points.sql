-- Receipt history, and the loyalty points earned on a sale.
--
-- Three things, all rooted in one gap: record_sale() never stored who a sale was for, even though
-- sales.customer_id has existed since 0007 and the till has always put the name on the bill.
-- A sale with no customer could not be shown against that customer, and could not earn points.

-- -- 1. points -------------------------------------------------------------------------------
-- A points ledger rather than a counter column, for the same reason stock is a ledger: the running
-- total must be explainable. A plain customers.points integer could be incremented twice by a
-- retried sync and nobody would ever be able to tell.
create table if not exists public.customer_points (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores (id),
  customer_id uuid not null references public.customers (id) on delete cascade,
  sale_id uuid references public.sales (id) on delete set null,
  points int not null,
  reason text not null,
  created_at timestamptz not null default now()
);
create index if not exists customer_points_customer_ix on public.customer_points (customer_id, created_at desc);
-- One earn per sale, so replaying a sync cannot mint points twice.
create unique index if not exists customer_points_sale_ux
  on public.customer_points (sale_id) where sale_id is not null and points > 0;

alter table public.customer_points enable row level security;
drop policy if exists customer_points_read on public.customer_points;
create policy customer_points_read on public.customer_points for select to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- Earned on money actually spent: LKR 100 = 1 point, so the divisor is 10,000 cents.
-- A receipt of LKR 250 earns 2 points; the remainder is deliberately not banked.
create or replace function public.earn_points(p_store uuid, p_customer uuid, p_sale uuid, p_total_cents bigint)
returns int
language plpgsql security definer set search_path = public as $$
declare v_points int;
begin
  if p_customer is null then return 0; end if;
  v_points := greatest(floor(coalesce(p_total_cents, 0) / 10000), 0)::int;
  if v_points <= 0 then return 0; end if;

  insert into public.customer_points (store_id, customer_id, sale_id, points, reason)
  values (p_store, p_customer, p_sale, v_points, 'earned')
  on conflict do nothing;
  return v_points;
end $$;

revoke all on function public.earn_points(uuid, uuid, uuid, bigint) from public, anon, authenticated;

-- -- 2. attach the customer to the sale ------------------------------------------------------
-- record_sale is redefined rather than wrapped so the points land inside the same transaction as
-- the sale: a sale that commits without its points would be a silent discrepancy.
create or replace function public.record_sale(p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_store public.stores;
  v_id uuid := (p_sale ->> 'id')::uuid;
  v_receipt bigint;
  v_existing public.sales;
  v_customer uuid := nullif(p_sale ->> 'customer_id', '')::uuid;
  v_cashier uuid;
  v_line jsonb;
  v_pay jsonb;
  v_subtotal bigint := coalesce((p_sale ->> 'subtotal_cents')::bigint, 0);
  v_discount bigint := coalesce((p_sale ->> 'discount_cents')::bigint, 0);
  v_total bigint := coalesce((p_sale ->> 'total_cents')::bigint, 0);
  v_paid bigint := 0;
  v_returned int := coalesce((p_sale ->> 'bottles_returned')::int, 0);
  v_bottle_qty int := 0;
  v_fee_qty int := 0;
  v_is_bottle boolean;
  v_points int := 0;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select * into v_store from public.stores where id = v_profile.store_id;

  -- Idempotent: the offline till may replay a sale it already uploaded.
  select * into v_existing from public.sales where id = v_id;
  if found then
    return jsonb_build_object('sale_id', v_id, 'receipt_no', v_existing.receipt_no, 'status', 'duplicate');
  end if;

  if v_id is null then raise exception 'sale id is required'; end if;
  if v_total <= 0 then raise exception 'sale total must be greater than zero'; end if;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'discount is out of range'; end if;

  for v_pay in select * from jsonb_array_elements(p_sale -> 'payments') loop
    if (v_pay ->> 'method') = 'credit' then
      raise exception 'credit sales are not available yet';
    end if;
    v_paid := v_paid + (v_pay ->> 'amount_cents')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'payments (%) do not add up to the total (%)', v_paid, v_total; end if;

  v_cashier := nullif(p_sale ->> 'cashier_id', '')::uuid;
  if v_cashier is not null and not exists (
    select 1 from public.profiles where id = v_cashier and store_id = v_profile.store_id
  ) then
    raise exception 'unknown cashier';
  end if;

  -- A customer on the bill must be this shop's customer.
  if v_customer is not null and not exists (
    select 1 from public.customers where id = v_customer and store_id = v_profile.store_id
  ) then
    raise exception 'unknown customer';
  end if;

  insert into public.sales (id, store_id, local_receipt_no, cashier_id, recorded_by, subtotal_cents, discount_cents,
                            total_cents, tax_included_cents, bottles_returned, bottle_fee_cents, created_at, customer_id)
  values (v_id, v_profile.store_id, nullif(p_sale ->> 'local_receipt_no', '')::bigint, coalesce(v_cashier, v_profile.id),
          v_profile.id, v_subtotal, v_discount, v_total, coalesce((p_sale ->> 'tax_included_cents')::bigint, 0),
          v_returned, coalesce((p_sale ->> 'bottle_fee_cents')::bigint, 0),
          coalesce((p_sale ->> 'created_at')::timestamptz, now()), v_customer)
  returning receipt_no into v_receipt;

  for v_line in select * from jsonb_array_elements(p_sale -> 'lines') loop
    insert into public.sale_items (sale_id, product_id, pack_size_id, kind, name_snapshot, label_snapshot, qty,
                                   unit_price_cents, tax_rate_pct, tax_cents, line_total_cents)
    values (v_id, nullif(v_line ->> 'product_id', '')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid,
            coalesce(v_line ->> 'kind', 'item')::public.line_kind, v_line ->> 'name', v_line ->> 'label',
            (v_line ->> 'qty')::numeric, (v_line ->> 'unit_price_cents')::bigint,
            coalesce((v_line ->> 'tax_rate_pct')::numeric, 0), coalesce((v_line ->> 'tax_cents')::bigint, 0),
            (v_line ->> 'line_total_cents')::bigint);

    if coalesce(v_line ->> 'kind', 'item') = 'item' then
      insert into public.stock_movements (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id, created_by)
      values (v_profile.store_id, (v_line ->> 'product_id')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid,
              -(v_line ->> 'qty')::numeric, 'sale', 'sales', v_id, v_profile.id);

      select is_returnable_bottle into v_is_bottle from public.products where id = (v_line ->> 'product_id')::uuid;
      if v_is_bottle then
        v_bottle_qty := v_bottle_qty + (v_line ->> 'qty')::numeric::int;
        insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, created_by, customer_id)
        values (v_profile.store_id, (v_line ->> 'product_id')::uuid, v_id, 'sold',
                (v_line ->> 'qty')::numeric::int, v_profile.id, v_customer);
      end if;
    else
      v_fee_qty := v_fee_qty + (v_line ->> 'qty')::numeric::int;
    end if;
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(p_sale -> 'voided', '[]'::jsonb)) loop
    insert into public.sale_items (sale_id, product_id, pack_size_id, kind, name_snapshot, label_snapshot, qty,
                                   unit_price_cents, line_total_cents, status, void_reason, voided_by_name)
    values (v_id, nullif(v_line ->> 'product_id', '')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid, 'item',
            v_line ->> 'name', v_line ->> 'label', (v_line ->> 'qty')::numeric,
            coalesce((v_line ->> 'unit_price_cents')::bigint, 0),
            round((v_line ->> 'qty')::numeric * coalesce((v_line ->> 'unit_price_cents')::numeric, 0))::bigint,
            'voided', v_line ->> 'reason', v_line ->> 'by');
    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, reason, after)
    values (v_profile.store_id, 'line_voided', 'sales', v_id, v_profile.id, v_line ->> 'reason', v_line);
  end loop;

  for v_pay in select * from jsonb_array_elements(p_sale -> 'payments') loop
    insert into public.payments (sale_id, method, amount_cents, tendered_cents, change_cents, reference)
    values (v_id, (v_pay ->> 'method')::public.pay_method, (v_pay ->> 'amount_cents')::bigint,
            nullif(v_pay ->> 'tendered_cents', '')::bigint, nullif(v_pay ->> 'change_cents', '')::bigint,
            v_pay ->> 'reference');
  end loop;

  if v_returned > 0 then
    insert into public.bottle_ledger (store_id, sale_id, event, qty, created_by, customer_id)
    values (v_profile.store_id, v_id, 'returned_with_purchase', v_returned, v_profile.id, v_customer);
  end if;
  if v_fee_qty > 0 then
    insert into public.bottle_ledger (store_id, sale_id, event, qty, amount_cents, created_by, customer_id)
    values (v_profile.store_id, v_id, 'fee_charged', v_fee_qty, v_fee_qty * v_store.bottle_fee_cents, v_profile.id, v_customer);
  end if;
  if v_bottle_qty - v_returned - v_fee_qty > 0 then
    insert into public.bottle_ledger (store_id, sale_id, event, qty, created_by, customer_id)
    values (v_profile.store_id, v_id, 'fee_waived', v_bottle_qty - v_returned - v_fee_qty, v_profile.id, v_customer);
    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, reason)
    values (v_profile.store_id, 'bottle_fee_waived', 'sales', v_id, v_profile.id,
            (v_bottle_qty - v_returned - v_fee_qty)::text || ' bottle fee(s) waived');
  end if;

  v_points := public.earn_points(v_profile.store_id, v_customer, v_id, v_total);

  return jsonb_build_object(
    'sale_id', v_id,
    'receipt_no', v_receipt,
    'status', 'created',
    'points_earned', v_points,
    'customer_name', (select name from public.customers where id = v_customer)
  );
end $$;

-- -- 3. receipt history -----------------------------------------------------------------------
-- One row per receipt, for the owner and supervisor dashboards. Set-returning and reading through
-- SECURITY DEFINER so the dashboard does not have to join five tables across RLS policies.
create or replace function public.sale_history(
  p_from  timestamptz default null,
  p_to    timestamptz default null,
  p_query text default null,
  p_limit int default 100,
  p_offset int default 0
) returns table (
  id uuid,
  receipt_no bigint,
  created_at timestamptz,
  cashier_name text,
  customer_id uuid,
  customer_name text,
  item_count int,
  subtotal_cents bigint,
  discount_cents bigint,
  total_cents bigint,
  points_earned int,
  status public.sale_status
)
language sql stable security definer set search_path = public as $$
  select s.id,
         s.receipt_no,
         s.created_at,
         pr.full_name,
         s.customer_id,
         c.name,
         coalesce((select sum(si.qty)::int from public.sale_items si
                    where si.sale_id = s.id and si.status = 'active'), 0),
         s.subtotal_cents,
         s.discount_cents,
         s.total_cents,
         coalesce((select sum(cp.points)::int from public.customer_points cp where cp.sale_id = s.id), 0),
         s.status
    from public.sales s
    left join public.profiles pr on pr.id = coalesce(s.cashier_id, s.recorded_by)
    left join public.customers c on c.id = s.customer_id
   where s.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and (p_from is null or s.created_at >= p_from)
     and (p_to is null or s.created_at < p_to)
     and (
       p_query is null or trim(p_query) = ''
       or c.name ilike '%' || trim(p_query) || '%'
       or (trim(p_query) ~ '^[0-9]+$' and s.receipt_no = trim(p_query)::bigint)
     )
   order by s.created_at desc
   limit greatest(coalesce(p_limit, 100), 1)
   offset greatest(coalesce(p_offset, 0), 0)
$$;

revoke all on function public.sale_history(timestamptz, timestamptz, text, int, int) from public, anon, authenticated;
grant execute on function public.sale_history(timestamptz, timestamptz, text, int, int) to authenticated;

/** The lines of one receipt, for the drill-down. */
create or replace function public.sale_detail(p_sale uuid)
returns table (
  name text,
  label text,
  qty numeric,
  unit_price_cents bigint,
  line_total_cents bigint,
  kind public.line_kind,
  status public.line_status,
  void_reason text
)
language sql stable security definer set search_path = public as $$
  select si.name_snapshot, si.label_snapshot, si.qty, si.unit_price_cents, si.line_total_cents,
         si.kind, si.status, si.void_reason
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
   where si.sale_id = p_sale
     and s.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
   order by si.id
$$;

revoke all on function public.sale_detail(uuid) from public, anon, authenticated;
grant execute on function public.sale_detail(uuid) to authenticated;

/** A customer's points balance and the receipts behind it. */
create or replace function public.customer_points_summary(p_customer uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'customer_id', c.id,
    'name', c.name,
    'balance', coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = c.id), 0),
    'spend_cents', coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = c.id), 0),
    'visits', (select count(*) from public.sales s where s.customer_id = c.id)
  )
    from public.customers c
   where c.id = p_customer
     and c.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
$$;

revoke all on function public.customer_points_summary(uuid) from public, anon, authenticated;
grant execute on function public.customer_points_summary(uuid) to authenticated;

/** Every customer with their points balance, for the dashboard. */
create or replace function public.customer_directory()
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  points bigint,
  spend_cents bigint,
  visits bigint
)
language sql stable security definer set search_path = public as $$
  select c.id,
         c.name,
         c.phone,
         c.email,
         coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = c.id), 0),
         coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = c.id), 0),
         (select count(*) from public.sales s where s.customer_id = c.id)
    from public.customers c
   where c.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
   order by c.name
$$;
revoke all on function public.customer_directory() from public, anon, authenticated;
grant execute on function public.customer_directory() to authenticated;
