-- Attach the customer to the sale, and award points, in the function that actually records sales.
--
-- 0016 redefined public.record_sale, which does not exist: the till calls public.complete_sale.
-- So the customer was still dropped and no points were ever awarded. This migration corrects that
-- and removes the duplicate left behind by the mistake.

drop function if exists public.record_sale(jsonb);

-- complete_sale is redefined in full rather than patched, because the sale, its lines, its stock
-- movements, its bottle ledger entries and its points must all land in one transaction.
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
  v_discount bigint := coalesce((p_sale ->> 'discount_cents')::bigint, 0);
  v_total bigint := (p_sale ->> 'total_cents')::bigint;
  v_cashier uuid;
  v_customer uuid := nullif(p_sale ->> 'customer_id', '')::uuid;
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

  -- A customer on the bill must be this shop's customer.
  if v_customer is not null and not exists (
    select 1 from public.customers where id = v_customer and store_id = v_profile.store_id
  ) then
    raise exception 'unknown customer';
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
      raise exception 'credit sales are not available yet';
    end if;
    v_paid := v_paid + (v_pay ->> 'amount_cents')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'payments (%) do not add up to the total (%)', v_paid, v_total; end if;

  -- the cashier must belong to this store
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

  -- voided lines are kept for the audit trail but never touch stock
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
    -- bottles with no empty and no fee: a supervisor waived the fee at the till
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
