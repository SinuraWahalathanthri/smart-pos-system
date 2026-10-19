-- Customer credit, the balance shown on the bill, and the invoice snapshot kept with each sale.
--
-- The credit tables have existed since 0005 but nothing ever wrote to them, and complete_sale
-- explicitly refused a 'credit' payment. A tab is only safe if three things hold, so this migration
-- enforces all three rather than trusting the till:
--   * the customer has a credit_limit_cents above zero, and the new balance stays under it
--   * the shop is not blocked from trading on credit (is_blocked)
--   * there is a named customer - an anonymous tab can never be collected

-- -- 1. balance --------------------------------------------------------------------------------
-- Outstanding is invoiced minus settled; write-offs and adjustments are already baked into the
-- entries that carry them, so the sign of amount_cents is all that matters.
create or replace function public.customer_credit_balance(p_customer uuid)
returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum(e.amount_cents), 0)::bigint
    from public.customer_credit_entries e
   where e.customer_id = p_customer
     and e.store_id = public.app_store_id()
$$;

-- -- 2. the bill's customer card ----------------------------------------------------------------
-- Appended rather than replaced, because the till reads this on every scanned item: the keys the
-- earlier version returned must keep working.
create or replace function public.customer_card(p_phone text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with n as (select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as phone),
  hit as (
    select c.*
      from public.customers c, n
     where c.store_id = public.app_store_id()
       and c.phone is not null
       and (c.phone = n.phone or (length(n.phone) >= 4 and c.phone like '%' || n.phone))
     order by (c.phone = n.phone) desc, c.name
     limit 1
  )
  select case when not exists (select 1 from hit) then null else
    (select jsonb_build_object(
       'id', h.id,
       'name', h.name,
       'phone', h.phone,
       'email', h.email,
       'points', coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = h.id), 0),
       'spend_cents', coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = h.id), 0),
       'visits', (select count(*) from public.sales s where s.customer_id = h.id),
       'bottles_out', public.customer_bottles_outstanding(h.id),
       'credit_balance_cents', public.customer_credit_balance(h.id),
       'credit_limit_cents', h.credit_limit_cents,
       'credit_terms_days', h.credit_terms_days,
       'is_blocked', h.is_blocked
     ) from hit h)
  end
$$;

-- The same numbers for a customer already chosen, so the bill can refresh after a sale without
-- asking the cashier to retype the number.
create or replace function public.customer_snapshot(p_customer uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not exists (
    select 1 from public.customers c where c.id = p_customer and c.store_id = public.app_store_id()
  ) then null else
    (select jsonb_build_object(
       'id', c.id,
       'name', c.name,
       'phone', c.phone,
       'points', coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = c.id), 0),
       'spend_cents', coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = c.id), 0),
       'visits', (select count(*) from public.sales s where s.customer_id = c.id),
       'bottles_out', public.customer_bottles_outstanding(c.id),
       'credit_balance_cents', public.customer_credit_balance(c.id),
       'credit_limit_cents', c.credit_limit_cents,
       'is_blocked', c.is_blocked
     ) from public.customers c where c.id = p_customer)
  end
$$;

revoke all on function public.customer_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.customer_snapshot(uuid) to authenticated;

