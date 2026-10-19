-- Tenancy, customer identity and bottle loans.
--
-- This is the schema the onboarding / dashboard / till flows need. It changes three things:
--
--   1. A store now belongs to an owner (stores.owner_id), so a person can create one and still
--      reach it before any staff row exists. app_store_id() is replaced with a version that
--      refuses a requested store unless the caller owns it or works in it (see the comment there).
--
--   2. A customer is identified by mobile number, unique within a store. Two people in the same
--      household must use their own numbers, so there is no "shared number" case to model.
--
--   3. A returnable bottle is a LOAN, not an up-front fee. Selling milk at 250 does not charge the
--      100 deposit; it records that the customer owes one bottle. The 100 is charged only if the
--      bottle is still outstanding on a later visit. This is what lets the dashboard answer
--      "who still has our bottles".

-- -- 1. tenancy -------------------------------------------------------------------------------
alter table public.stores
  add column if not exists owner_id uuid references auth.users (id) on delete set null;

create index if not exists stores_owner_ix on public.stores (owner_id);
-- The store a person last worked in. PostgREST gives every RPC its own transaction, so a
-- session-level setting cannot carry the choice from one call to the next.
alter table public.profiles
  add column if not exists last_store_id uuid references public.stores (id) on delete set null;

-- Existing shops: the earliest owner profile is the owner of the store.
update public.stores s
   set owner_id = p.auth_user_id
  from public.profiles p
 where s.owner_id is null
   and p.store_id = s.id
   and p.role = 'owner'
   and p.auth_user_id is not null;

-- The requested store is honoured only if the caller is its owner or active staff in it, so a
-- client cannot read another shop by setting app.store_id itself.
create or replace function public.app_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  with want as (select nullif(current_setting('app.store_id', true), '')::uuid as id)
  select coalesce(
    (select st.id
       from public.stores st
      where st.id = (select id from want)
        and (st.owner_id = auth.uid()
             or exists (select 1 from public.profiles p
                         where p.auth_user_id = auth.uid()
                           and p.store_id = st.id
                           and p.is_active))),
    (select p.last_store_id
       from public.profiles p
      where p.auth_user_id = auth.uid() and p.is_active and p.last_store_id is not null
      limit 1),
    (select p.store_id
       from public.profiles p
      where p.auth_user_id = auth.uid() and p.is_active
      order by p.created_at
      limit 1),
    (select st.id
       from public.stores st
      where st.owner_id = auth.uid()
      order by st.created_at
      limit 1)
  )
$$;

-- An owner may create a store; nobody else may.
drop policy if exists stores_insert on public.stores;
create policy stores_insert on public.stores for insert to authenticated
  with check (owner_id = auth.uid());

-- Owners can read every store they own, even before a profile row exists (onboarding).
drop policy if exists stores_read on public.stores;
create policy stores_read on public.stores for select to authenticated
  using (owner_id = auth.uid() or id = public.app_store_id());

-- The stores a person can switch between, for the dashboard store picker.
create or replace function public.my_stores() returns table (id uuid, name text, role public.user_role)
language sql stable security definer set search_path = public as $$
  select st.id, st.name,
         coalesce((select p.role from public.profiles p
                    where p.auth_user_id = auth.uid() and p.store_id = st.id and p.is_active
                    limit 1),
                  'owner'::public.user_role)
    from public.stores st
   where st.owner_id = auth.uid()
      or exists (select 1 from public.profiles p
                  where p.auth_user_id = auth.uid() and p.store_id = st.id and p.is_active)
   order by st.name
$$;

grant execute on function public.my_stores() to authenticated;
/**
 * Remember which shop the dashboard is working in.
 *
 * current_setting('app.store_id') lives for one transaction, and PostgREST gives each RPC its own,
 * so the choice is also kept on the profile. app_store_id() reads the setting first and falls back
 * to this, which is why the session variable alone is not enough.
 */
