-- Staff and product management, callable from the dashboard.
--
-- These are SECURITY DEFINER on purpose: pin_hash must never be readable by the browser, so the
-- hashing happens here, server side, exactly like complete_sale. The browser sends a PIN and gets
-- a result, never a hash.
--
-- Who may do what, matching the shop's rules:
-- owner       staff, products, store settings
-- supervisor  products only; touch staff -> refused
-- cashier     neither
--
-- Every check is server side. The UI also hides what a role cannot use, but that is convenience:
-- these functions are the actual boundary.

-- -- staff -----------------------------------------------------------------------------------
create or replace function public.assert_can_manage_staff()
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_profile.role <> 'owner' then
    raise exception 'only the owner can manage staff' using errcode = '42501';
  end if;
  return v_profile;
end $$;

create or replace function public.create_staff(
  p_name      text,
  p_staff_code text,
  p_role      public.user_role,
  p_pin       text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_id uuid;
begin
  v_me := public.assert_can_manage_staff();

  if coalesce(trim(p_name), '') = '' then raise exception 'staff name is required'; end if;
  if coalesce(trim(p_staff_code), '') = '' then raise exception 'staff code is required'; end if;
  -- 4-8 digits: short enough to type all day, long enough not to be guessed.
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'pin must be 4 to 8 digits'; end if;
  if p_role = 'owner' then
    raise exception 'there can only be one owner per shop';
  end if;

  if exists (
    select 1 from public.profiles
     where store_id = v_me.store_id and staff_code = trim(p_staff_code)
  ) then
    raise exception 'staff code % is already used', trim(p_staff_code) using errcode = '23505';
  end if;

  insert into public.profiles (store_id, full_name, staff_code, role, pin_hash)
  values (v_me.store_id, trim(p_name), trim(p_staff_code), p_role,
          extensions.crypt(p_pin, extensions.gen_salt('bf')))
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'staff_code', trim(p_staff_code), 'role', p_role);
end $$;

