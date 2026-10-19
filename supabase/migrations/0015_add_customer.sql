-- Adding a customer at the counter.
--
-- The till inserted name/phone/email straight into public.customers. store_id is NOT NULL with no
-- default, and the insert policy checks it against app_store_id(), so the row arrived with
-- store_id = null and Postgres rejected it as "new row violates row-level security policy" -
-- an error that says nothing about the actual mistake.
--
-- The store is resolved here instead of in the browser, for the same reason record_sale does it:
-- the client should never be the authority on which shop a row belongs to. That also means a
-- caller cannot aim an insert at another shop, because there is no store argument to aim.
create or replace function public.add_customer(
  p_name  text,
  p_phone text,
  p_email text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
  v_name text := trim(coalesce(p_name, ''));
  v_phone text := trim(coalesce(p_phone, ''));
  v_row public.customers;
begin
  if v_store is null then raise exception 'not signed in to a shop'; end if;
  if public.app_role() is null then raise exception 'not signed in to a shop'; end if;
  if v_name = '' then raise exception 'customer name is required'; end if;
  if v_phone = '' then raise exception 'mobile number is required'; end if;

  -- Mirrors customers_store_phone_ux, but phrased for the counter.
  if exists (select 1 from public.customers where store_id = v_store and phone = v_phone) then
    raise exception 'that number already belongs to another customer' using errcode = '23505';
  end if;

  insert into public.customers (store_id, name, phone, email)
  values (v_store, v_name, v_phone, nullif(trim(coalesce(p_email, '')), ''))
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id,
    'name', v_row.name,
    'phone', v_row.phone,
    'email', v_row.email
  );
end $$;

revoke all on function public.add_customer(text, text, text) from public, anon, authenticated;
grant execute on function public.add_customer(text, text, text) to authenticated;
