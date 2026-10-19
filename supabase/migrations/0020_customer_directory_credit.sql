-- -- 7. the customer list grows the tab columns -----------------------------------------------
-- Appended to the existing column list rather than replacing it: the Customers screen reads this by
-- name, and a table-returning function cannot be widened in place.
drop function if exists public.customer_directory();
create or replace function public.customer_directory()
returns table (
  id uuid,
  name text,
  phone text,
  email text,
  points bigint,
  spend_cents bigint,
  visits bigint,
  credit_balance_cents bigint,
  credit_limit_cents bigint
)
language sql stable security definer set search_path = public as $$
  select c.id,
         c.name,
         c.phone,
         c.email,
         coalesce((select sum(cp.points) from public.customer_points cp where cp.customer_id = c.id), 0),
         coalesce((select sum(s.total_cents) from public.sales s where s.customer_id = c.id), 0),
         (select count(*) from public.sales s where s.customer_id = c.id),
         public.customer_credit_balance(c.id),
         c.credit_limit_cents
    from public.customers c
   where c.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
   order by c.name
$$;
revoke all on function public.customer_directory() from public, anon, authenticated;
grant execute on function public.customer_directory() to authenticated;
