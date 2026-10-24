-- Platform administration, owner provisioning, store self-service, and suspension.
--
-- Model
--   * A platform admin is NOT a shop role. They belong to no store and hold no staff row. They are a
--     separate principal (platform_admins) so the shop roles stay exactly as they were: a shop owner
--     can never escalate into a platform admin.
--   * Platform admins are READ-ONLY over shop data. Nothing here lets them change a sale, an expense,
--     a product or a stock level. The only writes they have are:
--       - create an owner account (the problem this migration exists to solve),
--       - reset that owner's password during handover,
--       - switch a store's own bookkeeping shut (suspension).
--   * Every platform action is recorded in platform_audit. It is append-only and readable by platform
--     admins only, so the admin's own history is inspectable too.
--   * Suspension is enforced centrally in app_store_id(), so it applies to every existing RLS policy
--     and every finance RPC without listing them. A suspended store's data becomes invisible to its
--     own staff while the platform admin can still read it.
--
-- Why accounts are created here rather than by the owner signing themselves up: a public sign-up would
-- let anyone create an account, and every such account would then need manual approval before it could
-- see anything. Provisioning keeps a single handover step and puts the credential in the shop's hands
-- from the first minute.

-- ── 1. platform admins ─────────────────────────────────────────────────────────────────────────
create table if not exists public.platform_admins (
  auth_user_id uuid primary key references auth.users (id) on delete cascade,
  full_name    text not null,
  note         text,
  created_at   timestamptz not null default now(),
  is_active    boolean not null default true
);

alter table public.platform_admins enable row level security;
revoke all on public.platform_admins from anon, authenticated;

/**
 * Is the caller a platform admin?
 *
 * security definer so it can read platform_admins (which clients cannot), and stable so it can be
 * used inside policies and other functions. Never call this from a policy on platform_admins itself,
 * or the policy would recurse.
 */
create or replace function public.is_platform_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.platform_admins pa
     where pa.auth_user_id = auth.uid() and pa.is_active
  )
$$;
grant execute on function public.is_platform_admin() to authenticated;

-- ── 2. store lifecycle + first-login password change ──────────────────────────────────────────
alter table public.stores
  add column if not exists is_active boolean not null default true,
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

-- Set when a password was generated for the owner rather than chosen by them, so the app can ask
-- them to replace it before they carry on. Cleared by complete_password_change().
alter table public.profiles
  add column if not exists must_change_password boolean not null default false;

create index if not exists stores_active_ix on public.stores (is_active) where not is_active;

/**
 * Suspension gate.
 *
 * Every shop-scoped policy funnels through app_store_id(), so returning null for a suspended store
 * closes the shop to its own staff in one place: RLS policies compare against it, and every RPC that
 * calls assert_store_access()/app_store_id() follows. Platform admins are unaffected because they do
 * not use this function - they read through the platform_* RPCs.
 */
create or replace function public.app_store_id() returns uuid
language sql stable security definer set search_path = public as $$
  with want as (select nullif(current_setting('app.store_id', true), '')::uuid as id),
  allowed as (
    select st.id, st.created_at, p.last_store_id
      from public.stores st
      left join public.profiles p
        on p.auth_user_id = auth.uid() and p.store_id = st.id and p.is_active
     where st.is_active
       and (st.owner_id = auth.uid() or p.id is not null)
  )
  select id
    from allowed
   -- Preference order: the shop explicitly selected this session, then the one they used last,
   -- then the oldest. A suspended shop is absent from `allowed`, so a shut shop is skipped and the
   -- person falls through to a shop that is still open instead of losing access entirely.
   order by (id = (select id from want)) desc,
            (id = last_store_id) desc,
            created_at
   limit 1
$$;

