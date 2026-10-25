-- Bottle deposits go through a bill, and every bottle number survives a refund or a cancellation.
--
-- 0026 made bottles a pure loan, but the change to complete_sale was written into 0019, which a live
-- database had already applied. A migration runs once, so a deployed shop kept the old function -
-- the one that writes a `fee_waived` row and a "bottle fee waived" audit entry for every bottle a
-- current till sells. The function is redefined HERE instead, and 0019 is left as it shipped.
--
-- It also closes four holes in how a bottle becomes money:
--
--   1. charge_bottle_fee() took a deposit as a ledger row only. No sale, no payment, no drawer: the
--      cashier held LKR 100 the shift report did not know about, and finance never saw it. A deposit
--      is now a `bottle_fee` line on the bill, so it is in the sale's subtotal, its payments and the
--      shift's cash. complete_sale settles the loan from that line. charge_bottle_fee() is no longer
--      callable by the app.
--   2. Any signed-in user could INSERT into bottle_ledger directly (0007), which skipped every guard
--      return_bottles() enforces. All writes now go through security-definer functions.
--   3. `bottles_returned` in the sale payload was trusted as-is, so a payload could wipe a
--      customer's debt. It is capped at what the customer actually owes.
--   4. A refunded or cancelled sale left its bottle loan in place: the customer kept owing a bottle
--      for milk the shop took back. The loan is now reversed with a negative row - the ledger stays
--      append-only, and every SUM over it stays right.
--
-- refund_sale() also subtracted the bill's bottle fee from the refund, although the refund is built
-- from item lines only and never included that fee. The customer was short-changed by the deposit.

-- -- 1. no direct writes to the ledger ---------------------------------------------------------
drop policy if exists bottle_ledger_insert on public.bottle_ledger;
revoke insert on public.bottle_ledger from authenticated;

-- -- 2. what a customer owes, without needing a resolved caller ------------------------------
-- customer_bottles_outstanding() resolves the store from the caller. Code that already knows the
-- store (a sale, a refund) uses this, so the rule lives in one expression for the server side.
create or replace function public.bottles_owed(p_store uuid, p_customer uuid)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce(sum(case
           when l.event = 'sold' then l.qty
           when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged') then -l.qty
           else 0
         end), 0)::int
    from public.bottle_ledger l
   where l.store_id = p_store and l.customer_id = p_customer
$$;

