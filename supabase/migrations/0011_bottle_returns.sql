-- Registering a bottle coming back.
--
-- The shop's rule, in its own numbers: milk sells for 250 and the 100 deposit is not taken on the
-- first purchase. The customer owes the bottle. If it comes back, nothing is owed. If a later visit
-- takes another bottle without returning the first, the 100 is charged then.
--
-- One deliberate exception to the append-only ledger below: settling a loan with a fee_charged row
-- is how an unpaid bottle stops being outstanding. Registering a return is never a guess about
-- which bottle, only how many.

/**
 * Hand bottles back at the counter. No money changes hands: this only reduces what the customer owes.
 * Safe to call for someone who owes nothing (it is refused, so the till cannot drift).
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

  insert into public.bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
  values (v_store, p_product, p_customer, v_event, p_qty, 0);

  return jsonb_build_object('returned', p_qty, 'outstanding', v_out - p_qty);
end $$;

/**
 * Take the deposit instead of the bottle: the customer keeps it and pays the 100.
 * The loan is settled by the payment, so it stops showing as outstanding.
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

  v_out := public.customer_bottles_outstanding(p_customer);
  if v_out < p_qty then
    raise exception 'this customer only has % bottle(s) outstanding', v_out;
  end if;

  select bottle_fee_cents into v_fee from public.stores where id = v_store;

  insert into public.bottle_ledger (store_id, product_id, customer_id, event, qty, amount_cents)
  values (v_store, p_product, p_customer, 'fee_charged', p_qty, v_fee * p_qty);

  return jsonb_build_object('charged_cents', v_fee * p_qty, 'outstanding', v_out - p_qty);
end $$;

/** Customers who still have bottles, for the dashboard. */
create or replace function public.customers_with_bottles(p_limit int default 50)
returns table (customer_id uuid, name text, phone text, bottles_out int, last_sale_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.app_store_id();
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  return query
  select c.id, c.name, c.phone,
         coalesce(sum(case
           when l.event = 'sold' then l.qty
           when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged') then -l.qty
           else 0 end), 0)::int as bottles_out,
         (select max(s.created_at) from public.sales s where s.customer_id = c.id) as last_sale_at
    from public.customers c
    left join public.bottle_ledger l on l.customer_id = c.id
   where c.store_id = v_store
   group by c.id, c.name, c.phone
  having coalesce(sum(case
           when l.event = 'sold' then l.qty
           when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged') then -l.qty
           else 0 end), 0) > 0
   order by 4 desc, 5 desc nulls last
   limit greatest(coalesce(p_limit, 50), 1);
end $$;

revoke all on function
  public.return_bottles(uuid, uuid, int, boolean),
  public.charge_bottle_fee(uuid, uuid, int),
  public.customers_with_bottles(int)
  from public, anon, authenticated;

grant execute on function
  public.return_bottles(uuid, uuid, int, boolean),
  public.charge_bottle_fee(uuid, uuid, int),
  public.customers_with_bottles(int)
  to authenticated;
