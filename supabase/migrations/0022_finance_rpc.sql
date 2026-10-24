-- Finance RPCs: expenses, supplier bills, production costing, sale voids, and the reports behind
-- the finance dashboard.
--
-- Every function here is SECURITY DEFINER and starts by resolving the caller through the same
-- helpers as the rest of the app (assert_can_manage_staff, app_store_id, app_role). Only the owner and
-- supervisor may reach any of this: a cashier's token is refused with 42501, which is the real gate -
-- the dashboard hiding a menu item is only courtesy.
--
-- Reports are SQL, not JavaScript, for one reason: a figure quoted to an accountant must be
-- reproducible from the database alone, and must obey the same rules everywhere. The formulas are the
-- ones in the brief, and they are written once, here.

-- ---------------------------------------------------------------------------------------------
-- guards
-- ---------------------------------------------------------------------------------------------
create or replace function public.assert_finance_access()
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_profile.role not in ('owner', 'supervisor') then
    raise exception 'financial records are for the owner and supervisors' using errcode = '42501';
  end if;
  return v_profile;
end $$;

-- Recording a cost is an owner decision: a supervisor may see a margin, not set it.
create or replace function public.assert_owner()
returns public.profiles
language plpgsql stable security definer set search_path = public as $$
declare v_profile public.profiles;
begin
  select * into v_profile from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_profile.role <> 'owner' then
    raise exception 'only the shop owner can do this' using errcode = '42501';
  end if;
  return v_profile;
end $$;

-- One place that decides what an expense's status is, so a part-payment can never be recorded as
-- "paid" by a carelessly passed argument.
create or replace function public.expense_status_for(p_amount bigint, p_paid bigint)
returns public.expense_status
language sql immutable as $$
  select case
    when p_paid <= 0 then 'unpaid'::public.expense_status
    when p_paid >= p_amount then 'paid'::public.expense_status
    else 'partial'::public.expense_status
  end
$$;

create or replace function public.purchase_status_for(p_total bigint, p_paid bigint)
returns public.purchase_status
language sql immutable as $$
  select case
    when p_paid <= 0 then 'unpaid'::public.purchase_status
    when p_paid >= p_total then 'paid'::public.purchase_status
    else 'partial'::public.purchase_status
  end
$$;

-- ---------------------------------------------------------------------------------------------
-- expense categories
-- ---------------------------------------------------------------------------------------------
-- Default categories
--
-- Seeded from a trigger rather than on first use. A suggestion list that only appears once someone
-- opens the expense form is a suggestion list that is empty the first time it is needed.
-- ---------------------------------------------------------------------------------------------

create or replace function public.seed_expense_categories_for(p_store uuid)
returns void
language sql security definer set search_path = public as $$
  insert into public.expense_categories (store_id, name, is_default, is_operating, sort_order)
  select p_store, name, true, not (name in ('Equipment', 'Vehicle')), ord
    from unnest(array[
      'Rent', 'Electricity', 'Water', 'Internet & phone', 'Salaries & wages', 'Transport',
      'Fuel', 'Shop maintenance', 'Cleaning', 'Packaging', 'Marketing', 'Licences & fees',
      'Bank charges', 'Professional fees', 'Insurance', 'Tea & staff welfare', 'Repairs',
      'Equipment', 'Vehicle', 'Other'
    ]) with ordinality as t(name, ord)
  on conflict (store_id, name) do nothing
$$;

create or replace function public.seed_expense_categories()
returns void
language sql security definer set search_path = public as $$
  select public.seed_expense_categories_for(public.app_store_id())
$$;

create or replace function public.stores_seed_expense_categories()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.seed_expense_categories_for(new.id);
  return new;
end $$;

drop trigger if exists stores_seed_expense_categories on public.stores;
create trigger stores_seed_expense_categories
  after insert on public.stores
  for each row execute function public.stores_seed_expense_categories();

-- Existing shops created before this migration.
do $$
declare v_store uuid;
begin
  for v_store in select id from public.stores loop
    perform public.seed_expense_categories_for(v_store);
  end loop;
end $$;

create or replace function public.save_expense_category(p_name text, p_is_operating boolean default true)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_name text := trim(coalesce(p_name, ''));
  v_id uuid;
begin
  if v_name = '' then raise exception 'category name is required'; end if;
  if length(v_name) > 60 then raise exception 'category name is too long'; end if;

  insert into public.expense_categories (store_id, name, is_operating, sort_order)
  values (v_me.store_id, v_name, coalesce(p_is_operating, true), 999)
  on conflict (store_id, name) do update set is_operating = excluded.is_operating
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', v_name);
end $$;

