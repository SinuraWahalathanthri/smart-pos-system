-- Till sign-in and supervisor approval, server side.
--
-- A till is a signed-in Supabase user (a "device" profile). Staff then identify themselves on that till
-- with staff code + PIN. The PIN is checked here, never in the browser, and never leaves the database.
-- Failed PINs share one counter per person (3 wrong = locked 5 minutes), whether the PIN was typed at
-- sign-in or at a supervisor approval.

-- ── shared PIN check (internal) ─────────────────────────────────────────────
-- Returns jsonb instead of raising, so the failed-attempt counter is not rolled back.
create function public.check_pin(p_target public.profiles, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_fails int;
  c_max_tries constant int := 3;
begin
  if coalesce(p_pin, '') = '' then
    return jsonb_build_object('ok', false, 'reason', 'pin_required');
  end if;

  if p_target.locked_until is not null and p_target.locked_until > now() then
    return jsonb_build_object('ok', false, 'reason', 'locked',
      'seconds', ceil(extract(epoch from (p_target.locked_until - now())))::int);
  end if;

  -- an expired lock starts a fresh count
  v_fails := case when p_target.locked_until is not null then 0 else p_target.failed_attempts end;

  if p_target.pin_hash is null or p_target.pin_hash <> crypt(p_pin, p_target.pin_hash) then
    v_fails := v_fails + 1;
    update public.profiles
      set failed_attempts = case when v_fails >= c_max_tries then 0 else v_fails end,
          locked_until = case when v_fails >= c_max_tries then now() + interval '5 minutes' else null end
      where id = p_target.id;
    return jsonb_build_object('ok', false,
      'reason', case when v_fails >= c_max_tries then 'locked' else 'wrong_pin' end,
      'tries_left', greatest(0, c_max_tries - v_fails));
  end if;

  update public.profiles set failed_attempts = 0, locked_until = null where id = p_target.id;
  return jsonb_build_object('ok', true);
end $$;

-- ── sign a member of staff in on this till ──────────────────────────────────
create function public.verify_staff_pin(p_staff_code text, p_pin text) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_caller public.profiles;
  v_target public.profiles;
  v_check jsonb;
begin
  select * into v_caller from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;

  select * into v_target from public.profiles
    where store_id = v_caller.store_id and staff_code = p_staff_code and is_active;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_staff');
  end if;

  v_check := public.check_pin(v_target, p_pin);
  insert into public.audit_logs (store_id, action, requested_by, approved_by)
    values (v_caller.store_id,
            case when (v_check ->> 'ok')::boolean then 'till_sign_in' else 'till_sign_in_failed' end,
            v_caller.id, v_target.id);

  if not (v_check ->> 'ok')::boolean then return v_check; end if;
  return v_check || jsonb_build_object('staff', jsonb_build_object(
    'id', v_target.id, 'name', v_target.full_name, 'role', v_target.role, 'code', v_target.staff_code));
end $$;

-- ── supervisor approval (replaces the 3-argument version from 0003) ─────────
-- Normal path: scan the badge, then type the PIN. Both are required.
-- Owner at the till: p_staff_code = the owner's code and no badge; the PIN alone approves.
drop function public.verify_supervisor(text, text, text);

create function public.verify_supervisor(p_badge text, p_pin text, p_action text, p_staff_code text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_caller public.profiles;
  v_target public.profiles;
  v_check jsonb;
  v_token uuid;
begin
  select * into v_caller from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;

  if coalesce(p_badge, '') = '' then
    if v_caller.role = 'owner' then
      v_target := v_caller;
    elsif coalesce(p_staff_code, '') <> '' then
      select * into v_target from public.profiles
        where store_id = v_caller.store_id and staff_code = p_staff_code and role = 'owner' and is_active;
    end if;
    if v_target.id is null then
      return jsonb_build_object('ok', false, 'reason', 'badge_required');
    end if;
  else
    select * into v_target from public.profiles
      where store_id = v_caller.store_id and is_active and role in ('supervisor', 'owner')
        and badge_hash is not null and badge_hash = crypt(p_badge, badge_hash)
      limit 1;
    if not found then
      insert into public.audit_logs (store_id, action, requested_by, reason)
        values (v_caller.store_id, 'approval_invalid_badge', v_caller.id, p_action);
      return jsonb_build_object('ok', false, 'reason', 'invalid_badge');
    end if;
  end if;

  v_check := public.check_pin(v_target, p_pin);
  if not (v_check ->> 'ok')::boolean then
    insert into public.audit_logs (store_id, action, requested_by, approved_by, reason)
      values (v_caller.store_id, 'approval_wrong_pin', v_caller.id, v_target.id, p_action);
    return v_check;
  end if;

  insert into public.approvals (store_id, approver_id, requested_by, action, expires_at)
    values (v_caller.store_id, v_target.id, v_caller.id, p_action, now() + interval '60 seconds')
    returning id into v_token;
  insert into public.audit_logs (store_id, action, requested_by, approved_by, reason)
    values (v_caller.store_id, 'approval_granted', v_caller.id, v_target.id, p_action);

  return jsonb_build_object('ok', true, 'token', v_token, 'approver_id', v_target.id,
    'approver_name', v_target.full_name, 'approver_role', v_target.role, 'approver_code', v_target.staff_code);
end $$;

-- ── is this a supervisor's badge? (instant feedback after the scan, before the PIN is typed) ──
-- Reveals only the name; the approval still needs the PIN, and wrong PINs are what get locked.
create function public.check_badge(p_badge text) returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
declare v_caller public.profiles; v_target public.profiles;
begin
  select * into v_caller from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if coalesce(p_badge, '') = '' then return jsonb_build_object('ok', false, 'reason', 'invalid_badge'); end if;

  select * into v_target from public.profiles
    where store_id = v_caller.store_id and is_active and role in ('supervisor', 'owner')
      and badge_hash is not null and badge_hash = crypt(p_badge, badge_hash)
    limit 1;
  if not found then return jsonb_build_object('ok', false, 'reason', 'invalid_badge'); end if;
  return jsonb_build_object('ok', true, 'name', v_target.full_name,
    'locked', coalesce(v_target.locked_until > now(), false));
end $$;

-- ── shop settings the till needs ────────────────────────────────────────────
create function public.get_till_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles; v_store public.stores;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_store from public.stores where id = v_profile.store_id;
  return jsonb_build_object(
    'store', jsonb_build_object('id', v_store.id, 'name', v_store.name, 'currency', v_store.currency,
      'bottle_fee_cents', v_store.bottle_fee_cents, 'max_cashier_discount_pct', v_store.max_cashier_discount_pct,
      'prices_include_tax', v_store.prices_include_tax),
    'device', jsonb_build_object('id', v_profile.id, 'role', v_profile.role, 'name', v_profile.full_name));
end $$;

-- ── permissions ─────────────────────────────────────────────────────────────
revoke all on function
  public.check_pin(public.profiles, text),
  public.verify_staff_pin(text, text),
  public.verify_supervisor(text, text, text, text),
  public.check_badge(text),
  public.get_till_context()
  from public, anon, authenticated;

grant execute on function
  public.verify_staff_pin(text, text),
  public.verify_supervisor(text, text, text, text),
  public.check_badge(text),
  public.get_till_context()
  to authenticated;
-- check_pin is internal: no client role may call it.
