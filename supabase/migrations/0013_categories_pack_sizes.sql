-- Owner-side catalogue: create categories, and give a weighted product its packet sizes.
--
-- Two gaps this closes:
--   1. There was no way to make a category. save_product accepted category_id, but the catalogue
--      screen had nothing to populate it with, so every product landed in "Other".
--   2. save_product stored sale_mode = 'weighted' but never created a pack_sizes row. A weighted
--      spice therefore reached the till with an empty size list and could not be sold at all -
--      the till's weight picker had nothing to offer.

create or replace function public.save_category(p_name text, p_sort_order int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_name text := trim(coalesce(p_name, ''));
  v_id uuid;
begin
  v_me := public.assert_can_manage_products();
  if v_name = '' then raise exception 'category name is required'; end if;

  insert into public.categories (store_id, name, sort_order)
  values (v_me.store_id, v_name, coalesce(p_sort_order, 0))
  on conflict (store_id, name) do update set sort_order = excluded.sort_order
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

revoke all on function public.save_category(text, int) from public, anon, authenticated;
grant execute on function public.save_category(text, int) to authenticated;

-- Packets for a weighted product.
--
-- Quantities arrive as JSON so the whole set can be replaced in one call, which keeps the screen
-- simple: it sends what is on the form, not a diff. Stock is deliberately NOT settable here -
-- packets_on_hand is maintained by stock_movements (see guard_stock_columns), so a new size starts
-- at zero and is filled by a receiving movement. Editing a price must not silently wipe the count,
-- hence the upsert-by-id path.
create or replace function public.save_pack_sizes(p_product uuid, p_sizes jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_row jsonb;
  v_id uuid;
  v_keep uuid[] := '{}';
begin
  v_me := public.assert_can_manage_products();
  if not exists (select 1 from public.products where id = p_product and store_id = v_me.store_id) then
    raise exception 'unknown product';
  end if;

  for v_row in select * from jsonb_array_elements(coalesce(p_sizes, '[]'::jsonb)) loop
    v_id := nullif(v_row ->> 'id', '')::uuid;
    if coalesce((v_row ->> 'weight_g')::int, 0) <= 0 then
      raise exception 'packet weight must be greater than zero';
    end if;
    if coalesce((v_row ->> 'price_cents')::bigint, -1) < 0 then
      raise exception 'packet price cannot be negative';
    end if;

    if v_id is null then
      insert into public.pack_sizes (store_id, product_id, label, weight_g, price_cents, sort_order, is_active)
      values (
        v_me.store_id, p_product,
        coalesce(nullif(trim(v_row ->> 'label'), ''), (v_row ->> 'weight_g') || ' g'),
        (v_row ->> 'weight_g')::int,
        (v_row ->> 'price_cents')::bigint,
        coalesce((v_row ->> 'sort_order')::int, 0),
        coalesce((v_row ->> 'is_active')::boolean, true)
      ) returning id into v_id;
    else
      update public.pack_sizes set
        label = coalesce(nullif(trim(v_row ->> 'label'), ''), label),
        weight_g = (v_row ->> 'weight_g')::int,
        price_cents = (v_row ->> 'price_cents')::bigint,
        sort_order = coalesce((v_row ->> 'sort_order')::int, sort_order),
        is_active = coalesce((v_row ->> 'is_active')::boolean, is_active)
      where id = v_id and product_id = p_product and store_id = v_me.store_id;
      if not found then raise exception 'unknown pack size'; end if;
    end if;
    v_keep := v_keep || v_id;
  end loop;

  -- Sizes no longer on the form are retired rather than deleted: past sales and the stock ledger
  -- still point at them, and pack_sizes is referenced by product_barcodes.
  update public.pack_sizes set is_active = false
   where product_id = p_product and store_id = v_me.store_id
     and not (id = any (v_keep));

  return jsonb_build_object('product_id', p_product, 'sizes', coalesce(array_length(v_keep, 1), 0));
end $$;

revoke all on function public.save_pack_sizes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.save_pack_sizes(uuid, jsonb) to authenticated;
