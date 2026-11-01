-- Any kind of business, not only a spice shop.
--
-- Until now the catalogue knew two ways to sell: a unit item, or a loose spice sold in fixed packets.
-- A clothing shop needs one shirt in many sizes and colours, each with its own stock and barcode; a
-- hardware shop sells cable by the metre; a salon sells time, which has no stock at all; a pharmacy
-- must know which batch expires first. This migration adds those without a second stock system:
--
--   * pack_sizes becomes the general "option" table. A weighted product's options are its packets
--     (weight_g set, as before); a `variant` product's options are size/colour combinations
--     (`attributes`, no weight). Both already flow through sales, stock, barcodes, refunds and
--     reports by pack_size_id, so a variant is sold, counted and reversed by the code that exists.
--   * `measured` products are sold in a decimal quantity of their `unit` (0.75 kg, 2.5 m).
--   * `track_stock = false` products (services) never write the stock ledger.
--   * product_batches (in 0001 since the start, never filled) records batch and expiry on receipt,
--     and sales use up the batch that expires first.
--   * stores.features / stores.theme: which of these a shop uses, and its colours. They are the
--     owner's choice, set from Settings. An empty object means "the defaults for its business type".
--
-- Nothing here changes how an existing shop behaves: every new column defaults to today's behaviour.

-- ── 1. new ways to sell ──────────────────────────────────────────────────────────────────────────
-- Added, not used, in this file: a new enum value cannot be used in the transaction that adds it,
-- and the functions below only name it inside their bodies, which run later.
alter type public.sale_mode add value if not exists 'variant';
alter type public.sale_mode add value if not exists 'measured';

alter table public.products
  add column if not exists unit text not null default 'pcs',
  add column if not exists track_stock boolean not null default true;

-- An option without a weight is a variant ("M / Black"); the packet rule still holds where a
-- weight is given.
alter table public.pack_sizes alter column weight_g drop not null;
alter table public.pack_sizes drop constraint if exists pack_sizes_weight_g_check;
alter table public.pack_sizes drop constraint if exists pack_sizes_product_id_weight_g_key;
alter table public.pack_sizes
  add column if not exists attributes jsonb not null default '{}'::jsonb,
  add column if not exists sku text;
do $$ begin
  alter table public.pack_sizes add constraint pack_sizes_weight_positive check (weight_g is null or weight_g > 0);
exception when duplicate_object then null; end $$;
-- The old unique(product_id, weight_g), kept for packets only. Retired sizes are excluded so a size
-- removed and added back is not refused for clashing with its own past.
create unique index if not exists pack_sizes_product_weight_ux
  on public.pack_sizes (product_id, weight_g) where weight_g is not null and is_active;

-- ── 2. what kind of business, and how it looks ───────────────────────────────────────────────────
alter table public.stores
  add column if not exists features jsonb not null default '{}'::jsonb,
  add column if not exists theme jsonb not null default '{}'::jsonb;

-- One list, used by the registration form, the application check and Settings.
create or replace function public.is_business_type(p_type text) returns boolean
language sql immutable as $$
  select p_type in ('retail', 'fashion', 'electronics', 'hardware', 'grocery', 'restaurant', 'bakery',
                    'pharmacy', 'beauty', 'books', 'services', 'wholesale', 'manufacturing', 'other')
$$;

alter table public.vendor_applications drop constraint if exists vendor_applications_business_type_check;
alter table public.vendor_applications
  add constraint vendor_applications_business_type_check check (public.is_business_type(business_type));

