-- Analytics for the dashboard.
--
-- Per-product, over a window: what sold, what it earned, what it cost, and what is left on the
-- shelf. Restricted to owner and supervisor - a cashier has no business reading margin.
--
-- Margins use product_costs, which 0002 keeps owner-only. A supervisor therefore sees revenue and
-- quantities but no cost or margin: the cost is returned as null rather than invented.

create or replace function public.assert_can_see_analytics()
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_profile.role not in ('owner', 'supervisor') then
    raise exception 'analytics are for the owner and supervisors' using errcode = '42501';
  end if;
  return v_profile;
end $$;

create or replace function public.product_analytics(p_days int default 30)
returns table (
  product_id        uuid,
  name              text,
  units_sold        numeric,
  revenue_cents     bigint,
  cost_cents        bigint,
  margin_cents      bigint,
  stock_on_hand     numeric,
  reorder_level     numeric,
  is_low_stock      boolean,
  bottles_out       int
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_can_see_analytics();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_show_cost boolean := v_me.role = 'owner';
begin
  return query
  with sold as (
    select si.product_id,
           sum(si.qty)::numeric as qty,
           sum(si.line_total_cents)::bigint as revenue
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
     where s.store_id = v_me.store_id
       and si.kind = 'item'
       and si.status = 'active'
       and s.created_at >= v_since
     group by si.product_id
  ),
  bottles as (
    select bl.product_id, sum(bl.qty)::int as qty
      from public.bottle_ledger bl
     where bl.store_id = v_me.store_id and bl.event = 'sold'
     group by bl.product_id
  ),
  loans_back as (
    select bl.product_id, sum(bl.qty)::int as qty
      from public.bottle_ledger bl
     where bl.store_id = v_me.store_id
       and bl.event in ('returned_with_purchase', 'returned_later', 'fee_charged')
     group by bl.product_id
  )
  select p.id,
         p.name,
         coalesce(sd.qty, 0),
         coalesce(sd.revenue, 0),
         case when v_show_cost
              then (coalesce(sd.qty, 0) * coalesce(pc.cost_cents, 0))::bigint
              else null end,
         case when v_show_cost
              then (coalesce(sd.revenue, 0) - coalesce(sd.qty, 0) * coalesce(pc.cost_cents, 0))::bigint
              else null end,
         p.stock_on_hand,
         p.reorder_level,
         p.stock_on_hand <= p.reorder_level,
         greatest(0, coalesce(bt.qty, 0) - coalesce(lb.qty, 0))
    from public.products p
    left join sold sd on sd.product_id = p.id
    left join product_costs pc on pc.product_id = p.id
    left join bottles bt on bt.product_id = p.id
    left join loans_back lb on lb.product_id = p.id
   where p.store_id = v_me.store_id
     and p.archived_at is null
   order by coalesce(sd.revenue, 0) desc, p.name;
end $$;

-- The headline numbers for the overview screen.
create or replace function public.store_overview(p_days int default 30)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_can_see_analytics();
  v_since timestamptz := now() - make_interval(days => greatest(coalesce(p_days, 30), 1));
  v_sales bigint; v_revenue bigint; v_customers bigint; v_low bigint; v_bottles bigint; v_staff bigint;
begin
  select count(*), coalesce(sum(s.total_cents), 0)
    into v_sales, v_revenue
    from public.sales s
   where s.store_id = v_me.store_id and s.created_at >= v_since;

  select count(distinct s.customer_id)
    into v_customers
    from public.sales s
   where s.store_id = v_me.store_id and s.created_at >= v_since and s.customer_id is not null;

  select count(*) into v_low
    from public.products p
   where p.store_id = v_me.store_id and p.archived_at is null
     and p.stock_on_hand <= p.reorder_level;

  -- Bottles the shop has handed out and not got back, across all customers.
  select coalesce(sum(case
           when event = 'sold' then qty
           when event in ('returned_with_purchase', 'returned_later', 'fee_charged') then -qty
           else 0 end), 0)
    into v_bottles
    from public.bottle_ledger
   where store_id = v_me.store_id;

  select count(*) into v_staff
    from public.profiles
   where store_id = v_me.store_id and is_active;

  return jsonb_build_object(
    'sales', v_sales,
    'revenue_cents', v_revenue,
    'customers', v_customers,
    'low_stock', v_low,
    'bottles_out', greatest(0, v_bottles),
    'staff', v_staff,
    'days', p_days);
end $$;

revoke all on function public.assert_can_see_analytics(), public.product_analytics(int), public.store_overview(int)
  from public, anon, authenticated;
grant execute on function public.product_analytics(int), public.store_overview(int) to authenticated;
