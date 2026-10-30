-- Vendor registration: a business signs itself up from the website, a platform admin approves it.
--
-- Until now the only way a business got an account was platform_create_owner() (0025): the admin
-- made the owner by hand. That still works and is unchanged. This adds the self-service path:
--
--   1. The owner creates their own account with Supabase Auth signUp(). Supabase sends the email
--      verification link. No RPC here is callable by anon - the account exists before any of them run.
--   2. Once the email is verified they submit an application (submit_vendor_application).
--   3. A platform admin approves, rejects or asks for more information
--      (platform_review_vendor_application). An optional setting approves straight away instead.
--   4. Approved, the owner opens their shop through create_store(), prefilled from the application.
--
-- create_store() is redefined here because it used to open a shop for ANY signed-in account. With a
-- public sign-up page that would let anyone skip the review, so a new shop now needs an approved
-- application. Accounts that already have a shop are unaffected: create_store() still returns it.
--
-- Registering never makes anyone a platform admin; supabase/setup-platform-admin.sql stays the only
-- way. Applications are read and written only through the functions below: the table has RLS on and
-- no client grants, because it holds personal and business details.

-- ── 1. what the shop is, recorded at registration ────────────────────────────────────────────────
alter table public.stores
  add column if not exists business_type text,
  add column if not exists country text;

-- ── 2. applications ──────────────────────────────────────────────────────────────────────────────
create table if not exists public.vendor_applications (
  id                   uuid primary key default gen_random_uuid(),
  auth_user_id         uuid not null references auth.users (id) on delete cascade,
  status               text not null default 'submitted'
                         check (status in ('submitted', 'info_requested', 'approved', 'rejected', 'withdrawn')),
  owner_name           text not null,
  owner_phone          text,
  legal_name           text not null,
  trading_name         text,
  business_type        text not null
                         check (business_type in ('retail', 'grocery', 'restaurant', 'pharmacy', 'services',
                                                  'wholesale', 'manufacturing', 'other')),
  country              text not null,
  currency             text not null default 'LKR',
  address              text,
  phone                text,
  tax_number           text,
  registration_number  text,
  locations_count      int not null default 1 check (locations_count between 1 and 1000),
  tills_count          int not null default 1 check (tills_count between 1 and 1000),
  plan_code            text not null default 'trial',
  terms_version        text not null,
  terms_accepted_at    timestamptz not null,
  submitted_at         timestamptz not null default now(),
  reviewed_by          uuid references auth.users (id) on delete set null,
  reviewed_at          timestamptz,
  decision_reason      text,
  store_id             uuid references public.stores (id) on delete set null,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- One open application per account. A rejected or withdrawn one can be followed by a fresh one.
create unique index if not exists vendor_applications_open_ux
  on public.vendor_applications (auth_user_id)
  where status in ('submitted', 'info_requested', 'approved');
create index if not exists vendor_applications_status_idx
  on public.vendor_applications (status, submitted_at);

alter table public.vendor_applications enable row level security;
revoke all on public.vendor_applications from anon, authenticated;

-- ── 3. platform settings ─────────────────────────────────────────────────────────────────────────
-- One row. Auto-approval is off by default: a reviewer sees every business before it can trade.
create table if not exists public.platform_settings (
  id                   boolean primary key default true check (id),
  auto_approve_vendors boolean not null default false,
  terms_version        text not null default '2026-10',
  updated_by           uuid references auth.users (id) on delete set null,
  updated_at           timestamptz not null default now()
);
insert into public.platform_settings (id) values (true) on conflict (id) do nothing;

alter table public.platform_settings enable row level security;
revoke all on public.platform_settings from anon, authenticated;

-- ── 4. helpers (internal: no client grant) ───────────────────────────────────────────────────────
/** Throwaway inboxes are refused: an application has to reach a real person. */
create or replace function public.is_disposable_email(p_email text) returns boolean
language sql immutable set search_path = public as $$
  select split_part(lower(coalesce(p_email, '')), '@', 2) = any (array[
    'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', '10minutemail.com',
    'tempmail.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'dispostable.com',
    'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com'
  ])
$$;

/** The caller's verified email, or null when the address has not been confirmed yet. */
create or replace function public.verified_email() returns text
language plpgsql stable security definer set search_path = public as $$
declare v_email text;
begin
  select u.email into v_email from auth.users u
   where u.id = auth.uid() and u.email_confirmed_at is not null;
  return v_email;
end $$;

/** Does the caller already belong to a shop, as owner or staff? */
create or replace function public.caller_has_shop() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.stores st where st.owner_id = auth.uid())
      or exists (select 1 from public.profiles p where p.auth_user_id = auth.uid() and p.is_active)