-- -- 3. credit as a payment method -------------------------------------------------------------
-- complete_sale is redefined in full: a credit line, the credit ledger entry it creates, and the
-- points must all land in one transaction or none of them do.
create or replace function public.complete_sale(p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_store public.stores;
  v_id uuid := (p_sale ->> 'id')::uuid;
  v_receipt bigint;
  v_line jsonb;
  v_pay jsonb;
  v_subtotal bigint := 0;
  v_expected bigint;
  v_paid bigint := 0;
  v_credit bigint := 0;
  v_discount bigint := coalesce((p_sale ->> 'discount_cents')::bigint, 0);
  v_total bigint := (p_sale ->> 'total_cents')::bigint;
  v_cashier uuid;
  v_customer uuid := nullif(p_sale ->> 'customer_id', '')::uuid;
  v_customer_row public.customers;
  v_balance bigint;
  v_points int := 0;
  v_bottle_qty int := 0;
  v_fee_qty int := 0;
  v_returned int := coalesce((p_sale ->> 'bottles_returned')::int, 0);
  v_qty numeric;
  v_is_bottle boolean;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_store from public.stores where id = v_profile.store_id;

  if v_id is null then raise exception 'sale id is required'; end if;

  select receipt_no into v_receipt from public.sales where id = v_id and store_id = v_profile.store_id;
  if found then
    return jsonb_build_object('sale_id', v_id, 'receipt_no', v_receipt, 'status', 'duplicate');
  end if;

  if v_customer is not null then
    select * into v_customer_row from public.customers
     where id = v_customer and store_id = v_profile.store_id;
    if not found then raise exception 'unknown customer'; end if;
  end if;

  -- recompute money from the lines; never trust the client's totals
  for v_line in select * from jsonb_array_elements(coalesce(p_sale -> 'lines', '[]'::jsonb)) loop
    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'line quantity must be positive'; end if;
    if abs(round(v_qty * (v_line ->> 'unit_price_cents')::numeric) - (v_line ->> 'line_total_cents')::numeric) > 1 then
      raise exception 'line total does not match quantity x price for %', v_line ->> 'name';
    end if;
    v_subtotal := v_subtotal + (v_line ->> 'line_total_cents')::bigint;
  end loop;

  if v_subtotal = 0 and jsonb_array_length(coalesce(p_sale -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'a sale needs at least one line';
  end if;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'invalid discount'; end if;
  v_expected := v_subtotal - v_discount;
  if v_total is distinct from v_expected then
    raise exception 'sale total % does not match its lines (expected %)', v_total, v_expected;
  end if;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale -> 'payments', '[]'::jsonb)) loop
    if (v_pay ->> 'method') = 'credit' then
      v_credit := v_credit + (v_pay ->> 'amount_cents')::bigint;
    end if;
    v_paid := v_paid + (v_pay ->> 'amount_cents')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'payments (%) do not add up to the total (%)', v_paid, v_total; end if;

  -- A tab needs a person to collect from, a limit to stay under, and a shop willing to lend.
  if v_credit > 0 then
    if v_customer is null then raise exception 'a credit sale needs a customer'; end if;
    if v_customer_row.is_blocked then raise exception 'this customer is blocked from credit' using errcode = '42501'; end if;
    if v_customer_row.credit_limit_cents <= 0 then
      raise exception 'this customer has no credit limit' using errcode = '42501';
    end if;
    v_balance := public.customer_credit_balance(v_customer);
    if v_balance + v_credit > v_customer_row.credit_limit_cents then
      raise exception 'credit limit exceeded: % outstanding, % limit, % more requested',
        v_balance, v_customer_row.credit_limit_cents, v_credit using errcode = '42501';
    end if;
  end if;

  v_cashier := nullif(p_sale ->> 'cashier_id', '')::uuid;
  if v_cashier is not null and not exists (
    select 1 from public.profiles where id = v_cashier and store_id = v_profile.store_id
  ) then
    raise exception 'unknown cashier';
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

  -- The tab itself. due_on follows the shop's agreed terms, so "who is overdue" is answerable.
  if v_credit > 0 then
    insert into public.customer_credit_entries
      (store_id, customer_id, entry_type, sale_id, amount_cents, due_on, created_by)
    values (v_profile.store_id, v_customer, 'invoice', v_id, v_credit,
            case when v_customer_row.credit_terms_days > 0
                 then current_date + v_customer_row.credit_terms_days else null end,
            v_profile.id);
  end if;

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
    'customer_name', v_customer_row.name,
    'credit_balance_cents', case when v_customer is null then 0 else public.customer_credit_balance(v_customer) end
  );
end $$;

-- -- 4. settling a tab --------------------------------------------------------------------------
-- Cash at the counter against an existing debt. Money in, so it is recorded, never edited.
create or replace function public.settle_credit(p_customer uuid, p_amount_cents bigint, p_method public.pay_method)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_store uuid := public.app_store_id();
  v_balance bigint;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found or v_profile.role not in ('owner', 'supervisor') then
    raise exception 'only the owner or a supervisor can settle a tab' using errcode = '42501';
  end if;
  if p_amount_cents <= 0 then raise exception 'settlement must be more than zero'; end if;
  if p_method = 'credit' then raise exception 'a settlement cannot be paid on credit'; end if;

  v_balance := public.customer_credit_balance(p_customer);
  if v_balance <= 0 then raise exception 'this customer does not owe anything'; end if;
  if p_amount_cents > v_balance then raise exception 'settlement exceeds the balance of %', v_balance; end if;

  -- Stored negative: invoice is money owed, settlement reduces it.
  insert into public.customer_credit_entries (store_id, customer_id, entry_type, amount_cents, method, created_by)
  values (v_store, p_customer, 'settlement', -p_amount_cents, p_method, v_profile.id);

  return jsonb_build_object('balance_cents', public.customer_credit_balance(p_customer));