-- The registration check now reads the shared list instead of its own copy of it.
create or replace function public.submit_vendor_application(p_application jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text;
  v_settings public.platform_settings;
  v_existing public.vendor_applications;
  v_id       uuid;
  v_status   text;
  v_owner    text := nullif(trim(coalesce(p_application ->> 'owner_name', '')), '');
  v_legal    text := nullif(trim(coalesce(p_application ->> 'legal_name', '')), '');
  v_type     text := lower(nullif(trim(coalesce(p_application ->> 'business_type', '')), ''));
  v_country  text := nullif(trim(coalesce(p_application ->> 'country', '')), '');
  v_currency text := upper(coalesce(nullif(trim(coalesce(p_application ->> 'currency', '')), ''), 'LKR'));
  v_locs     int  := coalesce(nullif(p_application ->> 'locations_count', '')::int, 1);
  v_tills    int  := coalesce(nullif(p_application ->> 'tills_count', '')::int, 1);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.is_platform_admin() then
    raise exception 'a platform administrator cannot register a business' using errcode = '42501';
  end if;

  v_email := public.verified_email();
  if v_email is null then
    raise exception 'verify your email address before submitting the application' using errcode = '42501';
  end if;
  if public.is_disposable_email(v_email) then
    raise exception 'use a permanent email address, not a temporary inbox';
  end if;
  if public.caller_has_shop() then
    raise exception 'this account already belongs to a shop';
  end if;

  if v_owner is null then raise exception 'enter your full name'; end if;
  if v_legal is null then raise exception 'enter the business name'; end if;
  if v_type is null or not public.is_business_type(v_type) then
    raise exception 'choose what kind of business this is';
  end if;
  if v_country is null then raise exception 'choose the country the business trades in'; end if;
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'currency must be a three-letter code such as LKR'; end if;
  if v_locs < 1 or v_tills < 1 then raise exception 'locations and tills must be at least 1'; end if;

  select * into v_settings from public.platform_settings where id;
  if coalesce(p_application ->> 'terms_version', '') <> v_settings.terms_version then
    raise exception 'accept the current terms of service to continue';
  end if;

  v_status := case when v_settings.auto_approve_vendors then 'approved' else 'submitted' end;

  select * into v_existing from public.vendor_applications
   where auth_user_id = v_uid and status in ('submitted', 'info_requested', 'approved')
   for update;

  if found and v_existing.status = 'approved' then
    raise exception 'this application is already approved - open your shop';
  end if;

  if found then
    update public.vendor_applications set
      status = v_status,
      owner_name = v_owner,
      owner_phone = nullif(trim(coalesce(p_application ->> 'owner_phone', '')), ''),
      legal_name = v_legal,
      trading_name = nullif(trim(coalesce(p_application ->> 'trading_name', '')), ''),
      business_type = v_type,
      country = v_country,
      currency = v_currency,
      address = nullif(trim(coalesce(p_application ->> 'address', '')), ''),
      phone = nullif(trim(coalesce(p_application ->> 'phone', '')), ''),
      tax_number = nullif(trim(coalesce(p_application ->> 'tax_number', '')), ''),
      registration_number = nullif(trim(coalesce(p_application ->> 'registration_number', '')), ''),
      locations_count = v_locs,
      tills_count = v_tills,
      terms_version = v_settings.terms_version,
      terms_accepted_at = now(),
      submitted_at = now(),
      reviewed_by = null,
      reviewed_at = case when v_status = 'approved' then now() else null end,
      decision_reason = case when v_status = 'approved' then 'Approved automatically' else null end,
      updated_at = now()
     where id = v_existing.id
    returning id into v_id;
  else
    insert into public.vendor_applications (
      auth_user_id, status, owner_name, owner_phone, legal_name, trading_name, business_type, country,
      currency, address, phone, tax_number, registration_number, locations_count, tills_count,
      terms_version, terms_accepted_at, reviewed_at, decision_reason
    ) values (
      v_uid, v_status, v_owner, nullif(trim(coalesce(p_application ->> 'owner_phone', '')), ''), v_legal,
      nullif(trim(coalesce(p_application ->> 'trading_name', '')), ''), v_type, v_country, v_currency,
      nullif(trim(coalesce(p_application ->> 'address', '')), ''),
      nullif(trim(coalesce(p_application ->> 'phone', '')), ''),
      nullif(trim(coalesce(p_application ->> 'tax_number', '')), ''),
      nullif(trim(coalesce(p_application ->> 'registration_number', '')), ''),
      v_locs, v_tills, v_settings.terms_version, now(),
      case when v_status = 'approved' then now() else null end,
      case when v_status = 'approved' then 'Approved automatically' else null end
    )
    returning id into v_id;
  end if;

  if v_status = 'approved' then
    insert into public.platform_audit (actor, action, target_user, detail)
    values (null, 'vendor_auto_approved', v_uid, jsonb_build_object('application_id', v_id, 'business', v_legal));
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status);
end $$;