$$;

revoke all on function public.is_disposable_email(text) from public, anon, authenticated;
revoke all on function public.verified_email() from public, anon, authenticated;
revoke all on function public.caller_has_shop() from public, anon, authenticated;

-- ── 5. the applicant ─────────────────────────────────────────────────────────────────────────────
/**
 * Submit, or resubmit, the caller's application.
 *
 * Refused until the email is verified, so an application always has a reachable owner behind it.
 * An application that is waiting (submitted) or was sent back (info_requested) is updated in place
 * and goes back to 'submitted'; anything else starts a new one.
 */
create or replace function public.submit_vendor_application(p_application jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_email    text;
  v_settings public.platform_settings;
  v_existing public.vendor_applications;
  v_id       uuid;
  v_status   text;
  v_owner    text := nullif(trim(coalesce(p_application ->> 'owner_name', '')), '');
  v_legal    text := nullif(trim(coalesce(p_application ->> 'legal_name', '')), '');
  v_type     text := lower(nullif(trim(coalesce(p_application ->> 'business_type', '')), ''));
  v_country  text := nullif(trim(coalesce(p_application ->> 'country', '')), '');
  v_currency text := upper(coalesce(nullif(trim(coalesce(p_application ->> 'currency', '')), ''), 'LKR'));
  v_locs     int  := coalesce(nullif(p_application ->> 'locations_count', '')::int, 1);
  v_tills    int  := coalesce(nullif(p_application ->> 'tills_count', '')::int, 1);
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if public.is_platform_admin() then
    raise exception 'a platform administrator cannot register a business' using errcode = '42501';
  end if;

  v_email := public.verified_email();
  if v_email is null then
    raise exception 'verify your email address before submitting the application' using errcode = '42501';
  end if;
  if public.is_disposable_email(v_email) then
    raise exception 'use a permanent email address, not a temporary inbox';
  end if;
  if public.caller_has_shop() then
    raise exception 'this account already belongs to a shop';
  end if;

  if v_owner is null then raise exception 'enter your full name'; end if;
  if v_legal is null then raise exception 'enter the business name'; end if;
  if v_type is null or v_type not in ('retail', 'grocery', 'restaurant', 'pharmacy', 'services',
                                      'wholesale', 'manufacturing', 'other') then
    raise exception 'choose what kind of business this is';
  end if;
  if v_country is null then raise exception 'choose the country the business trades in'; end if;
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'currency must be a three-letter code such as LKR'; end if;
  if v_locs < 1 or v_tills < 1 then raise exception 'locations and tills must be at least 1'; end if;

  select * into v_settings from public.platform_settings where id;
  if coalesce(p_application ->> 'terms_version', '') <> v_settings.terms_version then
    raise exception 'accept the current terms of service to continue';
  end if;

  v_status := case when v_settings.auto_approve_vendors then 'approved' else 'submitted' end;

  select * into v_existing from public.vendor_applications
   where auth_user_id = v_uid and status in ('submitted', 'info_requested', 'approved')
   for update;

  if found and v_existing.status = 'approved' then
    raise exception 'this application is already approved - open your shop';
  end if;

  if found then
    update public.vendor_applications set
      status = v_status,
      owner_name = v_owner,
      owner_phone = nullif(trim(coalesce(p_application ->> 'owner_phone', '')), ''),
      legal_name = v_legal,
      trading_name = nullif(trim(coalesce(p_application ->> 'trading_name', '')), ''),
      business_type = v_type,
      country = v_country,
      currency = v_currency,
      address = nullif(trim(coalesce(p_application ->> 'address', '')), ''),
      phone = nullif(trim(coalesce(p_application ->> 'phone', '')), ''),
      tax_number = nullif(trim(coalesce(p_application ->> 'tax_number', '')), ''),
      registration_number = nullif(trim(coalesce(p_application ->> 'registration_number', '')), ''),
      locations_count = v_locs,
      tills_count = v_tills,
      terms_version = v_settings.terms_version,
      terms_accepted_at = now(),
      submitted_at = now(),
      reviewed_by = null,
      reviewed_at = case when v_status = 'approved' then now() else null end,
      decision_reason = case when v_status = 'approved' then 'Approved automatically' else null end,
      updated_at = now()
     where id = v_existing.id
    returning id into v_id;
  else
    insert into public.vendor_applications (
      auth_user_id, status, owner_name, owner_phone, legal_name, trading_name, business_type, country,
      currency, address, phone, tax_number, registration_number, locations_count, tills_count,
      terms_version, terms_accepted_at, reviewed_at, decision_reason
    ) values (
      v_uid, v_status, v_owner, nullif(trim(coalesce(p_application ->> 'owner_phone', '')), ''), v_legal,
      nullif(trim(coalesce(p_application ->> 'trading_name', '')), ''), v_type, v_country, v_currency,
      nullif(trim(coalesce(p_application ->> 'address', '')), ''),
      nullif(trim(coalesce(p_application ->> 'phone', '')), ''),
      nullif(trim(coalesce(p_application ->> 'tax_number', '')), ''),
      nullif(trim(coalesce(p_application ->> 'registration_number', '')), ''),
      v_locs, v_tills, v_settings.terms_version, now(),
      case when v_status = 'approved' then now() else null end,
      case when v_status = 'approved' then 'Approved automatically' else null end
    )
    returning id into v_id;
  end if;

  if v_status = 'approved' then
    insert into public.platform_audit (actor, action, target_user, detail)
    values (null, 'vendor_auto_approved', v_uid, jsonb_build_object('application_id', v_id, 'business', v_legal));
  end if;

  return jsonb_build_object('id', v_id, 'status', v_status);
end $$;

/**
 * Where the caller's registration stands. Readable before the email is verified, so the app can
 * say "check your inbox" rather than failing.
 */
create or replace function public.my_vendor_application()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_app public.vendor_applications;
begin
  if v_uid is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select * into v_app from public.vendor_applications
   where auth_user_id = v_uid
   order by created_at desc
   limit 1;

  return jsonb_build_object(
    'email', (select email from auth.users where id = v_uid),
    'email_verified', public.verified_email() is not null,
    'has_shop', public.caller_has_shop(),
    'terms_version', (select terms_version from public.platform_settings where id),
    'application', case when v_app.id is null then null else to_jsonb(v_app) - 'reviewed_by' end
  );
end $$;

/** Take back an application that has not been decided yet. */
create or replace function public.withdraw_vendor_application()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if auth.uid() is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.vendor_applications
     set status = 'withdrawn', updated_at = now()
   where auth_user_id = auth.uid() and status in ('submitted', 'info_requested')
  returning id into v_id;
  if v_id is null then raise exception 'there is no pending application to withdraw'; end if;
  return jsonb_build_object('id', v_id, 'status', 'withdrawn');
end $$;

-- ── 6. the reviewer ──────────────────────────────────────────────────────────────────────────────
/** Applications for review, oldest waiting first. p_status null = everything still open. */
create or replace function public.platform_vendor_applications(p_status text default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.submitted_at)
      from (
        select a.*, u.email as owner_email, st.name as store_name
          from public.vendor_applications a
          join auth.users u on u.id = a.auth_user_id
          left join public.stores st on st.id = a.store_id
         where (p_status is null and a.status in ('submitted', 'info_requested'))
            or a.status = p_status
            or p_status = 'all'
      ) x
  ), '[]'::jsonb);