-- ── 3. platform audit trail ───────────────────────────────────────────────────────────────────
create table if not exists public.platform_audit (
  id           uuid primary key default gen_random_uuid(),
  actor        uuid references auth.users (id) on delete set null,
  action       text not null,
  store_id     uuid references public.stores (id) on delete set null,
  target_user  uuid references auth.users (id) on delete set null,
  detail       jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists platform_audit_created_idx on public.platform_audit (created_at desc);
create index if not exists platform_audit_store_idx on public.platform_audit (store_id, created_at desc);

alter table public.platform_audit enable row level security;
revoke all on public.platform_audit from anon, authenticated;

-- ── 4. read-only views over the shops ────────────────────────────────────────────────────────
/**
 * Every shop, with the numbers an administrator needs to judge a request: how old it is, how much
 * activity it has, and whether it is live. Read-only.
 *
 * "Activity" deliberately counts only things that cannot be forged by a client insert: sales,
 * products and staff rows. It is a signal for triage, not an accounting figure.
 */
create or replace function public.platform_stores()
returns table (
  id uuid, name text, owner_id uuid, owner_email text, owner_name text,
  address text, phone text, vat_no text, currency text,
  is_active boolean, suspended_reason text, suspended_at timestamptz,
  created_at timestamptz,
  staff_count bigint, product_count bigint, sale_count bigint,
  sales_cents bigint, last_sale_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;

  return query
  select st.id, st.name, st.owner_id, u.email::text,
         (select p.full_name from public.profiles p
           where p.store_id = st.id and p.role = 'owner' order by p.created_at limit 1),
         st.address, st.phone, st.vat_no, st.currency,
         st.is_active, st.suspended_reason, st.suspended_at, st.created_at,
         (select count(*) from public.profiles p where p.store_id = st.id),
         (select count(*) from public.products pr where pr.store_id = st.id),
         (select count(*) from public.sales s where s.store_id = st.id),
         (select coalesce(sum(s.total_cents), 0)::bigint from public.sales s where s.store_id = st.id),
         (select max(s.created_at) from public.sales s where s.store_id = st.id)
    from public.stores st
    left join auth.users u on u.id = st.owner_id
   order by st.created_at desc;
end $$;
revoke all on function public.platform_stores() from public, anon;
grant execute on function public.platform_stores() to authenticated;

/** One shop's story: staff, recent sales, and every platform action ever taken on it. */
create or replace function public.platform_store_detail(p_store uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'store not found';
  end if;

  select jsonb_build_object(
    'store', (select to_jsonb(st) from public.stores st where st.id = p_store),
    'staff', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'role', p.role,
        'staff_code', p.staff_code, 'is_active', p.is_active, 'created_at', p.created_at
      ) order by p.created_at)
        from public.profiles p where p.store_id = p_store), '[]'::jsonb),
    'recent_sales', coalesce((
      select jsonb_agg(x order by x.created_at desc)
        from (select s.id, s.receipt_no, s.total_cents, s.status, s.created_at
                from public.sales s where s.store_id = p_store
               order by s.created_at desc limit 50) x), '[]'::jsonb),
    'monthly_sales', coalesce((
      select jsonb_agg(jsonb_build_object('month', m.month, 'sales', m.sales, 'total_cents', m.total_cents)
                       order by m.month)
        from (select to_char(date_trunc('month', s.created_at), 'YYYY-MM') as month,
                     count(*) as sales,
                     coalesce(sum(s.total_cents), 0) as total_cents
                from public.sales s where s.store_id = p_store
               group by 1 order by 1 desc limit 12) m), '[]'::jsonb),
    'platform_actions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'action', a.action, 'detail', a.detail, 'created_at', a.created_at
      ) order by a.created_at desc)
        from public.platform_audit a where a.store_id = p_store), '[]'::jsonb)
  ) into v_out;

  return v_out;
end $$;
revoke all on function public.platform_store_detail(uuid) from public, anon;
grant execute on function public.platform_store_detail(uuid) to authenticated;

-- ── 5. provisioning: the reason this migration exists ───────────────────────────────────────
/**
 * Create an owner account, its shop, and its owner profile in one transaction.
 *
 * The caller supplies the email and a password THEY generated; the password is never stored anywhere
 * readable. Two flags are set so the handover is safe:
 *   - must_change_password, so the owner replaces the handed-over password on first sign-in;
 *   - the shop starts empty (no products, no staff beyond the owner), exactly like onboarding.
 *
 * If any step fails nothing is created: a half-made shop with a login that cannot be re-issued is
 * worse than an error message. The auth user is created first because it is the part that cannot be
 * rolled back by us later if the shop insert were to fail.
 */