-- -- 3. complete_sale ---------------------------------------------------------------------------
create or replace function public.complete_sale(p_sale jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_profile public.profiles;
  v_store public.stores;
  v_id uuid := (p_sale ->> 'id')::uuid;
  v_receipt bigint;
  v_line jsonb;
  v_pay jsonb;
  v_subtotal bigint := 0;
  v_expected bigint;
  v_paid bigint := 0;
  v_credit bigint := 0;
  v_discount bigint := coalesce((p_sale ->> 'discount_cents')::bigint, 0);
  v_total bigint := (p_sale ->> 'total_cents')::bigint;
  v_cashier uuid;
  v_customer uuid := nullif(p_sale ->> 'customer_id', '')::uuid;
  v_customer_row public.customers;
  v_balance bigint;
  v_points int := 0;
  v_bottle_qty int := 0;
  v_fee_cents bigint := 0;
  v_returned int := greatest(coalesce((p_sale ->> 'bottles_returned')::int, 0), 0);
  v_owed int;
  v_take int;
  v_qty numeric;
  v_is_bottle boolean;
  v_fee_product uuid;
begin
  select * into v_profile from public.profiles where auth_user_id = auth.uid() and is_active;
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into v_store from public.stores where id = v_profile.store_id;

  if v_id is null then raise exception 'sale id is required'; end if;

  select receipt_no into v_receipt from public.sales where id = v_id and store_id = v_profile.store_id;
  if found then
    return jsonb_build_object('sale_id', v_id, 'receipt_no', v_receipt, 'status', 'duplicate');
  end if;

  if v_customer is not null then
    select * into v_customer_row from public.customers
     where id = v_customer and store_id = v_profile.store_id;
    if not found then raise exception 'unknown customer'; end if;
  end if;

  -- recompute money from the lines; never trust the client's totals
  for v_line in select * from jsonb_array_elements(coalesce(p_sale -> 'lines', '[]'::jsonb)) loop
    v_qty := (v_line ->> 'qty')::numeric;
    if v_qty <= 0 then raise exception 'line quantity must be positive'; end if;
    if abs(round(v_qty * (v_line ->> 'unit_price_cents')::numeric) - (v_line ->> 'line_total_cents')::numeric) > 1 then
      raise exception 'line total does not match quantity x price for %', v_line ->> 'name';
    end if;
    v_subtotal := v_subtotal + (v_line ->> 'line_total_cents')::bigint;

    if coalesce(v_line ->> 'kind', 'item') = 'item' then
      select is_returnable_bottle into v_is_bottle from public.products
       where id = (v_line ->> 'product_id')::uuid and store_id = v_profile.store_id;
      if v_is_bottle then v_bottle_qty := v_bottle_qty + v_qty::int; end if;
    else
      v_fee_cents := v_fee_cents + (v_line ->> 'line_total_cents')::bigint;
      -- A current till names the bottle a deposit is for. It must be one of ours, or the deposit
      -- would settle a loan against another shop's product. A line from an older till names none.
      v_fee_product := nullif(v_line ->> 'product_id', '')::uuid;
      if v_fee_product is not null and not exists (
        select 1 from public.products
         where id = v_fee_product and store_id = v_profile.store_id and is_returnable_bottle
      ) then
        raise exception 'unknown product, or it does not come in a returnable bottle';
      end if;
    end if;
  end loop;

  if v_subtotal = 0 and jsonb_array_length(coalesce(p_sale -> 'lines', '[]'::jsonb)) = 0 then
    raise exception 'a sale needs at least one line';
  end if;
  if v_discount < 0 or v_discount > v_subtotal then raise exception 'invalid discount'; end if;
  v_expected := v_subtotal - v_discount;
  if v_total is distinct from v_expected then
    raise exception 'sale total % does not match its lines (expected %)', v_total, v_expected;
  end if;

  for v_pay in select * from jsonb_array_elements(coalesce(p_sale -> 'payments', '[]'::jsonb)) loop
    if (v_pay ->> 'method') = 'credit' then
      v_credit := v_credit + (v_pay ->> 'amount_cents')::bigint;
    end if;
    v_paid := v_paid + (v_pay ->> 'amount_cents')::bigint;
  end loop;
  if v_paid <> v_total then raise exception 'payments (%) do not add up to the total (%)', v_paid, v_total; end if;

  -- A tab needs a person to collect from, a limit to stay under, and a shop willing to lend.
  if v_credit > 0 then
    if v_customer is null then raise exception 'a credit sale needs a customer'; end if;
    if v_customer_row.is_blocked then raise exception 'this customer is blocked from credit' using errcode = '42501'; end if;
    if v_customer_row.credit_limit_cents <= 0 then
      raise exception 'this customer has no credit limit' using errcode = '42501';
    end if;
    v_balance := public.customer_credit_balance(v_customer);
    if v_balance + v_credit > v_customer_row.credit_limit_cents then
      raise exception 'credit limit exceeded: % outstanding, % limit, % more requested',
        v_balance, v_customer_row.credit_limit_cents, v_credit using errcode = '42501';
    end if;
  end if;

  v_cashier := nullif(p_sale ->> 'cashier_id', '')::uuid;
  if v_cashier is not null and not exists (
    select 1 from public.profiles where id = v_cashier and store_id = v_profile.store_id
  ) then
    raise exception 'unknown cashier';
  end if;

  -- Empties handed back with the bill can never exceed what is owed: the customer's existing loans
  -- plus the bottles on this bill, or for a walk-in, the bottles on this bill alone.
  v_owed := v_bottle_qty
            + case when v_customer is null then 0 else greatest(public.bottles_owed(v_profile.store_id, v_customer), 0) end;
  v_returned := least(v_returned, v_owed);
  v_owed := v_owed - v_returned;

  insert into public.sales (id, store_id, local_receipt_no, cashier_id, recorded_by, subtotal_cents, discount_cents,
                            total_cents, tax_included_cents, bottles_returned, bottle_fee_cents, created_at, customer_id)
  values (v_id, v_profile.store_id, nullif(p_sale ->> 'local_receipt_no', '')::bigint, coalesce(v_cashier, v_profile.id),
          v_profile.id, v_subtotal, v_discount, v_total, coalesce((p_sale ->> 'tax_included_cents')::bigint, 0),
          v_returned, v_fee_cents,
          coalesce((p_sale ->> 'created_at')::timestamptz, now()), v_customer)
  returning receipt_no into v_receipt;

  for v_line in select * from jsonb_array_elements(p_sale -> 'lines') loop
    insert into public.sale_items (sale_id, product_id, pack_size_id, kind, name_snapshot, label_snapshot, qty,
                                   unit_price_cents, tax_rate_pct, tax_cents, line_total_cents)
    values (v_id, nullif(v_line ->> 'product_id', '')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid,
            coalesce(v_line ->> 'kind', 'item')::public.line_kind, v_line ->> 'name', v_line ->> 'label',
            (v_line ->> 'qty')::numeric, (v_line ->> 'unit_price_cents')::bigint,
            coalesce((v_line ->> 'tax_rate_pct')::numeric, 0), coalesce((v_line ->> 'tax_cents')::bigint, 0),
            (v_line ->> 'line_total_cents')::bigint);

    if coalesce(v_line ->> 'kind', 'item') = 'item' then
      insert into public.stock_movements (store_id, product_id, pack_size_id, qty_change, type, ref_table, ref_id, created_by)
      values (v_profile.store_id, (v_line ->> 'product_id')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid,
              -(v_line ->> 'qty')::numeric, 'sale', 'sales', v_id, v_profile.id);

      select is_returnable_bottle into v_is_bottle from public.products where id = (v_line ->> 'product_id')::uuid;
      if v_is_bottle then
        insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, created_by, customer_id)
        values (v_profile.store_id, (v_line ->> 'product_id')::uuid, v_id, 'sold',
                (v_line ->> 'qty')::numeric::int, v_profile.id, v_customer);
      end if;
    else
      -- A deposit taken on this bill: the customer keeps a bottle and pays for it, which settles
      -- that loan. The money is already in the total. The ledger records what was actually paid,
      -- not today's fee, so it can never disagree with the payments.
      v_qty := (v_line ->> 'qty')::numeric;
      v_take := case when v_customer is null then v_qty::int else least(v_qty::int, greatest(v_owed, 0)) end;
      if v_take > 0 then
        insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, amount_cents, created_by, customer_id)
        values (v_profile.store_id, nullif(v_line ->> 'product_id', '')::uuid, v_id, 'fee_charged', v_take,
                round((v_line ->> 'line_total_cents')::numeric * v_take / v_qty)::bigint, v_profile.id, v_customer);
        v_owed := v_owed - v_take;
      end if;
      -- An offline till can take a deposit for a bottle that was handed back elsewhere meanwhile.
      -- The money is real, so the sale stands; the ledger is not charged twice, and the owner is
      -- asked to look at it rather than the sale being refused.
      if v_take < v_qty::int then
        insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, reason)
        values (v_profile.store_id, 'bottle_deposit_excess', 'sales', v_id, v_profile.id,
                (v_qty::int - v_take)::text || ' deposit(s) taken for bottles this customer no longer owed');
      end if;
    end if;
  end loop;

  for v_line in select * from jsonb_array_elements(coalesce(p_sale -> 'voided', '[]'::jsonb)) loop
    insert into public.sale_items (sale_id, product_id, pack_size_id, kind, name_snapshot, label_snapshot, qty,
                                   unit_price_cents, line_total_cents, status, void_reason, voided_by_name)
    values (v_id, nullif(v_line ->> 'product_id', '')::uuid, nullif(v_line ->> 'pack_size_id', '')::uuid, 'item',
            v_line ->> 'name', v_line ->> 'label', (v_line ->> 'qty')::numeric,
            coalesce((v_line ->> 'unit_price_cents')::bigint, 0),
            round((v_line ->> 'qty')::numeric * coalesce((v_line ->> 'unit_price_cents')::numeric, 0))::bigint,
            'voided', v_line ->> 'reason', v_line ->> 'by');
    insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, reason, after)
    values (v_profile.store_id, 'line_voided', 'sales', v_id, v_profile.id, v_line ->> 'reason', v_line);
  end loop;

  for v_pay in select * from jsonb_array_elements(p_sale -> 'payments') loop
    insert into public.payments (sale_id, method, amount_cents, tendered_cents, change_cents, reference)
    values (v_id, (v_pay ->> 'method')::public.pay_method, (v_pay ->> 'amount_cents')::bigint,
            nullif(v_pay ->> 'tendered_cents', '')::bigint, nullif(v_pay ->> 'change_cents', '')::bigint,
            v_pay ->> 'reference');
  end loop;

  -- The tab itself. due_on follows the shop's agreed terms, so "who is overdue" is answerable.
  if v_credit > 0 then
    insert into public.customer_credit_entries
      (store_id, customer_id, entry_type, sale_id, amount_cents, due_on, created_by)
    values (v_profile.store_id, v_customer, 'invoice', v_id, v_credit,
            case when v_customer_row.credit_terms_days > 0
                 then current_date + v_customer_row.credit_terms_days else null end,
            v_profile.id);
  end if;

  if v_returned > 0 then
    insert into public.bottle_ledger (store_id, sale_id, event, qty, created_by, customer_id)
    values (v_profile.store_id, v_id, 'returned_with_purchase', v_returned, v_profile.id, v_customer);
  end if;
  -- Nothing is waived here. A bottle sold without a deposit is a loan, and a loan is not a waiver.

  v_points := public.earn_points(v_profile.store_id, v_customer, v_id, v_total);

  return jsonb_build_object(
    'sale_id', v_id,
    'receipt_no', v_receipt,
    'status', 'created',
    'points_earned', v_points,
    'customer_name', v_customer_row.name,
    'credit_balance_cents', case when v_customer is null then 0 else public.customer_credit_balance(v_customer) end
  );
