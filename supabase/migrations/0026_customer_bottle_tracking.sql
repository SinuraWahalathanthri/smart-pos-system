-- Bottles, per customer, visible to every role.
--
-- 0011 gave the counter a way to register a return, and the dashboard a list of who still owes a
-- bottle. What was missing is the round trip: what a customer was given, what came back, what was
-- charged instead, and what the outstanding bottles are worth. Without those numbers a cashier
-- cannot answer "how many of ours does this person have" and the owner cannot see the value sitting
-- in other people's kitchens.
--
-- The invariant is unchanged and is deliberately per CUSTOMER, not per product: a return records how
-- many bottles came back, never which bottle. complete_sale writes same-sale returns with no
-- product_id for exactly that reason, so a per-product check here would refuse a legitimate return.

-- The summary and the movement feed both scan one shop's ledger newest-first.
create index if not exists bottle_ledger_store_created_ix
  on public.bottle_ledger (store_id, created_at desc);

/**
 * Hand bottles back at the counter. No money changes hands: this only reduces what the customer owes.
 *
 * Redefined only to record WHO took the bottle back (created_by), so the owner can tell a return
 * registered by the cashier from one registered at the office. The guards are unchanged.
 */
create or replace function public.return_bottles(
  p_customer   uuid,
  p_product    uuid,
  p_qty        int,
  p_with_sale  boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
  v_out int;
  v_event public.bottle_event;
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive'; end if;

  if not exists (select 1 from public.customers where id = p_customer and store_id = v_store) then
    raise exception 'unknown customer';
  end if;
  -- Only a bottled product can carry a return, otherwise the ledger would credit a bottle against
  -- something that never had one and the per-product bottle count would drift.
  if not exists (select 1 from public.products
                  where id = p_product and store_id = v_store and is_returnable_bottle) then
    raise exception 'unknown product, or it does not come in a returnable bottle';
  end if;

  v_out := public.customer_bottles_outstanding(p_customer);
  if v_out < p_qty then
    raise exception 'this customer only has % bottle(s) to return', v_out;
  end if;

  v_event := case when p_with_sale then 'returned_with_purchase'::public.bottle_event
                  else 'returned_later'::public.bottle_event end;

  insert into public.bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents, created_by)
  values (v_store, p_product, p_customer, v_event, p_qty, 0, public.app_profile_id());

  return jsonb_build_object('returned', p_qty, 'outstanding', v_out - p_qty);
end $$;

/**
 * Take the deposit instead of the bottle: the customer keeps it and pays the fee.
 *
 * 0011 checked only the customer, so a caller could settle a loan against a product from another
 * shop - the row was stored under this shop with a foreign product_id, and the per-product bottle
 * count then credited a bottle to a tenant that never sold one. The product is now verified here too.
 */
create or replace function public.charge_bottle_fee(
  p_customer uuid,
  p_product  uuid,
  p_qty      int
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
  v_out int;
  v_fee bigint;
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'quantity must be positive'; end if;

  if not exists (select 1 from public.customers where id = p_customer and store_id = v_store) then
    raise exception 'unknown customer';
  end if;
  if not exists (select 1 from public.products
                  where id = p_product and store_id = v_store and is_returnable_bottle) then
    raise exception 'unknown product, or it does not come in a returnable bottle';
  end if;

  v_out := public.customer_bottles_outstanding(p_customer);
  if v_out < p_qty then
    raise exception 'this customer only has % bottle(s) outstanding', v_out;
  end if;

  select bottle_fee_cents into v_fee from public.stores where id = v_store;

  insert into public.bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents, created_by)
  values (v_store, p_product, p_customer, 'fee_charged', p_qty, coalesce(v_fee, 0) * p_qty,
          public.app_profile_id());

  return jsonb_build_object('charged_cents', coalesce(v_fee, 0) * p_qty, 'outstanding', v_out - p_qty);
end $$;

/**
 * The whole bottle story, one row per customer: given out, came back, deposit taken instead.
 *
 * `outstanding` is computed with the SAME rule as customer_bottles_outstanding() - sold, minus
 * returns, minus bottles already charged for. fee_waived is reported but NOT subtracted: a waived
 * fee forgives the money, not the bottle, so the bottle stays a loan.
 *
 * It is readable by every role on purpose. A cashier is the person the bottle is handed to, and
 * hiding the count from them is what makes a bottle disappear.
 */
