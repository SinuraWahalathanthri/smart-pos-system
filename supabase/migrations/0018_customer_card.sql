-- What the till needs to know about a customer the moment their number is typed.
--
-- The counter now starts every bill by asking for a mobile number, so this is the hot path: one
-- round trip that answers "who is this, what are they worth, and do they still owe us bottles".
-- find_customer_by_phone() stays as it was for the mid-bill attach; this adds the numbers the gate
-- shows and is deliberately readable by a cashier, because they are the one asking.
create or replace function public.customer_card(p_phone text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with n as (select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as phone),
  hit as (
    select c.*
      from public.customers c, n
     where c.store_id = public.app_store_id()
       and c.phone is not null
       and (c.phone = n.phone or (length(n.phone) >= 4 and c.phone like '%' || n.phone))
     -- an exact match always wins over a partial one, so typing the full number is deterministic
     order by (c.phone = n.phone) desc, c.name
     limit 1
  )
  select case when not exists (select 1 from hit) then null else
    (select jsonb_build_object(
       'id', h.id,
       'name', h.name,
       'phone', h.phone,
       'email', h.email,
       'points', coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = h.id), 0),
       'spend_cents', coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = h.id), 0),
       'visits', (select count(*) from public.sales s where s.customer_id = h.id),
       'bottles_out', public.customer_bottles_outstanding(h.id)
     ) from hit h)
  end
$$;

revoke all on function public.customer_card(text) from public, anon, authenticated;
grant execute on function public.customer_card(text) to authenticated;
