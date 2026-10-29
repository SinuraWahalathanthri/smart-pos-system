-- Suppliers, stock corrections and archiving, reachable from the dashboard.
--
-- Three things existed in the schema with no way to use them:
--
--   suppliers         save_purchase() refuses a bill without a supplier, and nothing could create
--                     one, so a new shop could never record a supplier bill. save_supplier() is the
--                     write path, guarded like save_purchase() so whoever records bills can add the
--                     supplier they came from.
--   adjust_stock()    0003 resolved the caller with `where auth_user_id = auth.uid()` and no store,
--                     which picks an arbitrary profile for an owner of two shops. It also accepted a
--                     packet size from another product and let a correction drive stock below zero.
--                     Supervisors now adjust directly (PLAN.md §3: "Supervisor or owner"); a cashier
--                     still needs an approval token.
--   archive_product() Same caller lookup. Now resolved through app_store_id() and a reason is
--                     required, because an archived product disappears from every list.
--
-- Signatures of adjust_stock and archive_product are unchanged, so 0003's grants still apply.

-- -- suppliers ----------------------------------------------------------------------------------
create or replace function public.save_supplier(p_supplier jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_id uuid := nullif(p_supplier ->> 'id', '')::uuid;
  v_name text := nullif(trim(coalesce(p_supplier ->> 'name', '')), '');
  v_terms int := coalesce(nullif(p_supplier ->> 'payment_terms_days', '')::int, 0);
  v_before jsonb;
begin
  if v_name is null then raise exception 'a supplier needs a name'; end if;
  if v_terms < 0 then raise exception 'payment terms cannot be negative'; end if;

  -- Two suppliers with one name make every bill ambiguous, so the name is the identity a person sees.
  if exists (
    select 1 from public.suppliers
     where store_id = v_me.store_id and lower(name) = lower(v_name)
       and id is distinct from v_id
  ) then
    raise exception 'a supplier called % already exists', v_name;
  end if;

  if v_id is null then
    insert into public.suppliers (store_id, name, contact_name, phone, email, vat_no, payment_terms_days, is_active)
    values (
      v_me.store_id, v_name,
      nullif(trim(coalesce(p_supplier ->> 'contact_name', '')), ''),
      nullif(trim(coalesce(p_supplier ->> 'phone', '')), ''),
      nullif(trim(coalesce(p_supplier ->> 'email', '')), ''),
      nullif(trim(coalesce(p_supplier ->> 'vat_no', '')), ''),
      v_terms,
      coalesce((p_supplier ->> 'is_active')::boolean, true)
    )
    returning id into v_id;
  else
    select to_jsonb(s) into v_before from public.suppliers s where id = v_id and store_id = v_me.store_id;
    if v_before is null then raise exception 'supplier not found'; end if;

    update public.suppliers set
      name = v_name,
      contact_name = nullif(trim(coalesce(p_supplier ->> 'contact_name', '')), ''),
      phone = nullif(trim(coalesce(p_supplier ->> 'phone', '')), ''),
      email = nullif(trim(coalesce(p_supplier ->> 'email', '')), ''),
      vat_no = nullif(trim(coalesce(p_supplier ->> 'vat_no', '')), ''),
      payment_terms_days = v_terms,
      is_active = coalesce((p_supplier ->> 'is_active')::boolean, is_active)
     where id = v_id;
  end if;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
  values (v_me.store_id, case when v_before is null then 'supplier_created' else 'supplier_updated' end,
          'suppliers', v_id, v_me.id, v_before,
          (select to_jsonb(s) from public.suppliers s where id = v_id));

  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

revoke all on function public.save_supplier(jsonb) from public, anon, authenticated;
grant execute on function public.save_supplier(jsonb) to authenticated;

-- -- stock correction (damage, expiry, theft, count) ---------------------------------------------
create or replace function public.adjust_stock(
  p_product uuid, p_pack_size uuid, p_qty_change numeric, p_reason text, p_token uuid default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_product public.products;
  v_on_hand numeric;
  v_approver uuid;
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required'; end if;
  if coalesce(p_qty_change, 0) = 0 then raise exception 'quantity change cannot be zero'; end if;

  select * into v_product from public.products where id = p_product and store_id = v_me.store_id;
  if not found then raise exception 'product not found'; end if;

  -- Same rule as receive_stock(): a weighted product's stock lives on its packets.
  if v_product.sale_mode = 'weighted' then
    if p_pack_size is null then raise exception 'choose which packet size is being corrected'; end if;
    select packets_on_hand into v_on_hand from public.pack_sizes
     where id = p_pack_size and product_id = p_product and store_id = v_me.store_id;
    if not found then raise exception 'unknown packet size'; end if;
  elsif p_pack_size is not null then
    raise exception 'this product is sold by unit, not by packet';
  else
    v_on_hand := v_product.stock_on_hand;
  end if;

  -- Removing more than is there is not a correction, it is a typo.
  if p_qty_change < 0 and v_on_hand + p_qty_change < 0 then
    raise exception 'cannot remove % - only % on hand', trim_scale(-p_qty_change), trim_scale(v_on_hand);
  end if;

  if v_me.role in ('owner', 'supervisor') then
    v_approver := v_me.id;
  else
    v_approver := public.consume_approval(p_token, 'stock_adjustment');
  end if;

  insert into public.stock_movements (store_id, product_id, pack_size_id, qty_change, type, reason, created_by)
  values (v_me.store_id, p_product, p_pack_size, p_qty_change, 'adjustment', trim(p_reason), v_me.id);

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, approved_by, reason, after)
  values (v_me.store_id, 'stock_adjusted', 'products', p_product, v_me.id, v_approver, trim(p_reason),
          jsonb_build_object('qty_change', p_qty_change, 'pack_size_id', p_pack_size,
                             'on_hand_before', v_on_hand, 'on_hand_after', v_on_hand + p_qty_change));
end $$;

-- -- archive (soft delete) ------------------------------------------------------------------------
create or replace function public.archive_product(p_product uuid, p_reason text) returns void
language plpgsql security definer set search_path = public as $$
declare v_me public.profiles; v_before jsonb;
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found or v_me.role <> 'owner' then
    raise exception 'only the owner can archive a product' using errcode = '42501';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to archive a product'; end if;

  select to_jsonb(p) into v_before from public.products p
   where id = p_product and store_id = v_me.store_id and archived_at is null;
  if v_before is null then raise exception 'product not found'; end if;

  update public.products
     set is_active = false, archived_at = now(), archived_by = v_me.id
   where id = p_product;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, approved_by, before, reason)
  values (v_me.store_id, 'product_archived', 'products', p_product, v_me.id, v_me.id, v_before, trim(p_reason));
end $$;