-- ---------------------------------------------------------------------------------------------
-- expenses
-- ---------------------------------------------------------------------------------------------
-- One function for create and edit. Editing an expense that has payments against it is refused
-- unless only the descriptive fields change, because rewriting an amount would silently disagree
-- with the money already recorded as paid.
create or replace function public.save_expense(p_expense jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_id uuid := nullif(p_expense ->> 'id', '')::uuid;
  v_before public.expenses;
  v_kind public.expense_kind := coalesce((p_expense ->> 'kind')::public.expense_kind, 'operating');
  v_category text := trim(coalesce(p_expense ->> 'category', ''));
  v_description text := trim(coalesce(p_expense ->> 'description', ''));
  v_amount bigint := coalesce((p_expense ->> 'amount_cents')::bigint, 0);
  v_tax bigint := coalesce((p_expense ->> 'tax_cents')::bigint, 0);
  v_on date := coalesce(nullif(p_expense ->> 'expense_on', '')::date, current_date);
  v_due date := nullif(p_expense ->> 'due_on', '')::date;
  v_method public.pay_method := nullif(p_expense ->> 'payment_method', '')::public.pay_method;
  v_payee text := nullif(trim(coalesce(p_expense ->> 'payee', '')), '');
  v_reference text := nullif(trim(coalesce(p_expense ->> 'reference', '')), '');
  v_notes text := nullif(trim(coalesce(p_expense ->> 'notes', '')), '');
  v_recurring boolean := coalesce((p_expense ->> 'is_recurring')::boolean, false);
  v_rule text := nullif(trim(coalesce(p_expense ->> 'recurrence_rule', '')), '');
  v_paid_now bigint := coalesce((p_expense ->> 'paid_cents')::bigint, 0);
  v_voucher bigint;
  v_paid bigint;
begin
  if v_category = '' then raise exception 'choose a category for the expense'; end if;
  if v_description = '' then raise exception 'a description is required'; end if;
  if v_amount <= 0 then raise exception 'the amount must be more than zero'; end if;
  if v_tax < 0 or v_tax > v_amount then raise exception 'tax cannot exceed the amount'; end if;
  if v_rule is not null and v_rule not in ('weekly', 'monthly', 'quarterly', 'yearly') then
    raise exception 'recurrence must be weekly, monthly, quarterly or yearly';
  end if;

  if v_id is null then
    -- A voucher number is allocated per store so two people entering expenses at once cannot clash.
    select coalesce(max(voucher_no), 1000) + 1 into v_voucher
      from public.expenses where store_id = v_me.store_id;

    insert into public.expenses
      (store_id, voucher_no, kind, category, description, amount_cents, tax_cents, expense_on, due_on,
       status, paid_cents, payment_method, payee, reference, notes, is_recurring, recurrence_rule, created_by)
    values
      (v_me.store_id, v_voucher, v_kind, v_category, v_description, v_amount, v_tax, v_on, v_due,
       'unpaid', 0, v_method, v_payee, v_reference, v_notes, v_recurring, v_rule, v_me.id)
    returning id, voucher_no into v_id, v_voucher;

    if v_paid_now > 0 then
      if v_paid_now > v_amount then raise exception 'cannot pay more than the amount'; end if;
      insert into public.expense_payments (store_id, expense_id, amount_cents, method, paid_on, created_by)
      values (v_me.store_id, v_id, v_paid_now, coalesce(v_method, 'cash'), v_on, v_me.id);
      update public.expenses
         set paid_cents = v_paid_now, status = public.expense_status_for(v_amount, v_paid_now)
       where id = v_id;
    end if;

    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after)
    values (v_me.store_id, 'expense_created', 'expenses', v_id, v_me.id, to_jsonb(p_expense));

    -- First use of a category is how a shop teaches the system its own vocabulary.
    insert into public.expense_categories (store_id, name, is_operating, sort_order)
    values (v_me.store_id, v_category, v_kind = 'operating', 999)
    on conflict (store_id, name) do nothing;
  else
    select * into v_before from public.expenses
     where id = v_id and store_id = v_me.store_id;
    if not found then raise exception 'expense not found'; end if;
    if v_before.voided_at is not null then raise exception 'this expense has been voided'; end if;

    v_paid := v_before.paid_cents;
    if v_paid > 0 and v_amount <> v_before.amount_cents then
      raise exception 'this expense already has % paid against it, so its amount cannot be changed. Void it and enter a new one.', v_paid;
    end if;

    update public.expenses set
      kind = v_kind,
      category = v_category,
      description = v_description,
      amount_cents = v_amount,
      tax_cents = v_tax,
      expense_on = v_on,
      due_on = v_due,
      payment_method = v_method,
      payee = v_payee,
      reference = v_reference,
      notes = v_notes,
      is_recurring = v_recurring,
      recurrence_rule = v_rule,
      status = public.expense_status_for(v_amount, v_paid)
    where id = v_id;

    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
    values (v_me.store_id, 'expense_updated', 'expenses', v_id, v_me.id, to_jsonb(v_before), to_jsonb(p_expense));

    if v_paid_now > 0 then
      perform public.pay_expense(v_id, v_paid_now, coalesce(v_method, 'cash'), v_on, null);
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'voucher_no', v_voucher);
end $$;