create or replace function public.platform_create_owner(
  p_email       text,
  p_password    text,
  p_shop_name   text,
  p_full_name   text default null,
  p_address     text default null,
  p_phone       text default null,
  p_vat_no      text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid    uuid := auth.uid();
  v_email  text := lower(trim(coalesce(p_email, '')));
  v_shop   text := trim(coalesce(p_shop_name, ''));
  v_name   text := coalesce(nullif(trim(coalesce(p_full_name, '')), ''), trim(coalesce(p_shop_name, '')) || ' owner');
  v_user   uuid;
  v_store  uuid;
  v_profile uuid;
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  if v_email = '' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'enter a valid email address';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'the generated password must be at least 8 characters';
  end if;
  if v_shop = '' then
    raise exception 'shop name is required';
  end if;

  if exists (select 1 from auth.users u where lower(u.email) = v_email) then
    raise exception 'an account with that email already exists';
  end if;

  -- Supabase keeps identities in auth.users and the credential in auth.identities. Both are written
  -- here so GoTrue accepts a normal email/password sign-in afterwards.
  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    v_email, crypt(p_password, gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', v_name),
    '', '', '', ''
  ) returning id into v_user;

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), v_user, v_user::text, 'email',
    jsonb_build_object('sub', v_user::text, 'email', v_email, 'email_verified', true),
    now(), now(), now()
  );

  insert into public.stores (owner_id, name, address, phone, vat_no)
  values (v_user, v_shop,
          nullif(trim(coalesce(p_address, '')), ''),
          nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_vat_no, '')), ''))
  returning id into v_store;

  insert into public.profiles (auth_user_id, store_id, full_name, staff_code, role, must_change_password)
  values (v_user, v_store, v_name, '1', 'owner', true)
  returning id into v_profile;

  insert into public.platform_audit (actor, action, store_id, target_user, detail)
  values (v_uid, 'owner_created', v_store, v_user,
          jsonb_build_object('email', v_email, 'shop', v_shop, 'full_name', v_name));

  return jsonb_build_object('store_id', v_store, 'user_id', v_user, 'email', v_email,
                            'profile_id', v_profile, 'must_change_password', true);
end $$;
revoke all on function public.platform_create_owner(text, text, text, text, text, text, text)
  from public, anon;
grant execute on function public.platform_create_owner(text, text, text, text, text, text, text)
  to authenticated;

/**
 * Reset an owner's password during handover ("they lost the slip", "the email bounced").
 *
 * Deliberately mirrors account creation: the admin sets a fresh generated password and the owner is
 * asked to change it again on their next sign-in.
 */