end $$;

-- -- 4. undoing a sale's bottles -----------------------------------------------------------------
/**
 * Reverse what a sale did to the bottle book, with negative rows (the ledger is append-only).
 *
 * A refund takes the goods back, so the loan those goods started is cancelled - but nothing else:
 * a deposit paid on that bill was a separate settlement and is not refunded. A cancellation erases
 * the whole bill, so its returns and deposits are reversed too.
 *
 * A loan is reversed only as far as it is still owed. A customer who already handed the bottle
 * back must not end up owed a bottle by the shop.
 */
create or replace function public.reverse_sale_bottles(p_sale uuid, p_everything boolean)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row public.bottle_ledger;
  v_take int;
begin
  if p_everything then
    insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, amount_cents, created_by, customer_id)
    select l.store_id, l.product_id, l.sale_id, l.event, -l.qty, -l.amount_cents, public.app_profile_id(), l.customer_id
      from public.bottle_ledger l
     where l.sale_id = p_sale and l.event <> 'sold' and l.qty > 0;
  end if;

  for v_row in
    select * from public.bottle_ledger where sale_id = p_sale and event = 'sold' and qty > 0 order by created_at
  loop
    v_take := case when v_row.customer_id is null then v_row.qty
                   else least(v_row.qty, greatest(public.bottles_owed(v_row.store_id, v_row.customer_id), 0)) end;
    if v_take > 0 then
      insert into public.bottle_ledger (store_id, product_id, sale_id, event, qty, amount_cents, created_by, customer_id)
      values (v_row.store_id, v_row.product_id, p_sale, 'sold', -v_take, 0, public.app_profile_id(), v_row.customer_id);
    end if;
  end loop;