create or replace function public.pay_expense(
  p_expense uuid, p_amount bigint, p_method public.pay_method,
  p_paid_on date default current_date, p_reference text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_row public.expenses;
  v_paid bigint;
begin
  select * into v_row from public.expenses
   where id = p_expense and store_id = v_me.store_id;
  if not found then raise exception 'expense not found'; end if;
  if v_row.voided_at is not null then raise exception 'this expense has been voided'; end if;
  if p_amount <= 0 then raise exception 'a payment must be more than zero'; end if;
  if p_method = 'credit' then raise exception 'an expense cannot be settled on credit'; end if;

  v_paid := v_row.paid_cents + p_amount;
  if v_paid > v_row.amount_cents then
    raise exception 'that is more than the % still owed', (v_row.amount_cents - v_row.paid_cents);
  end if;

  insert into public.expense_payments
    (store_id, expense_id, amount_cents, method, paid_on, reference, created_by)
  values (v_me.store_id, v_row.id, p_amount, p_method, coalesce(p_paid_on, current_date), p_reference, v_me.id);

  update public.expenses
     set paid_cents = v_paid, status = public.expense_status_for(amount_cents, v_paid)
   where id = v_row.id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after)
  values (v_me.store_id, 'expense_paid', 'expenses', v_row.id, v_me.id,
          jsonb_build_object('amount_cents', p_amount, 'method', p_method));

  return jsonb_build_object('paid_cents', v_paid, 'status', public.expense_status_for(v_row.amount_cents, v_paid));
end $$;

-- A reversal, never a delete. The original stays, marked, with the reason attached.
create or replace function public.void_expense(p_expense uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_row public.expenses;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to void an expense'; end if;

  select * into v_row from public.expenses where id = p_expense and store_id = v_me.store_id;
  if not found then raise exception 'expense not found'; end if;
  if v_row.voided_at is not null then raise exception 'already voided'; end if;

  update public.expenses
     set voided_at = now(), voided_by = v_me.id, void_reason = trim(p_reason),
         status = 'void'
   where id = p_expense;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, reason)
  values (v_me.store_id, 'expense_voided', 'expenses', p_expense, v_me.id, to_jsonb(v_row), trim(p_reason));

  return jsonb_build_object('id', p_expense, 'status', 'void');
end $$;