end $$;

revoke all on function public.settle_credit(uuid, bigint, public.pay_method) from public, anon, authenticated;
grant execute on function public.settle_credit(uuid, bigint, public.pay_method) to authenticated;

-- -- 5. the invoice, frozen at the moment of sale ------------------------------------------------
-- An invoice is evidence. Re-deriving it later from live product names and prices would let a
-- reprint disagree with what the customer was handed, so the receipt is stored as text at sale time.
alter table public.sales add column if not exists invoice jsonb;

create or replace function public.sales_needing_invoice()
returns setof uuid
language sql stable security definer set search_path = public as $$
  select s.id from public.sales s
   where s.store_id = public.app_store_id()
     and s.invoice is null
   order by s.created_at
$$;

revoke all on function public.sales_needing_invoice() from public, anon, authenticated;
grant execute on function public.sales_needing_invoice() to authenticated;

create or replace function public.attach_invoice(p_sale uuid, p_invoice jsonb)
returns void
language sql security definer set search_path = public as $$
  update public.sales
     set invoice = p_invoice
   where id = p_sale
     and store_id = public.app_store_id()
     and invoice is null;
$$;

revoke all on function public.attach_invoice(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.attach_invoice(uuid, jsonb) to authenticated;

-- The dashboard needs the frozen invoice, not just the row.
create or replace function public.sale_invoice(p_sale uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select s.invoice
    from public.sales s
   where s.id = p_sale
     and s.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
$$;

revoke all on function public.sale_invoice(uuid) from public, anon, authenticated;
grant execute on function public.sale_invoice(uuid) to authenticated;

-- -- 6. opening a tab for a customer ------------------------------------------------------------
-- Without this every new customer has credit_limit_cents = 0 and can never use credit, which is a
-- dead end. Owner or supervisor only: lending money is not a cashier decision.
create or replace function public.set_credit_terms(
  p_customer uuid,
  p_limit_cents bigint,
  p_terms_days int default 0,
  p_blocked boolean default false
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found or v_profile.role not in ('owner', 'supervisor') then
    raise exception 'only the owner or a supervisor can set credit terms' using errcode = '42501';
  end if;
  if p_limit_cents < 0 then raise exception 'credit limit cannot be negative'; end if;
  if p_terms_days < 0 then raise exception 'credit terms cannot be negative'; end if;
  update public.customers
     set credit_limit_cents = p_limit_cents,
         credit_terms_days = p_terms_days,
         is_blocked = p_blocked
   where id = p_customer and store_id = public.app_store_id();
  if not found then raise exception 'customer not found'; end if;
  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after)
  values (v_profile.store_id, 'credit_terms_set', 'customers', p_customer, v_profile.id,
          jsonb_build_object('limit_cents', p_limit_cents, 'terms_days', p_terms_days, 'blocked', p_blocked));
  return jsonb_build_object(
    'credit_limit_cents', p_limit_cents,
    'credit_terms_days', p_terms_days,
    'is_blocked', p_blocked,
    'balance_cents', public.customer_credit_balance(p_customer)
  );
end $$;
revoke all on function public.set_credit_terms(uuid, bigint, int, boolean) from public, anon, authenticated;
grant execute on function public.set_credit_terms(uuid, bigint, int, boolean) to authenticated;
/** Everyone who owes money, oldest debt first. The owner's collections list. */
create or replace function public.credit_book()
returns table (
  customer_id uuid,
  name text,
  phone text,
  balance_cents bigint,
  limit_cents bigint,
  oldest_due_on date,
  is_blocked boolean
)
language sql stable security definer set search_path = public as $$
  select c.id, c.name, c.phone,
         coalesce((select sum(e.amount_cents) from public.customer_credit_entries e where e.customer_id = c.id), 0),
         c.credit_limit_cents,
         (select min(e.due_on) from public.customer_credit_entries e
           where e.customer_id = c.id and e.amount_cents > 0 and e.due_on is not null),
         c.is_blocked
    from public.customers c
   where c.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and coalesce((select sum(e.amount_cents) from public.customer_credit_entries e where e.customer_id = c.id), 0) <> 0
   order by (select min(e.due_on) from public.customer_credit_entries e
              where e.customer_id = c.id and e.amount_cents > 0 and e.due_on is not null) asc nulls last,
            c.name
$$;
revoke all on function public.credit_book() from public, anon, authenticated;
grant execute on function public.credit_book() to authenticated;
