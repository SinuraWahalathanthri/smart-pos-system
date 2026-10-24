-- BOOTSTRAP THE FIRST PLATFORM ADMIN. Run ONCE in the Supabase SQL editor, after migration 0025.
--
-- Why this is not in the app: the admin panel creates owner accounts, so the first admin has to exist
-- before anyone can use it. Do not add a self-service "become admin" path - that would be a permanent
-- privilege-escalation hole.
--
-- Copy this content into a scratch query, replace every <PLACEHOLDER>, run it, then DISCARD the edited
-- text. It contains a plain-text password. This file on disk keeps only placeholders.
--
-- After running, sign in with the admin email. No password change is forced: you chose this password
-- yourself, just now, and it was never handed to anyone else - which is exactly the risk the
-- must_change_password flag exists to cover for shop owners. You can still change it at /account.

do $$
declare
  v_email    text := '<ADMIN EMAIL>';
  v_password text := '<A LONG RANDOM PASSWORD>';
  v_name     text := '<YOUR NAME>';
  v_user     uuid;
begin
  if length(coalesce(v_password, '')) < 12 then
    raise exception 'use a password of at least 12 characters';
  end if;
  if exists (select 1 from auth.users where lower(email) = lower(v_email)) then
    raise exception 'an account with that email already exists';
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password,
    email_confirmed_at, created_at, updated_at,
    raw_app_meta_data, raw_user_meta_data,
    confirmation_token, recovery_token, email_change, email_change_token_new
  ) values (
    '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
    lower(trim(v_email)), extensions.crypt(v_password, extensions.gen_salt('bf')),
    now(), now(), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('full_name', v_name),
    '', '', '', ''
  ) returning id into v_user;

  insert into auth.identities (
    id, user_id, provider_id, provider, identity_data, created_at, updated_at, last_sign_in_at
  ) values (
    gen_random_uuid(), v_user, v_user::text, 'email',
    jsonb_build_object('sub', v_user::text, 'email', lower(trim(v_email)), 'email_verified', true),
    now(), now(), now()
  );

  -- The admin belongs to no store: platform_admins is a separate principal, not a shop role.
  insert into public.platform_admins (auth_user_id, full_name, note)
  values (v_user, v_name, 'bootstrap');

  raise notice 'platform admin created for %', v_email;
end $$;