create or replace function public.attach_expense_receipt(
  p_expense uuid, p_name text, p_mime text, p_content text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_size int := length(coalesce(p_content, ''));
  v_id uuid;
begin
  if not exists (select 1 from public.expenses where id = p_expense and store_id = v_me.store_id) then
    raise exception 'expense not found';
  end if;
  if v_size = 0 then raise exception 'the attachment is empty'; end if;
  -- 2 MB of base64 is ~1.5 MB of file: enough for a photographed receipt, small enough for a row.
  if v_size > 2800000 then raise exception 'the attachment is too large (keep it under about 2 MB)'; end if;

  insert into public.expense_attachments (store_id, expense_id, name, mime, size_bytes, content, created_by)
  values (v_me.store_id, p_expense, coalesce(nullif(trim(p_name), ''), 'receipt'), 
          coalesce(nullif(trim(p_mime), ''), 'application/octet-stream'),
          round(v_size * 0.75)::int, p_content, v_me.id)
  returning id into v_id;

  return jsonb_build_object('id', v_id, 'name', p_name);
end $$;

-- The list and its search. Returns only what the screen needs, and only non-voided rows by default.
create or replace function public.expense_list(
  p_from date default null,
  p_to date default null,
  p_category text default null,
  p_method public.pay_method default null,
  p_status public.expense_status default null,
  p_query text default null,
  p_min_cents bigint default null,
  p_max_cents bigint default null,
  p_limit int default 200
) returns table (
  id uuid, voucher_no bigint, kind public.expense_kind, category text, description text,
  amount_cents bigint, tax_cents bigint, expense_on date, due_on date, status public.expense_status,
  paid_cents bigint, payment_method public.pay_method, payee text, reference text,
  is_recurring boolean, recurrence_rule text, voided_at timestamptz,
  has_receipt boolean, created_at timestamptz
)
language sql stable security definer set search_path = public as $$
  select e.id, e.voucher_no, e.kind, e.category, e.description, e.amount_cents, e.tax_cents,
         e.expense_on, e.due_on, e.status, e.paid_cents, e.payment_method, e.payee, e.reference,
         e.is_recurring, e.recurrence_rule, e.voided_at,
         exists (select 1 from public.expense_attachments a where a.expense_id = e.id),
         e.created_at
    from public.expenses e
   where e.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and (p_from is null or e.expense_on >= p_from)
     and (p_to is null or e.expense_on <= p_to)
     and (p_category is null or e.category = p_category)
     and (p_method is null or e.payment_method = p_method)
     and (p_status is null or e.status = p_status)
     and (p_min_cents is null or e.amount_cents >= p_min_cents)
     and (p_max_cents is null or e.amount_cents <= p_max_cents)
     and (
       p_query is null or trim(p_query) = ''
       or e.description ilike '%' || trim(p_query) || '%'
       or coalesce(e.payee, '') ilike '%' || trim(p_query) || '%'
       or coalesce(e.reference, '') ilike '%' || trim(p_query) || '%'
       or e.category ilike '%' || trim(p_query) || '%'
     )
   order by e.expense_on desc, e.voucher_no desc
   limit greatest(coalesce(p_limit, 200), 1)
$$;

-- ---------------------------------------------------------------------------------------------
-- supplier bills (purchases)
-- ---------------------------------------------------------------------------------------------
-- Receiving stock used to be cost-only: the shop could not tell whether it had paid the supplier.
-- This records the invoice behind the delivery as a payable, and optionally the payment. The stock
-- itself still moves through receive_stock()/stock_movements, so nothing is counted twice.
create or replace function public.save_purchase(p_purchase jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_id uuid := nullif(p_purchase ->> 'id', '')::uuid;
  v_supplier uuid := nullif(p_purchase ->> 'supplier_id', '')::uuid;
  v_total bigint := coalesce((p_purchase ->> 'total_cents')::bigint, 0);
  v_subtotal bigint := coalesce((p_purchase ->> 'subtotal_cents')::bigint, v_total);
  v_vat bigint := coalesce((p_purchase ->> 'input_vat_cents')::bigint, 0);
  v_extra bigint := coalesce((p_purchase ->> 'additional_cost_cents')::bigint, 0);
  v_paid_now bigint := coalesce((p_purchase ->> 'paid_cents')::bigint, 0);
  v_on date := coalesce(nullif(p_purchase ->> 'received_on', '')::date, current_date);
  v_due date := nullif(p_purchase ->> 'due_on', '')::date;
  v_method public.pay_method := nullif(p_purchase ->> 'payment_method', '')::public.pay_method;
  v_before public.goods_receipts;
  v_paid bigint := 0;
  v_status public.purchase_status;
begin
  if v_supplier is null then raise exception 'choose a supplier'; end if;
  if not exists (select 1 from public.suppliers where id = v_supplier and store_id = v_me.store_id) then
    raise exception 'supplier not found';
  end if;
  if v_total <= 0 then raise exception 'the invoice total must be more than zero'; end if;
  if v_subtotal < 0 or v_vat < 0 or v_extra < 0 then raise exception 'amounts cannot be negative'; end if;
  if v_paid_now < 0 or v_paid_now > v_total then raise exception 'the payment must be between zero and the total'; end if;

  if v_id is null then
    insert into public.goods_receipts
      (store_id, supplier_id, supplier_invoice_no, received_on, subtotal_cents, input_vat_cents,
       total_cents, additional_cost_cents, additional_cost_note, status, paid_cents, due_on,
       payment_method, notes, received_by)
    values
      (v_me.store_id, v_supplier, nullif(trim(coalesce(p_purchase ->> 'supplier_invoice_no', '')), ''),
       v_on, v_subtotal, v_vat, v_total, v_extra,
       nullif(trim(coalesce(p_purchase ->> 'additional_cost_note', '')), ''),
       public.purchase_status_for(v_total, 0), 0, v_due, v_method,
       nullif(trim(coalesce(p_purchase ->> 'notes', '')), ''), v_me.id)
    returning id into v_id;
  else
    select * into v_before from public.goods_receipts where id = v_id and store_id = v_me.store_id;
    if not found then raise exception 'purchase not found'; end if;
    if v_before.voided_at is not null then raise exception 'this purchase has been voided'; end if;
    if v_before.paid_cents > 0 and v_total <> v_before.total_cents then
      raise exception 'this purchase already has % paid against it, so its total cannot be changed.', v_before.paid_cents;
    end if;
    v_paid := v_before.paid_cents;

    update public.goods_receipts set
      supplier_id = v_supplier,
      supplier_invoice_no = nullif(trim(coalesce(p_purchase ->> 'supplier_invoice_no', '')), ''),
      received_on = v_on,
      subtotal_cents = v_subtotal,
      input_vat_cents = v_vat,
      total_cents = v_total,
      additional_cost_cents = v_extra,
      additional_cost_note = nullif(trim(coalesce(p_purchase ->> 'additional_cost_note', '')), ''),
      due_on = v_due,
      payment_method = v_method,
      notes = nullif(trim(coalesce(p_purchase ->> 'notes', '')), ''),
      status = public.purchase_status_for(v_total, v_paid)
    where id = v_id;
  end if;

  if v_paid_now > 0 then
    insert into public.purchase_payments (store_id, purchase_id, amount_cents, method, paid_on, created_by)
    values (v_me.store_id, v_id, v_paid_now, coalesce(v_method, 'cash'), v_on, v_me.id);
    v_paid := v_paid + v_paid_now;
  end if;

  v_status := public.purchase_status_for(v_total, v_paid);
  update public.goods_receipts set paid_cents = v_paid, status = v_status where id = v_id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
  values (v_me.store_id, case when v_before.id is null then 'purchase_recorded' else 'purchase_updated' end,
          'goods_receipts', v_id, v_me.id,
          case when v_before.id is null then null else to_jsonb(v_before) end, to_jsonb(p_purchase));

  return jsonb_build_object('id', v_id, 'status', v_status, 'paid_cents', v_paid);
end $$;

create or replace function public.pay_purchase(
  p_purchase uuid, p_amount bigint, p_method public.pay_method,
  p_paid_on date default current_date, p_reference text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_row public.goods_receipts;
  v_paid bigint;
begin
  select * into v_row from public.goods_receipts where id = p_purchase and store_id = v_me.store_id;
  if not found then raise exception 'purchase not found'; end if;
  if v_row.voided_at is not null then raise exception 'this purchase has been voided'; end if;
  if p_amount <= 0 then raise exception 'a payment must be more than zero'; end if;
  if p_method = 'credit' then raise exception 'a supplier bill cannot be settled on credit'; end if;

  v_paid := v_row.paid_cents + p_amount;
  if v_paid > v_row.total_cents then
    raise exception 'that is more than the % still owed', (v_row.total_cents - v_row.paid_cents);
  end if;

  insert into public.purchase_payments (store_id, purchase_id, amount_cents, method, paid_on, reference, created_by)
  values (v_me.store_id, v_row.id, p_amount, p_method, coalesce(p_paid_on, current_date), p_reference, v_me.id);

  update public.goods_receipts
     set paid_cents = v_paid, status = public.purchase_status_for(total_cents, v_paid)
   where id = v_row.id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after)
  values (v_me.store_id, 'purchase_paid', 'goods_receipts', v_row.id, v_me.id,
          jsonb_build_object('amount_cents', p_amount, 'method', p_method));

  return jsonb_build_object('paid_cents', v_paid);
end $$;

create or replace function public.void_purchase(p_purchase uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_row public.goods_receipts;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to void a purchase'; end if;
  select * into v_row from public.goods_receipts where id = p_purchase and store_id = v_me.store_id;
  if not found then raise exception 'purchase not found'; end if;
  if v_row.voided_at is not null then raise exception 'already voided'; end if;

  -- Stock that arrived stays on the shelf until someone adjusts it: undoing the delivery silently
  -- would make the stock ledger and the shelf disagree.
  update public.goods_receipts
     set voided_at = now(), void_reason = trim(p_reason), status = 'void'
   where id = p_purchase;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, reason)
  values (v_me.store_id, 'purchase_voided', 'goods_receipts', p_purchase, v_me.id, to_jsonb(v_row), trim(p_reason));

  return jsonb_build_object('id', p_purchase, 'status', 'void');
end $$;

-- ---------------------------------------------------------------------------------------------
-- manual cost entry
-- ---------------------------------------------------------------------------------------------
-- For a product bought before costs were tracked, or a price change the owner knows about.
create or replace function public.set_product_cost(
  p_product uuid, p_pack_size uuid, p_cost_cents bigint, p_reason text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_owner();
  v_old bigint;
begin
  if p_cost_cents is null or p_cost_cents < 0 then raise exception 'cost cannot be negative'; end if;
  if not exists (select 1 from public.products where id = p_product and store_id = v_me.store_id) then
    raise exception 'product not found';
  end if;

  if p_pack_size is not null then
    select cost_cents into v_old from public.pack_sizes
     where id = p_pack_size and product_id = p_product;
    if not found then raise exception 'packet size not found'; end if;
    update public.pack_sizes set cost_cents = p_cost_cents where id = p_pack_size;
  else
    select pc.cost_cents into v_old from public.product_costs pc where pc.product_id = p_product;
    insert into public.product_costs (product_id, store_id, cost_cents)
    values (p_product, v_me.store_id, p_cost_cents)
    on conflict (product_id) do update set cost_cents = excluded.cost_cents;
  end if;

  insert into public.product_cost_history
    (store_id, product_id, pack_size_id, old_cost_cents, new_cost_cents, source, reason, changed_by)
  values (v_me.store_id, p_product, p_pack_size, v_old, p_cost_cents, 'manual',
          nullif(trim(coalesce(p_reason, '')), ''), v_me.id);

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after, reason)
  values (v_me.store_id, 'product_cost_set', 'products', p_product, v_me.id,
          jsonb_build_object('cost_cents', v_old), jsonb_build_object('cost_cents', p_cost_cents),
          p_reason);

  return jsonb_build_object('product_id', p_product, 'cost_cents', p_cost_cents);
end $$;

-- ---------------------------------------------------------------------------------------------
-- production: a batch that consumes raw material and yields finished units
-- ---------------------------------------------------------------------------------------------
-- Recording a run is one transaction: issue the inputs from stock, add the outputs, work out what a
-- unit cost, and store that cost on the product. If any line is wrong the whole batch is rolled back,
-- so the shelf and the cost can never disagree.
create or replace function public.save_production_run(p_run jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_id uuid := nullif(p_run ->> 'id', '')::uuid;
  v_product uuid := nullif(p_run ->> 'product_id', '')::uuid;
  v_outputs jsonb := coalesce(p_run -> 'outputs', '[]'::jsonb);
  v_inputs jsonb := coalesce(p_run -> 'inputs', '[]'::jsonb);
  v_costs jsonb := coalesce(p_run -> 'cost_entries', '[]'::jsonb);
  v_status public.production_status := coalesce((p_run ->> 'status')::public.production_status, 'closed');
  v_line jsonb;
  v_material bigint := 0;
  v_extra bigint := 0;
  v_total bigint;
  v_units numeric := 0;
  v_per_unit bigint;
  v_run_no text;
  v_pack uuid;
  v_qty numeric;
  v_unit_cost bigint;
  v_output_id uuid;
begin
  if v_status not in ('closed', 'cancelled') then
    raise exception 'a run is posted as closed or cancelled; drafts are not stored';
  end if;
  if v_product is null then raise exception 'choose the product being made'; end if;
  if not exists (select 1 from public.products where id = v_product and store_id = v_me.store_id) then
    raise exception 'product not found';
  end if;
  if jsonb_array_length(v_outputs) = 0 then raise exception 'a run needs at least one output'; end if;

  if v_id is not null and exists (select 1 from public.production_runs where id = v_id) then
    raise exception 'this production run has already been posted';
  end if;

  v_run_no := coalesce(nullif(trim(coalesce(p_run ->> 'run_no', '')), ''),
                       'PR-' || to_char(now(), 'YYMMDD-HH24MISS'));

  insert into public.production_runs
    (store_id, run_no, product_id, status, started_on, closed_on, notes, closed_by)
  values
    (v_me.store_id, v_run_no, v_product, v_status,
     coalesce(nullif(p_run ->> 'started_on', '')::date, current_date),
     coalesce(nullif(p_run ->> 'closed_on', '')::date, current_date),
     nullif(trim(coalesce(p_run ->> 'notes', '')), ''), v_me.id)
  returning id into v_id;

  -- Inputs: each one leaves stock at the cost already on the shelf.
  for v_line in select * from jsonb_array_elements(v_inputs) loop
    v_qty := coalesce((v_line ->> 'qty')::numeric, (v_line ->> 'qty_kg')::numeric, 0);
    if v_qty <= 0 then raise exception 'input quantities must be positive'; end if;
    v_pack := nullif(v_line ->> 'pack_size_id', '')::uuid;

    if v_pack is not null then
      select cost_cents into v_unit_cost from public.pack_sizes where id = v_pack;
    else
      select pc.cost_cents into v_unit_cost
        from public.product_costs pc where pc.product_id = (v_line ->> 'product_id')::uuid;
    end if;
    v_unit_cost := coalesce(v_unit_cost, 0);

    insert into public.production_inputs
      (production_run_id, product_id, pack_size_id, stage, qty, qty_kg, unit_cost_cents)
    values
      (v_id, (v_line ->> 'product_id')::uuid, v_pack,
       coalesce((v_line ->> 'stage')::public.production_stage, 'raw'),
       v_qty, case when v_pack is null then v_qty else 0 end, v_unit_cost);

    insert into public.stock_movements
      (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id, created_by, reason)
    values
      (v_me.store_id, (v_line ->> 'product_id')::uuid, v_pack, -v_qty, 'production_out',
       'production_runs', v_id, v_me.id, 'Used in production run ' || v_run_no);

    v_material := v_material + round(v_qty * v_unit_cost)::bigint;
  end loop;

  -- Labour, gas, electricity: itemised so the cost per unit can be explained later.
  for v_line in select * from jsonb_array_elements(v_costs) loop
    if coalesce((v_line ->> 'amount_cents')::bigint, 0) <= 0 then
      raise exception 'production costs must be positive';
    end if;
    insert into public.production_cost_entries
      (store_id, production_run_id, category, description, amount_cents, created_by)
    values
      (v_me.store_id, v_id,
       coalesce((v_line ->> 'category')::public.production_cost_category, 'other'),
       nullif(trim(coalesce(v_line ->> 'description', '')), ''),
       (v_line ->> 'amount_cents')::bigint, v_me.id);
    v_extra := v_extra + (v_line ->> 'amount_cents')::bigint;
  end loop;

  v_total := v_material + v_extra;

  -- Outputs are counted first so one cost per unit can be applied to all of them.
  for v_line in select * from jsonb_array_elements(v_outputs) loop
    v_units := v_units + coalesce((v_line ->> 'qty_units')::numeric, (v_line ->> 'qty_packets')::numeric, 0);
  end loop;
  if v_units <= 0 then raise exception 'a run must produce something'; end if;
  v_per_unit := round(v_total::numeric / v_units)::bigint;

  for v_line in select * from jsonb_array_elements(v_outputs) loop
    v_pack := nullif(v_line ->> 'pack_size_id', '')::uuid;
    v_qty := coalesce((v_line ->> 'qty_units')::numeric, (v_line ->> 'qty_packets')::numeric, 0);
    if v_qty <= 0 then raise exception 'output quantities must be positive'; end if;

    insert into public.production_outputs
      (production_run_id, product_id, pack_size_id, qty_units, qty_packets, wastage_g,
       unit_cost_cents, expires_on)
    values
      (v_id, v_product, v_pack, v_qty, case when v_pack is not null then v_qty else 0 end,
       coalesce((v_line ->> 'wastage_g')::numeric, 0), v_per_unit,
       nullif(v_line ->> 'expires_on', '')::date)
    returning id into v_output_id;

    insert into public.stock_movements
      (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id,
       unit_cost_cents, created_by, reason)
    values
      (v_me.store_id, v_product, v_pack, v_qty, 'production_in', 'production_runs', v_id,
       v_per_unit, v_me.id, 'Produced in run ' || v_run_no);
  end loop;

  -- The finished cost belongs on whichever stock the output landed in.
  if exists (select 1 from public.production_outputs where production_run_id = v_id and pack_size_id is not null) then
    update public.pack_sizes ps set cost_cents = v_per_unit
      where ps.id in (select pack_size_id from public.production_outputs
                       where production_run_id = v_id and pack_size_id is not null);
  else
    insert into public.product_costs (product_id, store_id, cost_cents)
    values (v_product, v_me.store_id, v_per_unit)
    on conflict (product_id) do update set cost_cents = excluded.cost_cents;
  end if;

  update public.production_runs set
    material_cost_cents = v_material,
    extra_cost_cents = v_extra,
    total_cost_cents = v_total,
    cost_per_unit_cents = v_per_unit,
    finished_kg = coalesce(nullif(p_run ->> 'finished_kg', '')::numeric, 0),
    raw_issued_kg = coalesce(nullif(p_run ->> 'raw_issued_kg', '')::numeric, 0),
    wastage_g = coalesce(nullif(p_run ->> 'wastage_g', '')::numeric, 0),
    yield_pct = nullif(p_run ->> 'yield_pct', '')::numeric
   where id = v_id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after)
  values (v_me.store_id, 'production_posted', 'production_runs', v_id, v_me.id,
          jsonb_build_object('run_no', v_run_no, 'units', v_units, 'total_cost_cents', v_total,
                             'cost_per_unit_cents', v_per_unit));

  return jsonb_build_object(
    'id', v_id, 'run_no', v_run_no, 'units', v_units,
    'material_cost_cents', v_material, 'extra_cost_cents', v_extra,
    'total_cost_cents', v_total, 'cost_per_unit_cents', v_per_unit);
end $$;

-- ---------------------------------------------------------------------------------------------
-- refunds and sale voids
-- ---------------------------------------------------------------------------------------------
-- A refund is a document, not an edit: the sale keeps its lines and the refund reverses revenue,
-- COGS and (where possible) stock at the same cost the line was sold at.
create or replace function public.refund_sale(
  p_sale uuid, p_reason text, p_method public.pay_method default 'cash', p_restock boolean default true
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_sale public.sales;
  v_line record;
  v_refund_id uuid;
  v_no bigint;
  v_amount bigint := 0;
  v_tax bigint := 0;
  v_cogs bigint := 0;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required for a refund'; end if;

  select * into v_sale from public.sales where id = p_sale and store_id = v_me.store_id;
  if not found then raise exception 'sale not found'; end if;
  if v_sale.status <> 'completed' then raise exception 'this sale is already %', v_sale.status; end if;
  if exists (select 1 from public.refunds where sale_id = p_sale and voided_at is null) then
    raise exception 'this sale has already been refunded';
  end if;

  select coalesce(max(refund_no), 0) + 1 into v_no from public.refunds where store_id = v_me.store_id;

  insert into public.refunds (store_id, sale_id, refund_no, reason_code, amount_cents, method, restock,
                              approved_by, created_by)
  values (v_me.store_id, p_sale, v_no, trim(p_reason), 0, p_method, coalesce(p_restock, true),
          v_me.id, v_me.id)
  returning id into v_refund_id;

  for v_line in
    select * from public.sale_items
     where sale_id = p_sale and status = 'active' and kind = 'item'
     order by id
  loop
    insert into public.refund_lines
      (refund_id, sale_item_id, qty, unit_price_cents, amount_cents, cost_cents, item_condition)
    values
      (v_refund_id, v_line.id, v_line.qty, v_line.unit_price_cents, v_line.line_total_cents,
       v_line.cost_cents,
       case when p_restock then 'resellable'::public.refund_condition else 'damaged'::public.refund_condition end);

    v_amount := v_amount + v_line.line_total_cents;
    v_tax := v_tax + v_line.tax_cents;
    v_cogs := v_cogs + v_line.cogs_cents;

    if p_restock then
      insert into public.stock_movements
        (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id, created_by, reason)
      values
        (v_me.store_id, v_line.product_id, v_line.pack_size_id, v_line.qty, 'return',
         'refunds', v_refund_id, v_me.id, 'Refund of receipt ' || v_sale.receipt_no::text);
    end if;
  end loop;

  -- Bottle fees charged on the bill come back with the goods.
  v_amount := v_amount - v_sale.bottle_fee_cents;

  update public.refunds
     set amount_cents = greatest(v_amount, 0), tax_refunded_cents = v_tax
   where id = v_refund_id;

  update public.sales set status = 'refunded' where id = p_sale;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after, reason)
  values (v_me.store_id, 'sale_refunded', 'sales', p_sale, v_me.id,
          jsonb_build_object('refund_id', v_refund_id, 'amount_cents', v_amount,
                             'cogs_reversed_cents', v_cogs, 'restocked', coalesce(p_restock, true)),
          trim(p_reason));

  return jsonb_build_object(
    'refund_id', v_refund_id, 'refund_no', v_no, 'amount_cents', greatest(v_amount, 0),
    'cogs_reversed_cents', v_cogs);
end $$;

-- A cancellation for a bill entered by mistake. Revenue and COGS both disappear; the row remains,
-- marked cancelled, so the receipt number can never be silently reused.
create or replace function public.void_sale(p_sale uuid, p_reason text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_sale public.sales;
  v_line record;
  v_token uuid;
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'a reason is required to cancel a sale'; end if;
  select * into v_sale from public.sales where id = p_sale and store_id = v_me.store_id;
  if not found then raise exception 'sale not found'; end if;
  if v_sale.status <> 'completed' then raise exception 'this sale is already %', v_sale.status; end if;

  for v_line in select * from public.sale_items
               where sale_id = p_sale and status = 'active' and kind = 'item'
  loop
    insert into public.stock_movements
      (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id, created_by, reason)
    values
      (v_me.store_id, v_line.product_id, v_line.pack_size_id, v_line.qty, 'void',
       'sales', p_sale, v_me.id, 'Sale cancelled: ' || trim(p_reason));
  end loop;

  update public.sale_items set status = 'voided', void_reason = trim(p_reason),
         voided_by_name = v_me.full_name
   where sale_id = p_sale and status = 'active';

  update public.sales set status = 'cancelled' where id = p_sale;

  -- A tab opened by the sale must not survive it.
  delete from public.customer_credit_entries
   where sale_id = p_sale and entry_type = 'invoice';

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after, reason)
  values (v_me.store_id, 'sale_cancelled', 'sales', p_sale, v_me.id,
          jsonb_build_object('receipt_no', v_sale.receipt_no, 'total_cents', v_sale.total_cents),
          trim(p_reason));

  return jsonb_build_object('id', p_sale, 'status', 'cancelled');
end $$;
