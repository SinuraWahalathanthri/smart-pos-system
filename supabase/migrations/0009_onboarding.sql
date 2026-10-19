-- Onboarding: a new owner creates their shop and becomes its owner in one step.
--
-- No sample data. The shop starts empty: no products, no categories, no customers. Everything the
-- owner sees afterwards they entered themselves, so this is safe to use for a real business.
--
-- One call, one transaction. If any part fails nothing is created, so an abandoned onboarding
-- cannot leave a half-made shop behind.

create or replace function public.create_store(
  p_name                    text,
  p_address                 text default null,
  p_phone                   text default null,
  p_vat_no                  text default null,
  p_currency                text default 'LKR',
  p_prices_include_tax      boolean default true,
  p_bottle_fee_cents        bigint default 10000,
  p_max_cashier_discount_pct numeric default 5
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_store uuid;
  v_profile uuid;
  v_name text := trim(coalesce(p_name, ''));
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_name = '' then
    raise exception 'shop name is required';
  end if;
  if coalesce(p_bottle_fee_cents, 0) < 0 then
    raise exception 'bottle fee cannot be negative';
  end if;
  if coalesce(p_max_cashier_discount_pct, 0) < 0 or p_max_cashier_discount_pct > 100 then
    raise exception 'discount percentage must be between 0 and 100';
  end if;

  -- The owner already has a shop: resuming onboarding should not make a duplicate.
  if exists (select 1 from public.stores where owner_id = v_uid) then
    select id into v_store from public.stores where owner_id = v_uid order by created_at limit 1;
    return jsonb_build_object(
      'id', v_store,
      'name', (select name from public.stores where id = v_store),
      'created', false
    );
  end if;

  insert into public.stores (owner_id, name, address, phone, vat_no, currency,
                             prices_include_tax, bottle_fee_cents, max_cashier_discount_pct)
  values (v_uid, v_name, nullif(trim(coalesce(p_address, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_vat_no, '')), ''), coalesce(nullif(trim(p_currency), ''), 'LKR'),
          coalesce(p_prices_include_tax, true), coalesce(p_bottle_fee_cents, 10000),
          coalesce(p_max_cashier_discount_pct, 5))
  returning id into v_store;

  -- The owner is staff too: this row is what app_role() and app_store_id() read.
  -- staff_code '1' is the convention the till already uses for the owner.
  insert into public.profiles (auth_user_id, store_id, full_name, staff_code, role)
  values (v_uid, v_store, v_name || ' owner', '1', 'owner')
  returning id into v_profile;

  return jsonb_build_object('id', v_store, 'name', v_name, 'profile_id', v_profile, 'created', true);
end $$;

/**
 * Has this account finished onboarding? The app calls this at boot to decide between
 * /onboarding, /dashboard and /pos. Returns the shop id when there is one.
 */
create or replace function public.my_shop() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_store public.stores;
  v_role public.user_role;
begin
  if v_uid is null then
    return jsonb_build_object('onboarded', false);
  end if;

  select st.* into v_store
    from public.stores st
   where st.owner_id = v_uid
      or exists (select 1 from public.profiles p
                  where p.auth_user_id = v_uid and p.store_id = st.id and p.is_active)
   order by st.created_at
   limit 1;

  if not found then
    return jsonb_build_object('onboarded', false);
  end if;

  select p.role into v_role
    from public.profiles p
   where p.auth_user_id = v_uid and p.store_id = v_store.id and p.is_active
   limit 1;

  return jsonb_build_object(
    'onboarded', true,
    'store', jsonb_build_object(
      'id', v_store.id, 'name', v_store.name, 'address', v_store.address,
      'phone', v_store.phone, 'vat_no', v_store.vat_no, 'currency', v_store.currency,
      'bottle_fee_cents', v_store.bottle_fee_cents,
      'max_cashier_discount_pct', v_store.max_cashier_discount_pct,
      'prices_include_tax', v_store.prices_include_tax),
    -- Falls back to owner for someone who created the shop but has no staff row yet.
    'role', coalesce(v_role, 'owner'::public.user_role)
  );
end $$;

revoke all on function public.create_store(text, text, text, text, text, boolean, bigint, numeric)
  from public, anon, authenticated;
grant execute on function public.create_store(text, text, text, text, text, boolean, bigint, numeric)
  to authenticated;

revoke all on function public.my_shop() from public, anon, authenticated;
grant execute on function public.my_shop() to authenticated;
