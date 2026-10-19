-- SET UP A REAL SHOP BY HAND. Run once in the Supabase SQL editor, AFTER all migrations (0001-0011).
-- For a new shop prefer the app's own onboarding screen, which does the same thing without editing SQL.
-- Copy this file, replace every <PLACEHOLDER>, run it, then DELETE your edited copy:
-- it contains PINs in plain text. (Do not run supabase/seed.sql on a real shop.)

do $$
declare
  v_store uuid;
begin
  insert into stores (name, address, phone, vat_no)
    values ('<SHOP NAME>', '<ADDRESS>', '<PHONE>', '<VAT REGISTRATION NO, or null>')
    returning id into v_store;

  insert into categories (store_id, name, sort_order) values
    (v_store, 'Spices', 1), (v_store, 'Biscuits', 2), (v_store, 'Milk', 3), (v_store, 'Business packs', 4);

  -- People. Staff codes are what they type at the till. PINs are 4-8 digits and are stored hashed.
  insert into profiles (store_id, full_name, staff_code, role, pin_hash) values
    (v_store, '<OWNER NAME>', '1', 'owner', extensions.crypt('<OWNER PIN>', extensions.gen_salt('bf')));

  insert into profiles (store_id, full_name, staff_code, role, pin_hash, badge_hash) values
    (v_store, '<SUPERVISOR NAME>', '2', 'supervisor',
     extensions.crypt('<SUPERVISOR PIN>', extensions.gen_salt('bf')),
     extensions.crypt('<BADGE BARCODE TEXT, e.g. SUP-0002>', extensions.gen_salt('bf')));

  insert into profiles (store_id, full_name, staff_code, role, pin_hash) values
    (v_store, '<CASHIER NAME>', '3', 'cashier', extensions.crypt('<CASHIER PIN>', extensions.gen_salt('bf')));

  -- The till itself: a profile that the till's sign-in account is linked to (role cashier = least access).
  insert into profiles (store_id, full_name, staff_code, role) values (v_store, 'Till 1', '900', 'cashier');
end $$;

-- Then: Supabase dashboard -> Authentication -> Users -> Add user (e.g. till1@yourshop.lk + a strong password,
-- "Auto confirm"). Copy that user's UUID and link it to the till profile:
--
--   update profiles set auth_user_id = '<TILL AUTH USER UUID>' where staff_code = '900';
--
-- For a second till, add another profile (staff_code '901', ...) and another auth user.
-- Opening stock is entered with the stock-adjustment screen (coming with the back office) or:
--   select adjust_stock(...)  -- as the owner