create or replace function public.set_current_store(p_store uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  -- Only a shop this person owns or works in may be selected.
  if not exists (select 1 from public.stores st where st.id = p_store and st.owner_id = v_uid)
     and not exists (select 1 from public.profiles p
                      where p.auth_user_id = v_uid and p.store_id = p_store and p.is_active) then
    raise exception 'unknown store' using errcode = '42501';
  end if;
  update public.profiles set last_store_id = p_store
   where auth_user_id = v_uid and is_active;
  perform set_config('app.store_id', p_store::text, false);
  return jsonb_build_object('store_id', p_store);
end $$;
grant execute on function public.set_current_store(uuid) to authenticated;

-- -- 2. customers identified by mobile number ------------------------------------------------
-- Normalised to digits (and a leading +) so 077 123 4567 and 0771234567 are the same customer.
update public.customers
   set phone = nullif(regexp_replace(phone, '[^0-9+]', '', 'g'), '')
 where phone is not null;

alter table public.customers
  alter column phone set not null;

create unique index if not exists customers_store_phone_ux
  on public.customers (store_id, phone);

-- Search by number from the till: exact first, then a suffix match so the cashier can type the
-- last digits only ("34567" finds 0771234567).
create index if not exists customers_phone_search_ix
  on public.customers (store_id, phone text_pattern_ops);

-- Look up a customer by mobile, for the till. Returns null when there is no match.
create or replace function public.find_customer_by_phone(p_phone text)
returns jsonb
language sql stable security definer set search_path = public as $$
  with n as (select nullif(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), '') as phone)
  select to_jsonb(c)
    from public.customers c, n
   where c.store_id = public.app_store_id()
     and c.phone is not null
     and (c.phone = n.phone or (length(n.phone) >= 4 and c.phone like '%' || n.phone))
   order by (c.phone = n.phone) desc, c.name
   limit 1
$$;

grant execute on function public.find_customer_by_phone(text) to authenticated;

-- -- 3. bottle loans -------------------------------------------------------------------------
-- bottle_ledger is already append-only with the right events (sold, returned_with_purchase,
-- returned_later, fee_charged...). It only lacked the customer, which is what makes a bottle
-- traceable to a person.
alter table public.bottle_ledger
  add column if not exists customer_id uuid references public.customers (id) on delete set null;

create index if not exists bottle_ledger_customer_ix
  on public.bottle_ledger (customer_id, created_at desc);

-- A sale belongs to a customer once the cashier attaches one.
alter table public.sales
  add column if not exists customer_id uuid references public.customers (id) on delete set null;

create index if not exists sales_customer_ix on public.sales (customer_id, created_at desc);

-- Bottles a customer still has: loans minus returns minus bottles we have already charged for.
create or replace function public.customer_bottles_outstanding(p_customer uuid)
returns int
language plpgsql stable security definer set search_path = public as $$
declare v_store uuid := public.app_store_id(); v_n int;
begin
  -- Refuse rather than return 0: a silent "owes nothing" would hide a bottle debt.
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select coalesce(sum(case
           when l.event = 'sold' then l.qty
           when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged') then -l.qty
           else 0
         end), 0)::int
    into v_n
    from public.bottle_ledger l
   where l.customer_id = p_customer
     and l.store_id = v_store;
  return v_n;
end $$;

grant execute on function public.customer_bottles_outstanding(uuid) to authenticated;

-- -- 4. a cashier may add a customer at the counter ------------------------------------------
-- 0006 restricted this to owner/supervisor, which contradicts how the till is used: the cashier
-- is the person who meets the customer. Inserts are allowed; edits stay with the supervisor so a
-- number cannot be silently changed under a customer's history.
drop policy if exists customers_write on public.customers;

create policy customers_insert on public.customers for insert to authenticated
  with check (store_id = public.app_store_id());

create policy customers_update on public.customers for update to authenticated
  using (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'))
  with check (store_id = public.app_store_id() and public.app_role() in ('owner', 'supervisor'));

-- Bottle returns are registered at the till, so the cashier needs to append to the ledger.
drop policy if exists bottle_ledger_insert on public.bottle_ledger;
create policy bottle_ledger_insert on public.bottle_ledger for insert to authenticated
  with check (store_id = public.app_store_id());

grant insert on public.bottle_ledger to authenticated;