end $$;

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

  -- The refund is the item lines and nothing else. A deposit on the bill was never among them, so
  -- there is nothing to take off: 0022 subtracted it here and short-changed the customer by it.

  update public.refunds
     set amount_cents = greatest(v_amount, 0), tax_refunded_cents = v_tax
   where id = v_refund_id;

  update public.sales set status = 'refunded' where id = p_sale;

  -- The goods came back, so the bottles they went out in are no longer owed.
  perform public.reverse_sale_bottles(p_sale, false);

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

  -- Nor may its bottles: the loans, the empties and the deposits on it never happened.
  perform public.reverse_sale_bottles(p_sale, true);

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, after, reason)
  values (v_me.store_id, 'sale_cancelled', 'sales', p_sale, v_me.id,
          jsonb_build_object('receipt_no', v_sale.receipt_no, 'total_cents', v_sale.total_cents),
          trim(p_reason));

  return jsonb_build_object('id', p_sale, 'status', 'cancelled');
end $$;

-- -- 5. the bottle book ---------------------------------------------------------------------------
/**
 * Shop-wide totals, for the head of /bottles.
 *
 * The screen used to add up customer_bottle_summary(), which by default lists only customers still
 * owing, capped at a page. Everyone who had handed every bottle back was missing from "given out"
 * and "came back", so the return rate read far worse than it was. These totals cover every
 * customer. Walk-in bottles are reported apart: they move the shop's stock of bottles, but there is
 * no one to attribute them to.
 */