create or replace function public.platform_set_password(
  p_user uuid,
  p_password text,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  if length(coalesce(p_password, '')) < 8 then
    raise exception 'the generated password must be at least 8 characters';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'account not found';
  end if;

  update auth.users
     set encrypted_password = crypt(p_password, gen_salt('bf')),
         updated_at = now()
   where id = p_user;

  update public.profiles
     set must_change_password = true
   where auth_user_id = p_user;

  insert into public.platform_audit (actor, action, target_user, store_id, detail)
  values (v_uid, 'password_reset', p_user,
          (select store_id from public.profiles where auth_user_id = p_user limit 1),
          jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('user_id', p_user, 'must_change_password', true);
end $$;
revoke all on function public.platform_set_password(uuid, text, text) from public, anon;
grant execute on function public.platform_set_password(uuid, text, text) to authenticated;

/**
 * Suspend or restore a shop. Suspension closes the shop's own access; it never deletes anything.
 *
 * The owner is not contacted by the system - an administrator does that. What this guarantees is that
 * while suspended, no sale, expense or stock movement can be written against the store, because every
 * shop-scoped policy and RPC resolves through app_store_id(), which returns null for a shut store.
 */
create or replace function public.platform_set_store_active(
  p_store  uuid,
  p_active boolean,
  p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  if not exists (select 1 from public.stores where id = p_store) then
    raise exception 'store not found';
  end if;
  if not p_active and nullif(trim(coalesce(p_reason, '')), '') is null then
    raise exception 'a reason is required to suspend a shop';
  end if;

  update public.stores
     set is_active = p_active,
         suspended_at = case when p_active then null else now() end,
         suspended_reason = case when p_active then null else trim(p_reason) end
   where id = p_store;

  insert into public.platform_audit (actor, action, store_id, detail)
  values (v_uid, case when p_active then 'store_restored' else 'store_suspended' end, p_store,
          jsonb_build_object('reason', nullif(trim(coalesce(p_reason, '')), '')));

  return jsonb_build_object('store_id', p_store, 'is_active', p_active);
end $$;
revoke all on function public.platform_set_store_active(uuid, boolean, text) from public, anon;
grant execute on function public.platform_set_store_active(uuid, boolean, text) to authenticated;

-- ── 6. the owner's own shop details (the gap this release also closes) ──────────────────────
/**
 * Edit the shop's own details. Owner only.
 *
 * Uses an explicit function rather than the stores_update policy because a column list is easier to
 * reason about: an owner may change their own contact details and trading defaults, never their
 * billing state (is_active), never their owner_id, and never anything a report depends on silently.
 * Each edit is written to audit_logs with a before/after, so a VAT number changing is visible later.
 */
create or replace function public.update_store_details(
  p_name            text,
  p_address         text default null,
  p_phone           text default null,
  p_vat_no          text default null,
  p_currency        text default 'LKR',
  p_bottle_fee_cents bigint default 10000,
  p_max_cashier_discount_pct numeric default 5,
  p_prices_include_tax boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_store uuid := public.app_store_id();
  v_before jsonb;
  v_after  jsonb;
  v_name  text := trim(coalesce(p_name, ''));
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  if v_store is null then
    raise exception 'no shop selected' using errcode = '42501';
  end if;
  if public.app_role() <> 'owner' then
    raise exception 'only the shop owner can change the shop details' using errcode = '42501';
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

  select to_jsonb(st) into v_before from public.stores st where st.id = v_store;

  update public.stores
     set name = v_name,
         address = nullif(trim(coalesce(p_address, '')), ''),
         phone = nullif(trim(coalesce(p_phone, '')), ''),
         vat_no = nullif(trim(coalesce(p_vat_no, '')), ''),
         currency = coalesce(nullif(trim(p_currency), ''), 'LKR'),
         bottle_fee_cents = coalesce(p_bottle_fee_cents, 10000),
         max_cashier_discount_pct = coalesce(p_max_cashier_discount_pct, 5),
         prices_include_tax = coalesce(p_prices_include_tax, true)
   where id = v_store;

  select to_jsonb(st) into v_after from public.stores st where st.id = v_store;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
  values (v_store, 'store_updated', 'store', v_store, public.app_profile_id(), v_before, v_after);

  return v_after;
end $$;
revoke all on function public.update_store_details(text, text, text, text, text, bigint, numeric, boolean)
  from public, anon;
grant execute on function public.update_store_details(text, text, text, text, text, bigint, numeric, boolean)
  to authenticated;

/** Clears the first-login flag once the owner has chosen a password of their own. */
create or replace function public.complete_password_change() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  update public.profiles set must_change_password = false
   where auth_user_id = v_uid;
  return jsonb_build_object('must_change_password', false);
end $$;
revoke all on function public.complete_password_change() from public, anon;
grant execute on function public.complete_password_change() to authenticated;

-- ── 7. my_shop() learns about admins, suspension and the password flag ──────────────────────
/**
 * The routing answer for the whole app. Adds three things to the original:
 *   - is_admin / is_platform_admin, so an administrator with no shop lands on /platform;
 *   - suspended, so the dashboard can explain why a shop is shut instead of looking empty;
 *   - must_change_password, so a handed-over password is replaced before work starts.
 *
 * A suspended store still returns onboarded=true with suspended=true: "onboarded but shut" is very
 * different from "never set up", and the two must not show the same screen.
 */
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
      'is_active', v_store.is_active),
    'role', coalesce(v_role, 'owner'::public.user_role)
  );
end $$;

revoke all on function public.my_shop() from public, anon;
grant execute on function public.my_shop() to authenticated;