end $$;

/**
 * Decide an application: 'approve', 'reject' or 'request_info'.
 *
 * Approval does not create the shop. The owner opens it from /onboarding through create_store(),
 * which is what keeps one code path for every new shop. A reason is required to reject or to ask
 * for information, because the applicant reads it.
 */
create or replace function public.platform_review_vendor_application(
  p_application uuid, p_decision text, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_app    public.vendor_applications;
  v_status text;
  v_reason text := nullif(trim(coalesce(p_reason, '')), '');
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;

  v_status := case p_decision
                when 'approve' then 'approved'
                when 'reject' then 'rejected'
                when 'request_info' then 'info_requested'
              end;
  if v_status is null then raise exception 'decision must be approve, reject or request_info'; end if;
  if v_status <> 'approved' and v_reason is null then
    raise exception 'give a reason the applicant can act on';
  end if;

  select * into v_app from public.vendor_applications where id = p_application for update;
  if not found then raise exception 'application not found'; end if;
  if v_app.status not in ('submitted', 'info_requested') then
    raise exception 'this application is already %', v_app.status;
  end if;

  update public.vendor_applications
     set status = v_status, reviewed_by = auth.uid(), reviewed_at = now(),
         decision_reason = v_reason, updated_at = now()
   where id = p_application;

  insert into public.platform_audit (actor, action, target_user, detail)
  values (auth.uid(), 'vendor_' || v_status, v_app.auth_user_id,
          jsonb_build_object('application_id', v_app.id, 'business', v_app.legal_name, 'reason', v_reason));

  return jsonb_build_object('id', p_application, 'status', v_status);
end $$;

create or replace function public.platform_registration_settings()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  return (select jsonb_build_object('auto_approve_vendors', auto_approve_vendors,
                                    'terms_version', terms_version, 'updated_at', updated_at)
            from public.platform_settings where id);
end $$;

create or replace function public.platform_set_auto_approve(p_on boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'platform admins only' using errcode = '42501';
  end if;
  update public.platform_settings
     set auto_approve_vendors = coalesce(p_on, false), updated_by = auth.uid(), updated_at = now()
   where id;
  insert into public.platform_audit (actor, action, detail)
  values (auth.uid(), 'vendor_auto_approve_set', jsonb_build_object('on', coalesce(p_on, false)));
  return public.platform_registration_settings();
end $$;

-- ── 7. opening the shop ──────────────────────────────────────────────────────────────────────────
/**
 * 0009's create_store(), now gated on an approved application.
 *
 * Same signature, so the onboarding form and every existing grant keep working. An account that
 * already has a shop still gets it back. A new shop needs an approved application without a shop;
 * the application is linked to the new store, and its business type and country are copied over.
 */
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
  v_app public.vendor_applications;
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

  select * into v_app from public.vendor_applications
   where auth_user_id = v_uid and status = 'approved' and store_id is null
   for update;
  if not found then
    raise exception 'register your business and wait for approval before opening a shop'
      using errcode = '42501';
  end if;

  insert into public.stores (owner_id, name, address, phone, vat_no, currency,
                             prices_include_tax, bottle_fee_cents, max_cashier_discount_pct,
                             business_type, country)
  values (v_uid, v_name, nullif(trim(coalesce(p_address, '')), ''), nullif(trim(coalesce(p_phone, '')), ''),
          nullif(trim(coalesce(p_vat_no, '')), ''),
          coalesce(nullif(trim(p_currency), ''), v_app.currency, 'LKR'),
          coalesce(p_prices_include_tax, true), coalesce(p_bottle_fee_cents, 10000),
          coalesce(p_max_cashier_discount_pct, 5), v_app.business_type, v_app.country)
  returning id into v_store;

  -- The owner is staff too: this row is what app_role() and app_store_id() read.
  -- staff_code '1' is the convention the till already uses for the owner.
  insert into public.profiles (auth_user_id, store_id, full_name, staff_code, role)
  values (v_uid, v_store, coalesce(v_app.owner_name, v_name || ' owner'), '1', 'owner')
  returning id into v_profile;

  update public.vendor_applications set store_id = v_store, updated_at = now() where id = v_app.id;

  return jsonb_build_object('id', v_store, 'name', v_name, 'profile_id', v_profile, 'created', true);
end $$;

-- ── 8. who may call what ─────────────────────────────────────────────────────────────────────────
revoke all on function
  public.submit_vendor_application(jsonb),
  public.my_vendor_application(),
  public.withdraw_vendor_application(),
  public.platform_vendor_applications(text),
  public.platform_review_vendor_application(uuid, text, text),
  public.platform_registration_settings(),
  public.platform_set_auto_approve(boolean)
  from public, anon, authenticated;

grant execute on function
  public.submit_vendor_application(jsonb),
  public.my_vendor_application(),
  public.withdraw_vendor_application(),
  public.platform_vendor_applications(text),
  public.platform_review_vendor_application(uuid, text, text),
  public.platform_registration_settings(),
  public.platform_set_auto_approve(boolean)
  to authenticated;
