-- The staff list the dashboard is allowed to see.
--
-- Why this exists: StaffScreen asked for `badge_hash` directly from profiles, but 0002 deliberately
-- grants clients no access to the credential columns. Postgres answers a select naming an ungranted
-- column with "permission denied for table profiles" and returns no rows at all, so the screen broke
-- completely - and, because the add-staff path reloads through the same query, a staff member who
-- HAD been created successfully never appeared.
--
-- The client only ever needs to know WHETHER a badge or PIN is set, never the hash. This returns that
-- boolean and keeps the hashes server-side. It is a security definer function rather than a view:
-- a view would either bypass row level security for everyone, or force us to grant the hash columns
-- to authenticated so the caller could evaluate them.

create or replace function public.staff_directory()
returns table (
  id uuid,
  full_name text,
  staff_code text,
  role public.user_role,
  is_active boolean,
  has_badge boolean,
  has_pin boolean,
  created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select p.id,
         p.full_name,
         p.staff_code,
         p.role,
         p.is_active,
         p.badge_hash is not null,
         p.pin_hash is not null,
         p.created_at
    from public.profiles p
   where p.store_id = public.app_store_id()
   order by p.created_at
$$;

revoke all on function public.staff_directory() from public, anon, authenticated;
grant execute on function public.staff_directory() to authenticated;
