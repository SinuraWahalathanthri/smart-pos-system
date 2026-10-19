-- DEVELOPMENT SEED ONLY. Demo shop, catalogue and staff so the system can be tried end to end.
-- Never run this against a live shop: the PINs below are public.
--   Owner       code 1  PIN 9999
--   Supervisor  code 2  PIN 2222  badge text SUP-0002   (Kamal)
--   Cashier     code 3  PIN 3333                        (Nimal)
-- Owner / till sign-in via Supabase Auth is created separately (Dashboard -> Authentication), then
-- linked with:  update profiles set auth_user_id = '<auth user id>' where staff_code = '1';

-- Temporary helpers (live only for this session).
create function pg_temp.seed_spice(
  p_store uuid, p_cat uuid, p_name text, p_color text, p_prices int[], p_stock int[], p_barcodes jsonb, p_by uuid
) returns void language plpgsql as $$
declare
  v_prod uuid; v_pack uuid; i int;
  v_weights int[] := array[50, 100, 250, 500, 1000];
  v_labels text[] := array['50 g', '100 g', '250 g', '500 g', '1 kg'];
begin
  insert into products (store_id, name, category_id, kind, sale_mode, tax_rate_pct, is_favourite, color, has_expiry, shelf_life_days)
    values (p_store, p_name, p_cat, 'finished', 'weighted', 0, true, p_color, true, 365)
    returning id into v_prod;
  for i in 1..5 loop
    insert into pack_sizes (store_id, product_id, label, weight_g, price_cents, sort_order)
      values (p_store, v_prod, v_labels[i], v_weights[i], p_prices[i] * 100, i)
      returning id into v_pack;
    if p_barcodes ? v_weights[i]::text then
      insert into product_barcodes (store_id, product_id, pack_size_id, barcode)
        values (p_store, v_prod, v_pack, p_barcodes ->> v_weights[i]::text);
    end if;
    if p_stock[i] > 0 then
      insert into stock_movements (store_id, product_id, pack_size_id, qty_change, type, reason, created_by)
        values (p_store, v_prod, v_pack, p_stock[i], 'opening', 'Opening stock (seed)', p_by);
    end if;
  end loop;
end $$;

create function pg_temp.seed_unit(
  p_store uuid, p_cat uuid, p_name text, p_price_cents bigint, p_tax numeric, p_stock numeric, p_reorder numeric,
  p_barcode text, p_fav boolean, p_bottle boolean, p_by uuid
) returns void language plpgsql as $$
declare v_prod uuid;
begin
  insert into products (store_id, name, category_id, kind, sale_mode, price_cents, tax_rate_pct, reorder_level,
                        is_favourite, is_returnable_bottle, color)
    values (p_store, p_name, p_cat, 'trade', 'unit', p_price_cents, p_tax, p_reorder, p_fav, p_bottle, '#78716c')
    returning id into v_prod;
  insert into product_barcodes (store_id, product_id, barcode) values (p_store, v_prod, p_barcode);
  insert into stock_movements (store_id, product_id, qty_change, type, reason, created_by)
    values (p_store, v_prod, p_stock, 'opening', 'Opening stock (seed)', p_by);
end $$;

do $$
declare
  v_store uuid; v_owner uuid;
  v_spices uuid; v_biscuits uuid; v_milk uuid; v_business uuid;
begin
  insert into stores (name, address) values ('My Spice Shop', 'Sri Lanka') returning id into v_store;

  insert into categories (store_id, name, sort_order) values (v_store, 'Spices', 1) returning id into v_spices;
  insert into categories (store_id, name, sort_order) values (v_store, 'Biscuits', 2) returning id into v_biscuits;
  insert into categories (store_id, name, sort_order) values (v_store, 'Milk', 3) returning id into v_milk;
  insert into categories (store_id, name, sort_order) values (v_store, 'Business packs', 4) returning id into v_business;

  -- staff (credentials hashed with bcrypt via pgcrypto)
  insert into profiles (store_id, full_name, staff_code, role, pin_hash)
    values (v_store, 'Shop Owner', '1', 'owner', extensions.crypt('9999', extensions.gen_salt('bf')))
    returning id into v_owner;
  insert into profiles (store_id, full_name, staff_code, role, pin_hash, badge_hash)
    values (v_store, 'Kamal (Supervisor)', '2', 'supervisor', extensions.crypt('2222', extensions.gen_salt('bf')),
            extensions.crypt('SUP-0002', extensions.gen_salt('bf')));
  insert into profiles (store_id, full_name, staff_code, role, pin_hash)
    values (v_store, 'Nimal (Cashier)', '3', 'cashier', extensions.crypt('3333', extensions.gen_salt('bf')));

  -- spices: weighted, sold as branded packets of fixed sizes (barcodes on SOME sizes, to exercise both routes)
  perform pg_temp.seed_spice(v_store, v_spices, 'Curry Powder',    '#b45309', array[95,180,430,840,1650],   array[24,12,3,30,8],
                             '{"250":"4790000000013","1000":"4790000000020"}'::jsonb, v_owner);
  perform pg_temp.seed_spice(v_store, v_spices, 'Chilli Powder',   '#b91c1c', array[110,210,500,980,1900],  array[18,20,14,9,6],
                             '{"250":"4790000000037"}'::jsonb, v_owner);
  perform pg_temp.seed_spice(v_store, v_spices, 'Turmeric Powder', '#ca8a04', array[120,230,550,1080,2100], array[10,10,10,5,4],
                             '{}'::jsonb, v_owner);
  perform pg_temp.seed_spice(v_store, v_spices, 'Pepper Powder',   '#44403c', array[160,310,760,1480,2900], array[8,8,6,4,0],
                             '{}'::jsonb, v_owner);

  -- grocery (prices in cents; VAT 18% on biscuits)
  perform pg_temp.seed_unit(v_store, v_biscuits, 'Marie Biscuit',            12000, 18, 60, 10, '4790000000044', true,  false, v_owner);
  perform pg_temp.seed_unit(v_store, v_biscuits, 'Chocolate Cream Biscuit',  15000, 18, 40, 10, '4790000000051', true,  false, v_owner);
  perform pg_temp.seed_unit(v_store, v_biscuits, 'Cream Cracker',            13500, 18,  6, 10, '4790000000068', false, false, v_owner);
  perform pg_temp.seed_unit(v_store, v_milk,     'Fresh Milk (glass bottle)',25000,  0, 36, 10, '4790000000075', true,  true,  v_owner);
  perform pg_temp.seed_unit(v_store, v_milk,     'Milk Packet 1 L',          29000,  0, 40, 10, '4790000000082', true,  false, v_owner);
  perform pg_temp.seed_unit(v_store, v_milk,     'Milk Powder 400 g',        98000,  0, 40, 10, '4790000000099', false, false, v_owner);
  perform pg_temp.seed_unit(v_store, v_business, 'Chilli Powder Business Pack 5 kg', 920000, 0, 5, 2, '4790000000105', false, false, v_owner);
  perform pg_temp.seed_unit(v_store, v_business, 'Curry Powder Business Pack 5 kg',  810000, 0, 4, 2, '4790000000112', false, false, v_owner);
end $$;