create or replace function public.set_staff_pin(
  p_staff_id uuid,
  p_pin      text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_target public.profiles;
begin
  v_me := public.assert_can_manage_staff();

  select * into v_target from public.profiles
   where id = p_staff_id and store_id = v_me.store_id;
  if not found then raise exception 'unknown staff member'; end if;
  if p_pin !~ '^[0-9]{4,8}$' then raise exception 'pin must be 4 to 8 digits'; end if;

  update public.profiles
     set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf')),
         failed_attempts = 0,
         locked_until = null
   where id = p_staff_id;

  return jsonb_build_object('id', p_staff_id, 'ok', true);
end $$;

create or replace function public.set_staff_active(
  p_staff_id uuid,
  p_active   boolean
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public.assert_can_manage_staff();
  if p_staff_id = v_me.id and not p_active then
    raise exception 'you cannot deactivate your own account';
  end if;

  update public.profiles
     set is_active = p_active
   where id = p_staff_id and store_id = v_me.store_id;
  if not found then raise exception 'unknown staff member'; end if;

  return jsonb_build_object('id', p_staff_id, 'is_active', p_active);
end $$;

create or replace function public.set_staff_badge(
  p_staff_id uuid,
  p_badge    text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
begin
  v_me := public.assert_can_manage_staff();
  if coalesce(trim(p_badge), '') = '' then raise exception 'badge is required'; end if;

  update public.profiles
     set badge_hash = extensions.crypt(trim(p_badge), extensions.gen_salt('bf'))
   where id = p_staff_id and store_id = v_me.store_id;
  if not found then raise exception 'unknown staff member'; end if;

  return jsonb_build_object('id', p_staff_id, 'ok', true);
end $$;

-- -- products --------------------------------------------------------------------------------
create or replace function public.assert_can_manage_products()
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  -- A cashier sells; a supervisor and the owner maintain the catalogue.
  if v_profile.role not in ('owner', 'supervisor') then
    raise exception 'only the owner or a supervisor can change products' using errcode = '42501';
  end if;
  return v_profile;
end $$;

create or replace function public.save_product(p_product jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_id uuid := nullif(p_product ->> 'id', '')::uuid;
  v_price bigint := coalesce((p_product ->> 'price_cents')::bigint, 0);
  v_mode public.sale_mode := coalesce((p_product ->> 'sale_mode')::public.sale_mode, 'unit');
  v_kind public.product_kind := coalesce((p_product ->> 'kind')::public.product_kind, 'trade');
  v_name text := trim(coalesce(p_product ->> 'name', ''));
  v_barcode text := nullif(trim(coalesce(p_product ->> 'barcode', '')), '');
  v_opening numeric := coalesce((p_product ->> 'opening_stock')::numeric, 0);
begin
  v_me := public.assert_can_manage_products();
  if v_name = '' then raise exception 'product name is required'; end if;
  if v_price < 0 then raise exception 'price cannot be negative'; end if;
  if v_id is null then
    insert into public.products (
      store_id, name, sku, category_id, kind, sale_mode, price_cents, tax_rate_pct,
      reorder_level, has_expiry, shelf_life_days, is_returnable_bottle, color, is_active
    ) values (
      v_me.store_id, v_name, nullif(trim(coalesce(p_product ->> 'sku', '')), ''),
      nullif(p_product ->> 'category_id', '')::uuid, v_kind, v_mode, v_price,
      coalesce((p_product ->> 'tax_rate_pct')::numeric, 0),
      coalesce((p_product ->> 'reorder_level')::numeric, 0),
      coalesce((p_product ->> 'has_expiry')::boolean, false),
      nullif(p_product ->> 'shelf_life_days', '')::int,
      coalesce((p_product ->> 'is_returnable_bottle')::boolean, false),
      coalesce(nullif(p_product ->> 'color', ''), 'amber'),
      coalesce((p_product ->> 'is_active')::boolean, true)
    ) returning id into v_id;
  else
    -- Scoped to the caller's store, so an id from another shop changes nothing.
    update public.products set
      name = v_name,
      sku = nullif(trim(coalesce(p_product ->> 'sku', '')), ''),
      category_id = nullif(p_product ->> 'category_id', '')::uuid,
      kind = v_kind,
      sale_mode = v_mode,
      price_cents = v_price,
      tax_rate_pct = coalesce((p_product ->> 'tax_rate_pct')::numeric, tax_rate_pct),
      reorder_level = coalesce((p_product ->> 'reorder_level')::numeric, reorder_level),
      has_expiry = coalesce((p_product ->> 'has_expiry')::boolean, has_expiry),
      shelf_life_days = nullif(p_product ->> 'shelf_life_days', '')::int,
      is_returnable_bottle = coalesce((p_product ->> 'is_returnable_bottle')::boolean, is_returnable_bottle),
      color = coalesce(nullif(p_product ->> 'color', ''), color),
      is_active = coalesce((p_product ->> 'is_active')::boolean, is_active),
      updated_at = now()
    where id = v_id and store_id = v_me.store_id;
    if not found then raise exception 'unknown product'; end if;
  end if;
  -- Opening stock is a movement, not a column write: guard_stock_columns zeroes a direct
  -- stock_on_hand on insert, which would silently lose the shop's opening count.
  if v_opening <> 0 then
    insert into public.stock_movements (store_id, product_id, qty_change, type, created_by)
    values (v_me.store_id, v_id, v_opening, 'opening', v_me.id);
  end if;
  -- A scanned barcode must resolve to exactly one product in the shop.
  if v_barcode is not null then
    insert into public.product_barcodes (store_id, product_id, barcode, is_primary)
    values (v_me.store_id, v_id, v_barcode, true)
    on conflict (store_id, barcode) do update set product_id = excluded.product_id;
  end if;
  return jsonb_build_object('id', v_id);
end $$;
-- grants
revoke all on function
  public.assert_can_manage_staff(),
  public.assert_can_manage_products(),
  public.create_staff(text, text, public.user_role, text),
  public.set_staff_pin(uuid, text),
  public.set_staff_active(uuid, boolean),
  public.set_staff_badge(uuid, text),
  public.save_product(jsonb)
  from public, anon, authenticated;
grant execute on function
  public.create_staff(text, text, public.user_role, text),
  public.set_staff_pin(uuid, text),
  public.set_staff_active(uuid, boolean),
  public.set_staff_badge(uuid, text),
  public.save_product(jsonb)
  to authenticated;