create or replace function public.customer_bottle_summary(
  p_only_outstanding boolean default true,
  p_limit            int default 200
) returns table (
  customer_id   uuid,
  name          text,
  phone         text,
  sent_out      int,
  returned      int,
  charged       int,
  waived        int,
  outstanding   int,
  worth_cents   bigint,
  last_out_at   timestamptz,
  last_return_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
  v_fee bigint;
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select bottle_fee_cents into v_fee from public.stores where id = v_store;

  return query
  select t.customer_id, t.name, t.phone, t.sent_out, t.returned, t.charged, t.waived,
         t.outstanding, t.outstanding::bigint * coalesce(v_fee, 0) as worth_cents,
         t.last_out_at, t.last_return_at
    from (
      select c.id as customer_id,
             c.name,
             c.phone,
             coalesce(g.sent_out, 0)::int as sent_out,
             coalesce(g.returned, 0)::int as returned,
             coalesce(g.charged, 0)::int as charged,
             coalesce(g.waived, 0)::int as waived,
             greatest(0, coalesce(g.sent_out, 0) - coalesce(g.returned, 0) - coalesce(g.charged, 0))::int
               as outstanding,
             g.last_out_at,
             g.last_return_at
        from public.customers c
        join (
          select l.customer_id,
                 sum(case when l.event = 'sold' then l.qty else 0 end) as sent_out,
                 sum(case when l.event in ('returned_with_purchase', 'returned_later')
                          then l.qty else 0 end) as returned,
                 sum(case when l.event = 'fee_charged' then l.qty else 0 end) as charged,
                 sum(case when l.event = 'fee_waived' then l.qty else 0 end) as waived,
                 max(case when l.event = 'sold' then l.created_at end) as last_out_at,
                 max(case when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged')
                          then l.created_at end) as last_return_at
            from public.bottle_ledger l
           where l.store_id = v_store and l.customer_id is not null
           group by l.customer_id
        ) g on g.customer_id = c.id
       where c.store_id = v_store
    ) t
   where not coalesce(p_only_outstanding, true) or t.outstanding > 0
   order by t.outstanding desc, coalesce(t.last_return_at, t.last_out_at) desc nulls last, t.name
   limit greatest(coalesce(p_limit, 200), 1);
end $$;

/**
 * One customer's bottles, per product: what they took, what came back, what they still have.
 *
 * The counter needs this rather than the shop-wide total, because "2 bottles back" has to be
 * credited against a product. Only products this customer actually took are returned - listing the
 * whole bottled catalogue would invite a return against something they never bought.
 */
create or replace function public.customer_bottles_by_product(p_customer uuid)
returns table (
  product_id  uuid,
  name        text,
  sent_out    int,
  returned    int,
  charged     int,
  outstanding int
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.customers where id = p_customer and store_id = v_store) then
    raise exception 'unknown customer';
  end if;

  return query
  select p.id, p.name,
         sum(case when l.event = 'sold' then l.qty else 0 end)::int,
         sum(case when l.event in ('returned_with_purchase', 'returned_later') then l.qty else 0 end)::int,
         sum(case when l.event = 'fee_charged' then l.qty else 0 end)::int,
         greatest(0, sum(case when l.event = 'sold' then l.qty else 0 end)
                   - sum(case when l.event in ('returned_with_purchase', 'returned_later') then l.qty else 0 end)
                   - sum(case when l.event = 'fee_charged' then l.qty else 0 end))::int
    from public.bottle_ledger l
    join public.products p on p.id = l.product_id
   where l.store_id = v_store
     and l.customer_id = p_customer
     and l.product_id is not null
   group by p.id, p.name
  having sum(case when l.event = 'sold' then l.qty else 0 end) > 0
   order by 6 desc, p.name;
end $$;

/**
 * The ledger itself, newest first, with the customer and the product attached.
 *
 * This is what "customer attribution" means in practice: every bottle out and every bottle back is
 * a row naming the person it belongs to. Rows with no customer are the walk-in sales where the
 * cashier never attached one; they still move the shop total, so they are shown rather than hidden.
 */
create or replace function public.bottle_events(
  p_customer uuid default null,
  p_limit    int default 100
) returns table (
  id            uuid,
  customer_id   uuid,
  customer_name text,
  product_name  text,
  event         public.bottle_event,
  qty           int,
  amount_cents  bigint,
  created_at    timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  return query
  select l.id, l.customer_id, c.name, p.name, l.event, l.qty, l.amount_cents, l.created_at
    from public.bottle_ledger l
    left join public.customers c on c.id = l.customer_id
    left join public.products p on p.id = l.product_id
   where l.store_id = v_store
     and (p_customer is null or l.customer_id = p_customer)
   order by l.created_at desc
   limit greatest(coalesce(p_limit, 100), 1);
end $$;

revoke all on function
  public.return_bottles(uuid, uuid, int, boolean),
  public.charge_bottle_fee(uuid, uuid, int),
  public.customer_bottle_summary(boolean, int),
  public.customer_bottles_by_product(uuid),
  public.bottle_events(uuid, int)
  from public, anon, authenticated;

grant execute on function
  public.return_bottles(uuid, uuid, int, boolean),
  public.charge_bottle_fee(uuid, uuid, int),
  public.customer_bottle_summary(boolean, int),
  public.customer_bottles_by_product(uuid),
  public.bottle_events(uuid, int)
  to authenticated;