create or replace function public.bottle_totals()
returns table (
  sent_out        int,
  returned        int,
  charged         int,
  waived          int,
  outstanding     int,
  customers_owing int,
  walk_in_out     int
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;

  return query
  with per as (
    select l.customer_id,
           sum(case when l.event = 'sold' then l.qty else 0 end) as sent_out,
           sum(case when l.event in ('returned_with_purchase', 'returned_later') then l.qty else 0 end) as returned,
           sum(case when l.event = 'fee_charged' then l.qty else 0 end) as charged,
           sum(case when l.event = 'fee_waived' then l.qty else 0 end) as waived
      from public.bottle_ledger l
     where l.store_id = v_store
     group by l.customer_id
  )
  select coalesce(sum(p.sent_out) filter (where p.customer_id is not null), 0)::int,
         coalesce(sum(p.returned) filter (where p.customer_id is not null), 0)::int,
         coalesce(sum(p.charged) filter (where p.customer_id is not null), 0)::int,
         coalesce(sum(p.waived) filter (where p.customer_id is not null), 0)::int,
         coalesce(sum(greatest(0, p.sent_out - p.returned - p.charged))
                    filter (where p.customer_id is not null), 0)::int,
         (count(*) filter (where p.customer_id is not null and p.sent_out - p.returned - p.charged > 0))::int,
         coalesce(sum(greatest(0, p.sent_out - p.returned - p.charged)) filter (where p.customer_id is null), 0)::int
    from per p;
end $$;

/**
 * Same as 0026, except that "last out" and "last back" ignore the negative rows a refund or a
 * cancellation writes. Otherwise refunding a bill would date a customer's last bottle to the refund.
 */
create or replace function public.customer_bottle_summary(
  p_only_outstanding boolean default true,
  p_limit            int default 200
) returns table (
  customer_id   uuid,
  name          text,
  phone         text,
  sent_out      int,
  returned      int,
  charged       int,
  waived        int,
  outstanding   int,
  worth_cents   bigint,
  last_out_at   timestamptz,
  last_return_at timestamptz
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid := public.app_store_id();
  v_fee bigint;
begin
  if v_store is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select bottle_fee_cents into v_fee from public.stores where id = v_store;

  return query
  select t.customer_id, t.name, t.phone, t.sent_out, t.returned, t.charged, t.waived,
         t.outstanding, t.outstanding::bigint * coalesce(v_fee, 0) as worth_cents,
         t.last_out_at, t.last_return_at
    from (
      select c.id as customer_id,
             c.name,
             c.phone,
             coalesce(g.sent_out, 0)::int as sent_out,
             coalesce(g.returned, 0)::int as returned,
             coalesce(g.charged, 0)::int as charged,
             coalesce(g.waived, 0)::int as waived,
             greatest(0, coalesce(g.sent_out, 0) - coalesce(g.returned, 0) - coalesce(g.charged, 0))::int
               as outstanding,
             g.last_out_at,
             g.last_return_at
        from public.customers c
        join (
          select l.customer_id,
                 sum(case when l.event = 'sold' then l.qty else 0 end) as sent_out,
                 sum(case when l.event in ('returned_with_purchase', 'returned_later')
                          then l.qty else 0 end) as returned,
                 sum(case when l.event = 'fee_charged' then l.qty else 0 end) as charged,
                 sum(case when l.event = 'fee_waived' then l.qty else 0 end) as waived,
                 max(case when l.event = 'sold' and l.qty > 0 then l.created_at end) as last_out_at,
                 max(case when l.event in ('returned_with_purchase', 'returned_later', 'fee_charged')
                           and l.qty > 0
                          then l.created_at end) as last_return_at
            from public.bottle_ledger l
           where l.store_id = v_store and l.customer_id is not null
           group by l.customer_id
        ) g on g.customer_id = c.id
       where c.store_id = v_store
    ) t
   where not coalesce(p_only_outstanding, true) or t.outstanding > 0
   order by t.outstanding desc, coalesce(t.last_return_at, t.last_out_at) desc nulls last, t.name
   limit greatest(coalesce(p_limit, 200), 1);
end $$;

-- -- 6. grants ----------------------------------------------------------------------------------
-- charge_bottle_fee() stays defined (an old till may still be open) but nothing may call it: a
-- deposit taken outside a bill is money the books cannot see. The internal helpers are callable
-- only from the functions above, which run as their owner.
revoke all on function
  public.charge_bottle_fee(uuid, uuid, int),
  public.bottles_owed(uuid, uuid),
  public.reverse_sale_bottles(uuid, boolean),
  public.bottle_totals(),
  public.customer_bottle_summary(boolean, int)
  from public, anon, authenticated;

grant execute on function
  public.bottle_totals(),
  public.customer_bottle_summary(boolean, int)
  to authenticated;