-- Features a shop may switch on or off. Anything else in the object is refused, so a typo cannot
-- silently do nothing.
create or replace function public.clean_store_features(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_key text;
  v_out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'::jsonb; end if;
  for v_key in select jsonb_object_keys(p) loop
    if v_key not in ('packs', 'variants', 'measured', 'expiry', 'bottles', 'production', 'services',
                     'serials', 'tables') then
      raise exception 'unknown feature: %', v_key;
    end if;
    if jsonb_typeof(p -> v_key) <> 'boolean' then
      raise exception 'feature % must be true or false', v_key;
    end if;
    v_out := v_out || jsonb_build_object(v_key, p -> v_key);
  end loop;
  return v_out;
end $$;

-- Colours. Only a hex accent and a named surface tone are stored; the app works out every shade
-- from those and keeps text readable (lib/theme.ts), so no saved theme can make the till illegible.
create or replace function public.clean_store_theme(p jsonb) returns jsonb
language plpgsql immutable as $$
declare
  v_out jsonb := '{}'::jsonb;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return '{}'::jsonb; end if;
  if p ? 'accent' then
    if coalesce(p ->> 'accent', '') !~ '^#[0-9a-fA-F]{6}$' then
      raise exception 'accent must be a colour like #1d4ed8';
    end if;
    v_out := v_out || jsonb_build_object('accent', lower(p ->> 'accent'));
  end if;
  if p ? 'tone' then
    if coalesce(p ->> 'tone', '') not in ('warm', 'neutral', 'cool', 'fresh', 'rose', 'midnight') then
      raise exception 'unknown surface tone: %', p ->> 'tone';
    end if;
    v_out := v_out || jsonb_build_object('tone', p ->> 'tone');
  end if;
  if p ? 'mode' then
    if coalesce(p ->> 'mode', '') not in ('light', 'dark', 'system') then
      raise exception 'mode must be light, dark or system';
    end if;
    v_out := v_out || jsonb_build_object('mode', p ->> 'mode');
  end if;
  return v_out;
end $$;

/**
 * The owner's business settings: type, features and colours, in one call so Settings saves once.
 * Keys that are absent are left as they are.
 */
create or replace function public.save_shop_profile(p_profile jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me     public.profiles;
  v_before jsonb;
  v_type   text := lower(nullif(trim(coalesce(p_profile ->> 'business_type', '')), ''));
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found or v_me.role <> 'owner' then
    raise exception 'only the owner can change the business settings' using errcode = '42501';
  end if;
  if p_profile ? 'business_type' and (v_type is null or not public.is_business_type(v_type)) then
    raise exception 'choose what kind of business this is';
  end if;

  select jsonb_build_object('business_type', business_type, 'features', features, 'theme', theme)
    into v_before from public.stores where id = v_me.store_id;

  update public.stores set
    business_type = case when p_profile ? 'business_type' then v_type else business_type end,
    features = case when p_profile ? 'features' then public.clean_store_features(p_profile -> 'features') else features end,
    theme = case when p_profile ? 'theme' then public.clean_store_theme(p_profile -> 'theme') else theme end
   where id = v_me.store_id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
  select v_me.store_id, 'shop_profile_updated', 'stores', v_me.store_id, v_me.id, v_before,
         jsonb_build_object('business_type', business_type, 'features', features, 'theme', theme)
    from public.stores where id = v_me.store_id;

  return (select jsonb_build_object('business_type', business_type, 'features', features, 'theme', theme)
            from public.stores where id = v_me.store_id);
end $$;

-- ── 3. the shop context the app reads ────────────────────────────────────────────────────────────
create or replace function public.my_shop() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_store public.stores;
  v_role  public.user_role;
  v_must  boolean;
  v_admin boolean;
begin
  if v_uid is null then
    return jsonb_build_object('onboarded', false, 'is_platform_admin', false);
  end if;

  v_admin := public.is_platform_admin();

  select st.* into v_store
    from public.stores st
   where st.owner_id = v_uid
      or exists (select 1 from public.profiles p
                  where p.auth_user_id = v_uid and p.store_id = st.id and p.is_active)
   order by st.created_at
   limit 1;

  if not found then
    return jsonb_build_object('onboarded', false, 'is_platform_admin', v_admin);
  end if;

  select p.role, p.must_change_password into v_role, v_must
    from public.profiles p
   where p.auth_user_id = v_uid and p.store_id = v_store.id and p.is_active
   limit 1;

  return jsonb_build_object(
    'onboarded', true,
    'is_platform_admin', v_admin,
    'must_change_password', coalesce(v_must, false),
    'suspended', not v_store.is_active,
    'suspended_reason', v_store.suspended_reason,
    'store', jsonb_build_object(
      'id', v_store.id, 'name', v_store.name, 'address', v_store.address,
      'phone', v_store.phone, 'vat_no', v_store.vat_no, 'currency', v_store.currency,
      'bottle_fee_cents', v_store.bottle_fee_cents,
      'max_cashier_discount_pct', v_store.max_cashier_discount_pct,
      'prices_include_tax', v_store.prices_include_tax,
      'is_active', v_store.is_active,
      'business_type', v_store.business_type,
      'features', v_store.features,
      'theme', v_store.theme),
    'role', coalesce(v_role, 'owner'::public.user_role)
  );
end $$;

-- The till's context. 0004 looked the device up by auth_user_id alone, which is ambiguous for an
-- account that works in two shops (the same flaw 0028 fixed in adjust_stock): it now resolves the
-- shop through app_store_id() like every other function.
create or replace function public.get_till_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles; v_store public.stores;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_store from public.stores where id = v_profile.store_id;
  return jsonb_build_object(
    'store', jsonb_build_object('id', v_store.id, 'name', v_store.name, 'currency', v_store.currency,
      'bottle_fee_cents', v_store.bottle_fee_cents, 'max_cashier_discount_pct', v_store.max_cashier_discount_pct,
      'prices_include_tax', v_store.prices_include_tax,
      'business_type', v_store.business_type, 'features', v_store.features, 'theme', v_store.theme),
    'device', jsonb_build_object('id', v_profile.id, 'role', v_profile.role, 'name', v_profile.full_name));
end $$;

-- ── 4. products ──────────────────────────────────────────────────────────────────────────────────
-- Units a product can be counted in. Free text would let "Kg", "kgs" and "kilo" become three units
-- that never add up in a report.
create or replace function public.is_product_unit(p_unit text) returns boolean
language sql immutable as $$
  select p_unit in ('pcs', 'kg', 'g', 'l', 'ml', 'm', 'cm', 'ft', 'yd', 'sqft', 'pair', 'box', 'pack',
                    'dozen', 'set', 'roll', 'bottle', 'hr', 'session')
$$;

-- A scanned code must find exactly one thing. save_product used to move a barcode silently from
-- whichever product had it to the one being saved, so typing a wrong code into one product broke
-- the scan of another without a word.
create or replace function public.claim_barcode(
  p_store uuid, p_product uuid, p_pack uuid, p_barcode text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_owner public.product_barcodes;
  v_name text;
begin
  if p_barcode is null then return; end if;
  select * into v_owner from public.product_barcodes where store_id = p_store and barcode = p_barcode;
  if found then
    if v_owner.product_id = p_product and v_owner.pack_size_id is not distinct from p_pack then return; end if;
    if v_owner.product_id <> p_product then
      select name into v_name from public.products where id = v_owner.product_id;
      raise exception 'barcode % is already used by %', p_barcode, coalesce(v_name, 'another product');
    end if;
    -- Same product, moving between the product and one of its options.
    update public.product_barcodes set pack_size_id = p_pack where id = v_owner.id;
    return;
  end if;
  insert into public.product_barcodes (store_id, product_id, pack_size_id, barcode, is_primary)
  values (p_store, p_product, p_pack, p_barcode, true);
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
  v_unit text := lower(coalesce(nullif(trim(coalesce(p_product ->> 'unit', '')), ''), 'pcs'));
  v_track boolean := coalesce((p_product ->> 'track_stock')::boolean, true);
begin
  v_me := public.assert_can_manage_products();
  if v_name = '' then raise exception 'product name is required'; end if;
  if v_price < 0 then raise exception 'price cannot be negative'; end if;
  if not public.is_product_unit(v_unit) then raise exception 'unknown unit: %', v_unit; end if;
  if v_opening < 0 then raise exception 'opening stock cannot be negative'; end if;
  -- Half a shirt is not a sale. Only a measured product may carry a fraction.
  if v_mode <> 'measured' and v_opening <> trunc(v_opening) then
    raise exception 'opening stock must be a whole number for this product';
  end if;
  if v_mode in ('weighted', 'variant') and not v_track then
    raise exception 'a product with sizes or variants keeps stock per option';
  end if;

  if v_id is null then
    insert into public.products (
      store_id, name, sku, category_id, kind, sale_mode, price_cents, tax_rate_pct,
      reorder_level, has_expiry, shelf_life_days, is_returnable_bottle, color, is_active, unit, track_stock
    ) values (
      v_me.store_id, v_name, nullif(trim(coalesce(p_product ->> 'sku', '')), ''),
      nullif(p_product ->> 'category_id', '')::uuid, v_kind, v_mode, v_price,
      coalesce((p_product ->> 'tax_rate_pct')::numeric, 0),
      coalesce((p_product ->> 'reorder_level')::numeric, 0),
      coalesce((p_product ->> 'has_expiry')::boolean, false),
      nullif(p_product ->> 'shelf_life_days', '')::int,
      coalesce((p_product ->> 'is_returnable_bottle')::boolean, false),
      coalesce(nullif(p_product ->> 'color', ''), '#b45309'),
      coalesce((p_product ->> 'is_active')::boolean, true),
      v_unit, v_track
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
      unit = v_unit,
      track_stock = v_track,
      updated_at = now()
    where id = v_id and store_id = v_me.store_id;
    if not found then raise exception 'unknown product'; end if;
  end if;
  -- Opening stock is a movement, not a column write: guard_stock_columns zeroes a direct
  -- stock_on_hand on insert, which would silently lose the shop's opening count. A product with
  -- options keeps its count per option (save_pack_sizes), so a product-level count is ignored.
  if v_opening <> 0 and v_mode not in ('weighted', 'variant') and v_track then
    insert into public.stock_movements (store_id, product_id, qty_change, type, created_by)
    values (v_me.store_id, v_id, v_opening, 'opening', v_me.id);
  end if;
  perform public.claim_barcode(v_me.store_id, v_id, null, v_barcode);
  return jsonb_build_object('id', v_id);
end $$;

/**
 * A product's options: packets for a weighted product, size/colour combinations for a variant one.
 *
 * As in 0013 the whole set is sent and replaced; stock is never set here except as the opening count
 * of an option created in this call, which is posted as an `opening` movement.
 */
create or replace function public.save_pack_sizes(p_product uuid, p_sizes jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_product public.products;
  v_row jsonb;
  v_id uuid;
  v_keep uuid[] := '{}';
  v_labels text[] := '{}';
  v_label text;
  v_weight int;
  v_attrs jsonb;
  v_opening numeric;
  v_new boolean;
begin
  v_me := public.assert_can_manage_products();
  select * into v_product from public.products where id = p_product and store_id = v_me.store_id;
  if not found then raise exception 'unknown product'; end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_sizes, '[]'::jsonb)) loop
    v_id := nullif(v_row ->> 'id', '')::uuid;
    v_weight := nullif(v_row ->> 'weight_g', '')::int;
    v_attrs := case when jsonb_typeof(v_row -> 'attributes') = 'object' then v_row -> 'attributes' else '{}'::jsonb end;
    v_opening := coalesce(nullif(v_row ->> 'opening_stock', '')::numeric, 0);

    if v_product.sale_mode = 'weighted' then
      if coalesce(v_weight, 0) <= 0 then raise exception 'packet weight must be greater than zero'; end if;
      v_label := coalesce(nullif(trim(v_row ->> 'label'), ''), v_weight || ' g');
    else
      -- "M / Black" from {"Size": "M", "Colour": "Black"} when no label is given.
      v_label := coalesce(
        nullif(trim(v_row ->> 'label'), ''),
        nullif((select string_agg(value, ' / ') from jsonb_each_text(v_attrs)), ''));
      if v_label is null then raise exception 'each variant needs a name, such as M / Black'; end if;
      if v_weight is not null and v_weight <= 0 then raise exception 'weight must be greater than zero'; end if;
    end if;
    if coalesce((v_row ->> 'price_cents')::bigint, -1) < 0 then
      raise exception 'option price cannot be negative';
    end if;
    if v_opening < 0 or v_opening <> trunc(v_opening) then
      raise exception 'opening stock for % must be a whole number', v_label;
    end if;
    if lower(v_label) = any (v_labels) then raise exception '% is listed twice', v_label; end if;
    v_labels := v_labels || lower(v_label);

    v_new := v_id is null;
    if v_new then
      insert into public.pack_sizes (store_id, product_id, label, weight_g, price_cents, sort_order, is_active,
                                     attributes, sku)
      values (
        v_me.store_id, p_product, v_label, v_weight,
        (v_row ->> 'price_cents')::bigint,
        coalesce((v_row ->> 'sort_order')::int, 0),
        coalesce((v_row ->> 'is_active')::boolean, true),
        v_attrs, nullif(trim(coalesce(v_row ->> 'sku', '')), '')
      ) returning id into v_id;
    else
      update public.pack_sizes set
        label = v_label,
        weight_g = v_weight,
        price_cents = (v_row ->> 'price_cents')::bigint,
        sort_order = coalesce((v_row ->> 'sort_order')::int, sort_order),
        is_active = coalesce((v_row ->> 'is_active')::boolean, is_active),
        attributes = v_attrs,
        sku = nullif(trim(coalesce(v_row ->> 'sku', '')), '')
      where id = v_id and product_id = p_product and store_id = v_me.store_id;
      if not found then raise exception 'unknown pack size'; end if;
    end if;

    -- Each option can carry its own barcode: the till's scan then adds that exact size and colour.
    perform public.claim_barcode(v_me.store_id, p_product, v_id, nullif(trim(coalesce(v_row ->> 'barcode', '')), ''));

    if v_new and v_opening > 0 then
      insert into public.stock_movements (store_id, product_id, pack_size_id, qty_change, type, created_by)
      values (v_me.store_id, p_product, v_id, v_opening, 'opening', v_me.id);
    end if;
    v_keep := v_keep || v_id;
  end loop;

  -- Options no longer on the form are retired rather than deleted: past sales and the stock ledger
  -- still point at them, and pack_sizes is referenced by product_barcodes.
  update public.pack_sizes set is_active = false
   where product_id = p_product and store_id = v_me.store_id
     and not (id = any (v_keep));

  return jsonb_build_object('product_id', p_product, 'sizes', coalesce(array_length(v_keep, 1), 0));
end $$;

-- ── 5. stock: options, services, batches ─────────────────────────────────────────────────────────
-- A service has no shelf. Rather than teach every writer (sale, refund, cancel, production) to skip
-- it, the ledger itself declines the row, so no path can give a haircut a stock count.
create or replace function public.skip_untracked_stock() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.products where id = new.product_id and not track_stock) then
    return null;
  end if;
  return new;
end $$;

drop trigger if exists stock_movements_skip_untracked on public.stock_movements;
create trigger stock_movements_skip_untracked before insert on public.stock_movements
  for each row execute function public.skip_untracked_stock();

-- Stock leaving the shop uses up the batch that expires first (FEFO). Batches without a date go
-- last. This is bookkeeping for the expiry report; on-hand counts still come from the ledger.
create or replace function public.consume_batches() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_left numeric := -new.qty_change;
  v_batch record;
  v_take numeric;
begin
  if new.qty_change >= 0 then return new; end if;
  for v_batch in
    select id, qty_remaining from public.product_batches
     where product_id = new.product_id
       and pack_size_id is not distinct from new.pack_size_id
       and qty_remaining > 0
     order by expiry_date nulls last, received_at
     for update
  loop
    exit when v_left <= 0;
    v_take := least(v_left, v_batch.qty_remaining);
    update public.product_batches set qty_remaining = qty_remaining - v_take where id = v_batch.id;
    v_left := v_left - v_take;
  end loop;
  return new;
end $$;

drop trigger if exists stock_movements_consume_batches on public.stock_movements;
create trigger stock_movements_consume_batches after insert on public.stock_movements
  for each row execute function public.consume_batches();

-- Inbound cost: 0021 derived a per-kg product cost by dividing by the packet weight, which a
-- variant does not have. Same function, with that step limited to packets.
create or replace function public.apply_inbound_cost() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_method public.cost_method;
  v_old_qty numeric;
  v_old_cost bigint;
  v_new_cost bigint;
  v_weight int;
begin
  if new.unit_cost_cents is null or new.qty_change <= 0 then
    return new;
  end if;
  if new.type not in ('purchase', 'production_in', 'opening', 'adjustment') then
    return new;
  end if;

  select st.cost_method into v_method from public.stores st where st.id = new.store_id;

  if new.pack_size_id is not null then
    select coalesce(ps.cost_cents, 0), ps.packets_on_hand, ps.weight_g
      into v_old_cost, v_old_qty, v_weight
      from public.pack_sizes ps where ps.id = new.pack_size_id;
    if v_old_qty is null then
      return new;
    end if;

    v_new_cost := case
      when v_method = 'latest' then new.unit_cost_cents
      when v_old_qty > 0 and v_old_cost > 0
        then round((v_old_qty * v_old_cost + new.qty_change * new.unit_cost_cents)
                   / (v_old_qty + new.qty_change))::bigint
      else new.unit_cost_cents
    end;

    update public.pack_sizes set cost_cents = v_new_cost where id = new.pack_size_id;
    -- A weighted product's stock_on_hand is kilograms, so its own cost is per kg. Deriving it here
    -- keeps inventory valuation and packet margins telling the same story. A variant (0030) has no
    -- weight: its cost lives on the option alone, so the product-level cost is left as it is.
    if v_weight is not null and v_weight > 0 then
      insert into public.product_costs (product_id, store_id, cost_cents)
      select new.product_id, new.store_id, round(v_new_cost * 1000.0 / v_weight)::bigint
      on conflict (product_id) do update set cost_cents = excluded.cost_cents;
    end if;
  else
    select coalesce(pc.cost_cents, 0), p.stock_on_hand
      into v_old_cost, v_old_qty
      from public.products p
      left join public.product_costs pc on pc.product_id = p.id
     where p.id = new.product_id;
    if v_old_qty is null then
      return new;
    end if;

    v_new_cost := case
      when v_method = 'latest' then new.unit_cost_cents
      when v_old_qty > 0 and v_old_cost > 0
        then round((v_old_qty * v_old_cost + new.qty_change * new.unit_cost_cents)
                   / (v_old_qty + new.qty_change))::bigint
      else new.unit_cost_cents
    end;

    insert into public.product_costs (product_id, store_id, cost_cents)
    values (new.product_id, new.store_id, v_new_cost)
    on conflict (product_id) do update set cost_cents = excluded.cost_cents;
  end if;

  insert into public.product_cost_history
    (store_id, product_id, pack_size_id, old_cost_cents, new_cost_cents, source, ref_table, ref_id, changed_by)
  values (new.store_id, new.product_id, new.pack_size_id, nullif(v_old_cost, 0), v_new_cost,
          case new.type when 'production_in' then 'production' when 'purchase' then 'purchase'
               when 'opening' then 'opening' else 'manual' end,
          new.ref_table, new.ref_id, new.created_by);

  return new;
end $$;

-- receive_stock / adjust_stock: a variant keeps stock on its options exactly as a weighted product
-- does, and a service has none to receive.
create or replace function public.receive_stock(
  p_product         uuid,
  p_pack_size       uuid,
  p_qty             numeric,
  p_unit_cost_cents bigint default null,
  p_supplier        text default null,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_product public.products;
  v_on_hand numeric;
begin
  v_me := public.assert_can_manage_products();

  select * into v_product from public.products where id = p_product and store_id = v_me.store_id;
  if not found then raise exception 'unknown product'; end if;
  if not v_product.track_stock then raise exception 'this item does not keep stock'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'quantity must be greater than zero'; end if;
  if v_product.sale_mode <> 'measured' and p_qty <> trunc(p_qty) then
    raise exception 'quantity must be a whole number for this product';
  end if;
  if p_unit_cost_cents is not null and p_unit_cost_cents < 0 then
    raise exception 'unit cost cannot be negative';
  end if;

  if v_product.sale_mode in ('weighted', 'variant') then
    if p_pack_size is null and v_product.sale_mode = 'weighted' then
      raise exception 'choose which packet size is being received';
    elsif p_pack_size is null then
      raise exception 'choose which size or variant is being received';
    end if;
    if not exists (
      select 1 from public.pack_sizes
       where id = p_pack_size and product_id = p_product and store_id = v_me.store_id
    ) then
      raise exception 'unknown packet size';
    end if;
  elsif p_pack_size is not null then
    raise exception 'this product is sold by unit, not by packet';
  end if;

  insert into public.stock_movements
    (store_id, product_id, pack_size_id, qty_change, type, unit_cost_cents, reason, created_by)
  values
    (v_me.store_id, p_product, p_pack_size, p_qty, 'purchase', p_unit_cost_cents,
     nullif(trim(concat_ws(' / ', nullif(trim(coalesce(p_supplier, '')), ''), nullif(trim(coalesce(p_note, '')), ''))), ''),
     v_me.id);

  select case when p_pack_size is null then p.stock_on_hand else ps.packets_on_hand end
    into v_on_hand
    from public.products p
    left join public.pack_sizes ps on ps.id = p_pack_size
   where p.id = p_product;

  return jsonb_build_object('product_id', p_product, 'pack_size_id', p_pack_size, 'on_hand', v_on_hand);
end $$;

/** Receiving with a batch number and expiry date, in one transaction with the stock movement. */
create or replace function public.receive_stock_batch(
  p_product         uuid,
  p_pack_size       uuid,
  p_qty             numeric,
  p_unit_cost_cents bigint,
  p_supplier        text,
  p_note            text,
  p_batch_no        text,
  p_expiry          date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_result jsonb;
  v_store uuid;
begin
  if p_expiry is not null and p_expiry < current_date then
    raise exception 'that batch has already expired - record it as a stock correction instead';
  end if;
  v_result := public.receive_stock(p_product, p_pack_size, p_qty, p_unit_cost_cents, p_supplier, p_note);
  select store_id into v_store from public.products where id = p_product;
  if nullif(trim(coalesce(p_batch_no, '')), '') is not null or p_expiry is not null then
    insert into public.product_batches
      (store_id, product_id, pack_size_id, batch_no, expiry_date, qty_received, qty_remaining, unit_cost_cents)
    values
      (v_store, p_product, p_pack_size, nullif(trim(coalesce(p_batch_no, '')), ''), p_expiry, p_qty, p_qty,
       p_unit_cost_cents);
    update public.products set has_expiry = true where id = p_product and p_expiry is not null and not has_expiry;
  end if;
  return v_result;
end $$;

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
  if not v_product.track_stock then raise exception 'this item does not keep stock'; end if;

  -- Same rule as receive_stock(): a product with options keeps its stock on them.
  if v_product.sale_mode in ('weighted', 'variant') then
    if p_pack_size is null and v_product.sale_mode = 'weighted' then
      raise exception 'choose which packet size is being corrected';
    elsif p_pack_size is null then
      raise exception 'choose which size or variant is being corrected';
    end if;
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

/**
 * Batches that still have stock and expire within p_days (already expired ones included, first).
 * Every role may read it: the person at the counter is the one who pulls an expired item.
 */
create or replace function public.expiring_batches(p_days int default 30)
returns table (
  batch_id uuid, product_id uuid, product_name text, option_label text, batch_no text,
  expiry_date date, days_left int, qty_remaining numeric
)
language sql stable security definer set search_path = public as $$
  select b.id, b.product_id, p.name, ps.label, b.batch_no, b.expiry_date,
         (b.expiry_date - current_date)::int, b.qty_remaining
    from public.product_batches b
    join public.products p on p.id = b.product_id
    left join public.pack_sizes ps on ps.id = b.pack_size_id
   where b.store_id = public.app_store_id()
     and b.qty_remaining > 0
     and b.expiry_date is not null
     and b.expiry_date <= current_date + greatest(coalesce(p_days, 30), 0)
   order by b.expiry_date, p.name
$$;

-- ── grants ───────────────────────────────────────────────────────────────────────────────────────
revoke all on function
  public.is_business_type(text),
  public.is_product_unit(text),
  public.clean_store_features(jsonb),
  public.clean_store_theme(jsonb),
  public.claim_barcode(uuid, uuid, uuid, text),
  public.skip_untracked_stock(),
  public.consume_batches(),
  public.save_shop_profile(jsonb),
  public.my_shop(),
  public.get_till_context(),
  public.save_product(jsonb),
  public.save_pack_sizes(uuid, jsonb),
  public.receive_stock(uuid, uuid, numeric, bigint, text, text),
  public.receive_stock_batch(uuid, uuid, numeric, bigint, text, text, text, date),
  public.adjust_stock(uuid, uuid, numeric, text, uuid),
  public.expiring_batches(int),
  public.submit_vendor_application(jsonb)
  from public, anon, authenticated;

grant execute on function
  public.save_shop_profile(jsonb),
  public.my_shop(),
  public.get_till_context(),
  public.save_product(jsonb),
  public.save_pack_sizes(uuid, jsonb),
  public.receive_stock(uuid, uuid, numeric, bigint, text, text),
  public.receive_stock_batch(uuid, uuid, numeric, bigint, text, text, text, date),
  public.adjust_stock(uuid, uuid, numeric, text, uuid),
  public.expiring_batches(int),
  public.submit_vendor_application(jsonb)
  to authenticated;
