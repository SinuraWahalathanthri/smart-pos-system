-- Server-side functions (SECURITY DEFINER). These are the ONLY way to create sales, move stock,
-- approve risky actions or archive a product, so the rules cannot be bypassed from the browser.

-- â”€â”€ supervisor approval: badge scan + PIN, always together â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Returns a jsonb result instead of raising on a bad credential, because a raised exception would
-- roll back the failed-attempt counter and defeat the lockout.
create function public.verify_supervisor(p_badge text, p_pin text, p_action text)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_caller public.profiles;
  v_target public.profiles;
  v_fails int;
  v_token uuid;
  c_max_tries constant int := 3;
begin
  select * into v_caller from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if coalesce(p_pin, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'pin_required');
  end if;

  if v_caller.role = 'owner' and coalesce(p_badge, '') = '' then
    v_target := v_caller;            -- the signed-in owner approves with their PIN only
  else
    select * into v_target from public.profiles
      where store_id = v_caller.store_id and is_active and role in ('supervisor', 'owner')
        and badge_hash is not null and badge_hash = crypt(p_badge, badge_hash)
      limit 1;
    if not found then
      insert into public.audit_logs (store_id, action, requested_by, reason)
        values (v_caller.store_id, 'approval_invalid_badge', v_caller.id, p_action);
      return jsonb_build_object('ok', false, 'reason', 'invalid_badge');
    end if;
  end if;

  if v_target.locked_until is not null and v_target.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'seconds', ceil(extract(epoch from (v_target.locked_until - now())))::int);
  end if;

  -- an expired lock starts a fresh count
  v_fails := case when v_target.locked_until is not null then 0 else v_target.failed_attempts end;

  if v_target.pin_hash is null or v_target.pin_hash <> crypt(p_pin, v_target.pin_hash) then
    v_fails := v_fails + 1;
    update public.profiles
      set failed_attempts = case when v_fails >= c_max_tries then 0 else v_fails end,
          locked_until = case when v_fails >= c_max_tries then now() + interval '5 minutes' else null end
      where id = v_target.id;
    insert into public.audit_logs (store_id, action, requested_by, approved_by, reason)
      values (v_caller.store_id, 'approval_wrong_pin', v_caller.id, v_target.id, p_action);
    return jsonb_build_object('ok', false,
      'reason', case when v_fails >= c_max_tries then 'locked' else 'wrong_pin' end,
      'tries_left', greatest(0, c_max_tries - v_fails));
  end if;

  update public.profiles set failed_attempts = 0, locked_until = null where id = v_target.id;

  insert into public.approvals (store_id, approver_id, requested_by, action, expires_at)
    values (v_caller.store_id, v_target.id, v_caller.id, p_action, now() + interval '60 seconds')
    returning id into v_token;

  insert into public.audit_logs (store_id, action, requested_by, approved_by, reason)
    values (v_caller.store_id, 'approval_granted', v_caller.id, v_target.id, p_action);

  return jsonb_build_object('ok', true, 'token', v_token,
    'approver_id', v_target.id, 'approver_name', v_target.full_name);
end $$;

-- Spends a token for one action. Raises if it is missing, expired, used, or for another action.
create function public.consume_approval(p_token uuid, p_action text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_approver uuid;
begin
  update public.approvals
    set used_at = now()
    where id = p_token and used_at is null and expires_at > now()
      and action = p_action and store_id = public.app_store_id()
    returning approver_id into v_approver;
  if v_approver is null then
    raise exception 'invalid_approval' using errcode = 'P0001';
  end if;
  return v_approver;
end $$;

-- â”€â”€ complete_sale: one transaction for sale + lines + payments + stock + bottles â”€â”€
-- Idempotent on the sale id, so a till that retries a sync never double-counts.
-- payload: { id, created_at (ISO), local_receipt_no, cashier_id, subtotal_cents, discount_cents,
--            total_cents, tax_included_cents, bottles_returned, bottle_fee_cents,
--            lines:[{product_id, pack_size_id, kind, name, label, qty, unit_price_cents,
--                    tax_rate_pct, tax_cents, line_total_cents}],
--            voided:[{product_id, pack_size_id, name, label, qty, unit_price_cents, reason, by}],
--            payments:[{method, amount_cents, tendered_cents, change_cents, reference}] }
create function public.complete_sale(p_sale jsonb) returns jsonb
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
                            total_cents, tax_included_cents, bottles_returned, bottle_fee_cents, created_at)
  values (v_id, v_profile.store_id, nullif(p_sale ->> 'local_receipt_no', '')::bigint, coalesce(v_cashier, v_profile.id),
          v_profile.id, v_subtotal, v_discount, v_total, coalesce((p_sale ->> 'tax_included_cents')::bigint, 0),
          v_returned, coalesce((p_sale ->> 'bottle_fee_cents')::bigint, 0),
          coalesce((p_sale ->> 'created_at')::timestamptz, now()))
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
        insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, created_by)
        values (v_profile.store_id, (v_line ->> 'product_id')::uuid, v_id, 'sold',
                (v_line ->> 'qty')::numeric::int, v_profile.id);
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
    insert into public.bottle_ledger (store_id, sale_id, event, qty, created_by)
    values (v_profile.store_id, v_id, 'returned_with_purchase', v_returned, v_profile.id);
  end if;
  if v_fee_qty > 0 then
    insert into public.bottle_ledger (store_id, sale_id, event, qty, amount_cents, created_by)
    values (v_profile.store_id, v_id, 'fee_charged', v_fee_qty, v_fee_qty * v_store.bottle_fee_cents, v_profile.id);
  end if;
  if v_bottle_qty - v_returned - v_fee_qty > 0 then
    -- bottles with no empty and no fee: a supervisor waived the fee at the till
    insert into public.bottle_ledger (store_id, sale_id, event, qty, created_by)
    values (v_profile.store_id, v_id, 'fee_waived', v_bottle_qty - v_returned - v_fee_qty, v_profile.id);
    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, reason)
    values (v_profile.store_id, 'bottle_fee_waived', 'sales', v_id, v_profile.id,
            (v_bottle_qty - v_returned - v_fee_qty)::text || ' bottle fee(s) waived');
  end if;

  return jsonb_build_object('sale_id', v_id, 'receipt_no', v_receipt, 'status', 'created');
end $$;

-- â”€â”€ archive a product (never a hard delete). Owner only. â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- The app re-asks for the owner's password before calling this.
create function public.archive_product(p_product uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile public.profiles; v_before jsonb;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found or v_profile.role <> 'owner' then
    raise exception 'only the owner can archive a product' using errcode = '42501';
  end if;
  select to_jsonb(p) into v_before from public.products p where id = p_product and store_id = v_profile.store_id;
  if v_before is null then raise exception 'product not found'; end if;

  update public.products
    set is_active = false, archived_at = now(), archived_by = v_profile.id
    where id = p_product;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, approved_by, before, reason)
  values (v_profile.store_id, 'product_archived', 'products', p_product, v_profile.id, v_profile.id, v_before, p_reason);
end $$;

-- â”€â”€ stock adjustment (damage, expiry, count correction) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Owner directly, or any signed-in till with a supervisor approval token for 'stock_adjustment'.
create function public.adjust_stock(
  p_product uuid, p_pack_size uuid, p_qty_change numeric, p_reason text, p_token uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare v_profile public.profiles; v_approver uuid;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  if p_qty_change = 0 then raise exception 'quantity change cannot be zero'; end if;
  if not exists (select 1 from public.products where id = p_product and store_id = v_profile.store_id) then
    raise exception 'product not found';
  end if;

  if v_profile.role = 'owner' then
    v_approver := v_profile.id;
  else
    v_approver := public.consume_approval(p_token, 'stock_adjustment');
  end if;

  insert into public.stock_movements (store_id, product_id, pack_size_id, qty_change, type, reason, created_by)
  values (v_profile.store_id, p_product, p_pack_size, p_qty_change, 'adjustment', p_reason, v_profile.id);

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, approved_by, reason, after)
  values (v_profile.store_id, 'stock_adjusted', 'products', p_product, v_profile.id, v_approver, p_reason,
          jsonb_build_object('qty_change', p_qty_change, 'pack_size_id', p_pack_size));
end $$;

-- â”€â”€ who may call what â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
-- Postgres (and Supabase's default privileges) make new functions executable by everyone, so close
-- that first, then open only what the app needs.
revoke all on function
  public.verify_supervisor(text, text, text),
  public.consume_approval(uuid, text),
  public.complete_sale(jsonb),
  public.archive_product(uuid, text),
  public.adjust_stock(uuid, uuid, numeric, text, uuid)
  from public, anon, authenticated;

grant execute on function
  public.verify_supervisor(text, text, text),
  public.complete_sale(jsonb),
  public.archive_product(uuid, text),
  public.adjust_stock(uuid, uuid, numeric, text, uuid)
  to authenticated;
-- consume_approval is internal: not granted to any client role.
