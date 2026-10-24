-- Finance reports.
--
-- Every figure the dashboard shows comes from here. The rules are written once, in SQL, so a number
-- quoted to an accountant can be reproduced from the database alone and two screens can never
-- disagree about the same period.
--
-- THE SIX RULES, stated once:
--
--   1. REVENUE IS NOT CASH. Revenue is what was sold (accrual); collections are what was received
--      (`payments`, plus settlements against credit tabs). They are reported separately because a
--      shop can sell all month and collect nothing.
--   2. A REFUND REVERSES IN ITS OWN PERIOD. A sale keeps its revenue in the month it happened even
--      after it is refunded, and the refund appears in the month the money went back. Past reports
--      therefore never change retroactively. A CANCELLATION (`void_sale`) removes the bill entirely,
--      because a cancellation corrects a keying error rather than recording a business event.
--   3. COGS IS THE COST AT THE TIME OF SALE (`sale_items.cogs_cents`, frozen by a trigger in 0021),
--      never today's purchase price. Lines with no recorded cost are reported separately as
--      `unknown_cost_lines`; they are NOT silently treated as free, so the summary is flagged as an
--      estimate when they exist.
--   4. AN INVENTORY PURCHASE IS NOT AN EXPENSE. It is a stock movement plus a payable. It reaches the
--      profit figures through COGS when the goods are sold. Only `expenses` reduces profit directly.
--   5. CAPITAL EXPENDITURE IS NOT AN OPERATING EXPENSE. `expenses.kind = 'capital'` is reported apart
--      so buying a freezer does not make one month look loss-making.
--   6. A LOSS IS A NEGATIVE NUMBER. Nothing is clamped to zero: a product sold below cost, or a
--      month that lost money, must be visible as such.

-- ---------------------------------------------------------------------------------------------
-- the headline figures
-- ---------------------------------------------------------------------------------------------
create or replace function public.finance_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_store public.stores;
  v_start timestamptz := p_from::timestamptz;
  v_end timestamptz := (p_to + 1)::timestamptz;

  v_gross bigint := 0;
  v_discounts bigint := 0;
  v_bills int := 0;
  v_refunded_bills int := 0;
  v_cancelled_bills int := 0;

  v_refunds bigint := 0;
  v_tax_refunded bigint := 0;
  v_cogs_reversed bigint := 0;

  v_line_revenue bigint := 0;
  v_cogs bigint := 0;
  v_unknown int := 0;
  v_output_vat bigint := 0;

  v_collected bigint := 0;
  v_settled bigint := 0;

  v_operating bigint := 0;
  v_capital bigint := 0;
  v_expense_vat bigint := 0;
  v_unpaid_expenses bigint := 0;
  v_expense_count int := 0;

  v_purchase_net bigint := 0;
  v_purchase_vat bigint := 0;
  v_purchase_unpaid bigint := 0;
  v_purchase_count int := 0;

  v_receivables bigint := 0;
  v_payables bigint := 0;
  v_inventory bigint := 0;
  v_uncosted int := 0;

  v_net_sales bigint;
  v_gross_profit bigint;
  v_net_profit bigint;
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_me.role not in ('owner', 'supervisor') then
    raise exception 'financial reports are for the owner and supervisors' using errcode = '42501';
  end if;
  select * into v_store from public.stores where id = v_me.store_id;

  -- sales in the period. A cancelled bill is a corrected error, so it contributes nothing to revenue;
  -- it is counted separately so the dashboard can still show that the correction happened.
  select coalesce(sum(s.subtotal_cents) filter (where s.status <> 'cancelled'), 0),
         coalesce(sum(s.discount_cents) filter (where s.status <> 'cancelled'), 0),
         count(*) filter (where s.status <> 'cancelled'),
         count(*) filter (where s.status = 'refunded'),
         count(*) filter (where s.status = 'cancelled')
    into v_gross, v_discounts, v_bills, v_refunded_bills, v_cancelled_bills
    from public.sales s
   where s.store_id = v_me.store_id
     and s.created_at >= v_start and s.created_at < v_end;

  -- what the sold goods cost, frozen at sale time
  select coalesce(sum(si.line_total_cents), 0),
         coalesce(sum(si.cogs_cents), 0),
         count(*) filter (where si.cost_cents is null),
         coalesce(sum(si.tax_cents), 0)
    into v_line_revenue, v_cogs, v_unknown, v_output_vat
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
   where s.store_id = v_me.store_id
     and s.status <> 'cancelled'
     and si.status = 'active' and si.kind = 'item'
     and s.created_at >= v_start and s.created_at < v_end;

  -- refunds given back during the period, at the cost the goods were originally sold for
  select coalesce(sum(rf.amount_cents), 0),
         coalesce(sum(rf.tax_refunded_cents), 0)
    into v_refunds, v_tax_refunded
    from public.refunds rf
   where rf.store_id = v_me.store_id
     and rf.voided_at is null
     and rf.created_at >= v_start and rf.created_at < v_end;

  select coalesce(sum(rl.cost_cents * rl.qty), 0)
    into v_cogs_reversed
    from public.refund_lines rl
    join public.refunds r2 on r2.id = rl.refund_id
   where r2.store_id = v_me.store_id and r2.voided_at is null
     and r2.created_at >= v_start and r2.created_at < v_end
     and rl.cost_cents is not null;

  -- money actually received at the counter. A credit line is a promise, not a receipt.
  select coalesce(sum(p.amount_cents), 0)
    into v_collected
    from public.payments p
    join public.sales s on s.id = p.sale_id
   where s.store_id = v_me.store_id
     and s.status <> 'cancelled'
     and p.method <> 'credit'
     and s.created_at >= v_start and s.created_at < v_end;

  -- ...plus tabs paid off later
  select coalesce(sum(-e.amount_cents), 0)
    into v_settled
    from public.customer_credit_entries e
   where e.store_id = v_me.store_id
     and e.entry_type = 'settlement'
     and e.created_at >= v_start and e.created_at < v_end;

  -- operating and capital kept apart; tax excluded from both so expenses and input VAT never double
  select coalesce(sum(case when kind = 'operating' then amount_cents - tax_cents else 0 end), 0),
         coalesce(sum(case when kind = 'capital' then amount_cents - tax_cents else 0 end), 0),
         coalesce(sum(tax_cents), 0),
         coalesce(sum(amount_cents - paid_cents) filter (where status <> 'void'), 0),
         count(*) filter (where status <> 'void')
    into v_operating, v_capital, v_expense_vat, v_unpaid_expenses, v_expense_count
    from public.expenses
   where store_id = v_me.store_id
     and voided_at is null
     and expense_on >= p_from and expense_on <= p_to;

  select coalesce(sum(gr.total_cents - gr.input_vat_cents), 0),
         coalesce(sum(gr.input_vat_cents), 0),
         coalesce(sum(gr.total_cents - gr.paid_cents), 0),
         count(*)
    into v_purchase_net, v_purchase_vat, v_purchase_unpaid, v_purchase_count
    from public.goods_receipts gr
   where gr.store_id = v_me.store_id
     and gr.voided_at is null
     and gr.received_on >= p_from and gr.received_on <= p_to;

  select coalesce(sum(e.amount_cents), 0)
    into v_receivables
    from public.customer_credit_entries e
   where e.store_id = v_me.store_id;

  select coalesce(sum(gr.total_cents - gr.paid_cents), 0)
    into v_payables
    from public.goods_receipts gr
   where gr.store_id = v_me.store_id and gr.voided_at is null;

  -- inventory at cost: unit products by their own unit cost, packets by theirs
  select coalesce(sum(p.stock_on_hand * coalesce(pc.cost_cents, 0)), 0),
         count(*) filter (where pc.cost_cents is null and p.stock_on_hand > 0)
    into v_inventory, v_uncosted
    from public.products p
    left join public.product_costs pc on pc.product_id = p.id
   where p.store_id = v_me.store_id and p.archived_at is null;

  v_inventory := v_inventory + coalesce((
    select sum(ps.packets_on_hand * coalesce(ps.cost_cents, 0))
      from public.pack_sizes ps
     where ps.store_id = v_me.store_id and ps.is_active), 0);

  v_net_sales := v_gross - v_discounts - v_refunds;
  v_gross_profit := v_net_sales - (v_cogs - v_cogs_reversed);
  v_net_profit := v_gross_profit - v_operating;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'currency', v_store.currency,

    -- what was sold: gross, then every deduction that reaches net
    'gross_sales_cents', v_gross,
    'discounts_cents', v_discounts,
    'refunds_cents', v_refunds,
    'net_sales_cents', v_net_sales,
    'refunded_bills', v_refunded_bills,
    'cancelled_bills', v_cancelled_bills,
    'bill_count', v_bills,

    -- what was received
    'collected_cents', v_collected + v_settled,
    'collected_at_till_cents', v_collected,
    'credit_settled_cents', v_settled,

    -- what the goods cost
    'cogs_cents', v_cogs - v_cogs_reversed,
    'unknown_cost_lines', v_unknown,

    -- profit
    'gross_profit_cents', v_gross_profit,
    'operating_expenses_cents', v_operating,
    'capital_expenses_cents', v_capital,
    'net_profit_cents', v_net_profit,

    -- VAT building blocks: records, not a return
    'output_vat_cents', v_output_vat - v_tax_refunded,
    'input_vat_expenses_cents', v_expense_vat,
    'input_vat_purchases_cents', v_purchase_vat,

    -- balances at a point in time
    'receivables_cents', v_receivables,
    'payables_cents', v_payables,
    'unpaid_expenses_cents', v_unpaid_expenses,
    'inventory_value_cents', v_inventory,
    'uncosted_products', v_uncosted,

    -- purchases in the period, shown so it is visible they are NOT in the profit sums above
    'purchases_cents', v_purchase_net,
    'unpaid_purchases_cents', v_purchase_unpaid,
    'purchase_count', v_purchase_count,

    'expense_count', v_expense_count,
    'line_revenue_cents', v_line_revenue,

    -- honesty flags, so no figure is presented as final when it is not
    'is_estimate', (v_unknown > 0 or v_uncosted > 0),
    'vat_registered', v_store.is_vat_registered,
    'vat_rate_pct', v_store.vat_rate_pct,
    'cost_method', v_store.cost_method
  );
end $$;

-- ---------------------------------------------------------------------------------------------
-- expenses: by category, over time, and what changed
-- ---------------------------------------------------------------------------------------------
create or replace function public.expense_breakdown(p_from date, p_to date)
returns table (
  category text, kind public.expense_kind, total_cents bigint, paid_cents bigint,
  unpaid_cents bigint, entry_count int, share_pct numeric
)
language sql stable security definer set search_path = public as $$
  with rows as (
    select e.category, e.kind,
           sum(e.amount_cents - e.tax_cents)::bigint as total,
           sum(e.paid_cents)::bigint as paid,
           sum(e.amount_cents - e.paid_cents)::bigint as unpaid,
           count(*)::int as n
      from public.expenses e
     where e.store_id = public.app_store_id()
       and public.app_role() in ('owner', 'supervisor')
       and e.voided_at is null
       and e.expense_on >= p_from and e.expense_on <= p_to
     group by e.category, e.kind
  )
  select r.category, r.kind, r.total, r.paid, r.unpaid, r.n,
         case when coalesce(sum(r.total) over (), 0) = 0 then 0
              else round(100.0 * r.total / sum(r.total) over (), 1) end
    from rows r
   order by r.total desc, r.category
$$;

create or replace function public.expense_trend(p_from date, p_to date, p_granularity text default 'month')
returns table (bucket date, operating_cents bigint, capital_cents bigint, entry_count int)
language sql stable security definer set search_path = public as $$
  with step as (
    select case lower(coalesce(p_granularity, 'month'))
             when 'day' then 'day' when 'week' then 'week' when 'quarter' then 'quarter'
             when 'year' then 'year' else 'month' end::text as unit
  ),
  buckets as (
    select generate_series(
             date_trunc((select unit from step), p_from::timestamptz),
             date_trunc((select unit from step), p_to::timestamptz),
             ('1 ' || (select unit from step))::interval
           )::date as bucket
  ),
  spent as (
    select date_trunc((select unit from step), e.expense_on::timestamptz)::date as bucket,
           sum(case when e.kind = 'operating' then e.amount_cents - e.tax_cents else 0 end)::bigint as operating,
           sum(case when e.kind = 'capital' then e.amount_cents - e.tax_cents else 0 end)::bigint as capital,
           count(*)::int as n
      from public.expenses e
     where e.store_id = public.app_store_id()
       and public.app_role() in ('owner', 'supervisor')
       and e.voided_at is null
       and e.expense_on >= p_from and e.expense_on <= p_to
     group by 1
  )
  select b.bucket, coalesce(s.operating, 0), coalesce(s.capital, 0), coalesce(s.n, 0)
    from buckets b left join spent s on s.bucket = b.bucket
   order by b.bucket
$$;

-- "Significant change" is measured against the immediately preceding period of the same length,
-- because comparing a month with a whole year would flag a change that is only the calendar.
create or replace function public.expense_category_change(p_from date, p_to date)
returns table (
  category text, current_cents bigint, previous_cents bigint,
  change_cents bigint, change_pct numeric
)
language sql stable security definer set search_path = public as $$
  with span as (
    select (p_from - ((p_to - p_from) + 1)) as prev_from,
           (p_from - 1) as prev_to
  ),
  current_period as (
    select e.category, sum(e.amount_cents - e.tax_cents)::bigint as amount
      from public.expenses e
     where e.store_id = public.app_store_id()
       and public.app_role() in ('owner', 'supervisor')
       and e.voided_at is null
       and e.expense_on between p_from and p_to
     group by e.category
  ),
  previous_period as (
    select e.category, sum(e.amount_cents - e.tax_cents)::bigint as amount
      from public.expenses e, span
     where e.store_id = public.app_store_id()
       and public.app_role() in ('owner', 'supervisor')
       and e.voided_at is null
       and e.expense_on between span.prev_from and span.prev_to
     group by e.category
  )
  select coalesce(c.category, p.category) as category,
         coalesce(c.amount, 0) as current_cents,
         coalesce(p.amount, 0) as previous_cents,
         coalesce(c.amount, 0) - coalesce(p.amount, 0) as change_cents,
         case when coalesce(p.amount, 0) = 0 then null
              else round(100.0 * (coalesce(c.amount, 0) - p.amount) / p.amount, 1) end as change_pct
    from current_period c
    full outer join previous_period p on p.category = c.category
   order by abs(coalesce(c.amount, 0) - coalesce(p.amount, 0)) desc
$$;

-- ---------------------------------------------------------------------------------------------
-- product profitability
-- ---------------------------------------------------------------------------------------------
-- The formulas are the brief's, exactly:
--   Gross profit (per unit) = net revenue per unit - cost per unit
--   Margin (%)              = gross profit / net revenue * 100
--   Markup (%)              = gross profit / COGS * 100
--
-- Net revenue allocates the bill-level discount across its lines pro rata, and subtracts refunds, so
-- a discounted or partly returned bill does not report full price. Per-unit figures are derived by
-- division rather than read off today's price, so a weighted product sold in several packet sizes
-- reports an honest average rather than whichever size happens to sort first.
--
-- Every ratio is null where its denominator is zero: "margin is undefined", never "margin is 0%".
create or replace function public.product_profitability(p_from date, p_to date)
returns table (
  product_id uuid, name text, sku text, category text,
  unit_price_cents bigint, unit_cost_cents bigint, current_cost_cents bigint,
  gross_profit_per_unit_cents bigint, margin_pct numeric, markup_pct numeric,
  qty_sold numeric, revenue_cents bigint, cogs_cents bigint, gross_profit_cents bigint,
  units_refunded numeric, refunded_cents bigint,
  cost_known boolean, stock_on_hand numeric, is_below_cost boolean
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_start timestamptz := p_from::timestamptz;
  v_end timestamptz := (p_to + 1)::timestamptz;
  v_show_cost boolean;
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_me.role not in ('owner', 'supervisor') then
    raise exception 'profitability is for the owner and supervisors' using errcode = '42501';
  end if;
  -- 0010's rule, unchanged: cost never reaches a supervisor's browser.
  v_show_cost := v_me.role = 'owner';

  return query
  with bill as (
    select s.id,
           (s.subtotal_cents - s.discount_cents)::numeric as net,
           nullif(sum(si.line_total_cents) filter (where si.status = 'active' and si.kind = 'item'), 0) as lines_total
      from public.sales s
      join public.sale_items si on si.sale_id = s.id
     where s.store_id = v_me.store_id
       and s.status in ('completed', 'refunded')
       and s.created_at >= v_start and s.created_at < v_end
     group by s.id, s.subtotal_cents, s.discount_cents
  ),
  lines as (
    select si.product_id,
           si.qty,
           si.line_total_cents,
           si.cogs_cents,
           si.cost_cents,
           -- the discount this line actually bore, pro rata to its share of the bill
           round(si.line_total_cents::numeric
                 - (si.line_total_cents::numeric * b.net / b.lines_total))::bigint as discount_share
      from public.sale_items si
      join public.sales s on s.id = si.sale_id
      join bill b on b.id = s.id
     where s.store_id = v_me.store_id
       and s.status in ('completed', 'refunded')
       and si.status = 'active' and si.kind = 'item'
       and si.product_id is not null
       and s.created_at >= v_start and s.created_at < v_end
  ),
  sold as (
    select l.product_id,
           sum(l.qty)::numeric as qty,
           sum(l.line_total_cents - l.discount_share)::bigint as revenue,
           sum(l.cogs_cents)::bigint as cogs,
           bool_and(l.cost_cents is not null) as cost_known
      from lines l
     group by l.product_id
  ),
  returned as (
    select si.product_id,
           sum(rl.qty)::numeric as qty,
           sum(rl.amount_cents)::bigint as amount,
           sum(coalesce(rl.cost_cents, 0) * rl.qty)::bigint as cogs_back
      from public.refund_lines rl
      join public.refunds rf on rf.id = rl.refund_id
      join public.sale_items si on si.id = rl.sale_item_id
     where rf.store_id = v_me.store_id
       and rf.voided_at is null
       and rf.created_at >= v_start and rf.created_at < v_end
     group by si.product_id
  ),
  agg as (
    select p.id,
           p.name,
           p.sku,
           p.stock_on_hand,
           coalesce(sd.qty, 0)::numeric as qty,
           coalesce(sd.revenue, 0)::numeric - coalesce(rt.amount, 0) as revenue,
           coalesce(sd.cogs, 0)::numeric - coalesce(rt.cogs_back, 0) as cogs,
           coalesce(sd.cost_known, false) as cost_known,
           coalesce(rt.qty, 0)::numeric as refunded_qty,
           coalesce(rt.amount, 0)::bigint as refunded,
           pc.cost_cents as current_cost,
           (select c.name from public.categories c where c.id = p.category_id) as category_name
      from public.products p
      left join sold sd on sd.product_id = p.id
      left join returned rt on rt.product_id = p.id
      left join public.product_costs pc on pc.product_id = p.id
     where p.store_id = v_me.store_id
       and p.archived_at is null
       and (sd.product_id is not null or rt.product_id is not null)
  )
  select a.id,
         a.name,
         a.sku,
         a.category_name,
         case when a.qty <> 0 then round(a.revenue / a.qty)::bigint end,
         case when v_show_cost and a.qty <> 0 then round(a.cogs / a.qty)::bigint end,
         case when v_show_cost then a.current_cost end,
         case when v_show_cost and a.qty <> 0 then round((a.revenue - a.cogs) / a.qty)::bigint end,
         case when v_show_cost and a.revenue <> 0 then round(100.0 * (a.revenue - a.cogs) / a.revenue, 1) end,
         case when v_show_cost and a.cogs <> 0 then round(100.0 * (a.revenue - a.cogs) / a.cogs, 1) end,
         a.qty,
         round(a.revenue)::bigint,
         case when v_show_cost then round(a.cogs)::bigint end,
         case when v_show_cost then round(a.revenue - a.cogs)::bigint end,
         a.refunded_qty,
         a.refunded,
         v_show_cost and a.cost_known,
         a.stock_on_hand,
         case when v_show_cost and a.cogs > 0 then a.revenue < a.cogs else false end
    from agg a
   order by a.revenue - a.cogs desc;
end $$;

-- ---------------------------------------------------------------------------------------------
-- tax-record preparation
-- ---------------------------------------------------------------------------------------------
-- This produces records for an accountant. It does NOT calculate a return, apply a threshold or
-- state what is owed: those depend on the shop's registration, the current law and the filing
-- period, and getting them wrong silently would be worse than not offering them.
create or replace function public.tax_summary(p_from date, p_to date)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_store public.stores;
  v_start timestamptz := p_from::timestamptz;
  v_end timestamptz := (p_to + 1)::timestamptz;
  v_output_vat bigint := 0;
  v_taxable bigint := 0;
  v_zero bigint := 0;
  v_sales_count int := 0;
  v_refund_vat bigint := 0;
  v_input_purchases bigint := 0;
  v_purchase_count int := 0;
  v_input_expenses bigint := 0;
  v_expense_count int := 0;
  v_capital_present boolean := false;
  v_warnings text[] := array[]::text[];
begin
  select * into v_me from public.profiles
   where auth_user_id = auth.uid() and is_active and store_id = public.app_store_id();
  if not found then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if v_me.role not in ('owner', 'supervisor') then
    raise exception 'tax records are for the owner and supervisors' using errcode = '42501';
  end if;
  select * into v_store from public.stores where id = v_me.store_id;

  select coalesce(sum(si.tax_cents), 0),
         coalesce(sum(case when si.tax_rate_pct > 0 then si.line_total_cents else 0 end), 0),
         coalesce(sum(case when si.tax_rate_pct = 0 then si.line_total_cents else 0 end), 0),
         count(distinct s.id)
    into v_output_vat, v_taxable, v_zero, v_sales_count
    from public.sale_items si
    join public.sales s on s.id = si.sale_id
   where s.store_id = v_me.store_id
     and s.status <> 'cancelled'
     and si.status = 'active'
     and s.created_at >= v_start and s.created_at < v_end;

  select coalesce(sum(rf.tax_refunded_cents), 0)
    into v_refund_vat
    from public.refunds rf
   where rf.store_id = v_me.store_id and rf.voided_at is null
     and rf.created_at >= v_start and rf.created_at < v_end;

  select coalesce(sum(gr.input_vat_cents), 0), count(*)
    into v_input_purchases, v_purchase_count
    from public.goods_receipts gr
   where gr.store_id = v_me.store_id and gr.voided_at is null
     and gr.received_on >= p_from and gr.received_on <= p_to;

  select coalesce(sum(e.tax_cents), 0), count(*),
         coalesce(bool_or(e.kind = 'capital'), false)
    into v_input_expenses, v_expense_count, v_capital_present
    from public.expenses e
   where e.store_id = v_me.store_id and e.voided_at is null
     and e.expense_on >= p_from and e.expense_on <= p_to;

  if not coalesce(v_store.is_vat_registered, false) then
    v_warnings := v_warnings || 'The shop is not marked VAT-registered. These figures come from the tax rate recorded on each sale line.'::text;
  end if;
  if coalesce(v_store.vat_rate_pct, 0) = 0 then
    v_warnings := v_warnings || 'No shop VAT rate is set. Set it in shop settings before comparing these records with a return.'::text;
  end if;
  if coalesce(trim(v_store.tin), '') = '' then
    v_warnings := v_warnings || 'No TIN is recorded for the shop. Add it in shop settings.'::text;
  end if;
  if v_capital_present then
    v_warnings := v_warnings || 'This period contains capital purchases. Confirm with your accountant whether their input VAT belongs in this period.'::text;
  end if;
  if v_output_vat - v_refund_vat - (v_input_purchases + v_input_expenses) < 0 then
    v_warnings := v_warnings || 'Input tax exceeds output tax for this period. Whether that is carried forward or refunded is a matter for your accountant.'::text;
  end if;

  return jsonb_build_object(
    'from', p_from,
    'to', p_to,
    'shop', jsonb_build_object(
      'name', v_store.name, 'address', v_store.address, 'phone', v_store.phone,
      'vat_no', v_store.vat_no, 'tin', v_store.tin,
      'is_vat_registered', v_store.is_vat_registered,
      'vat_rate_pct', v_store.vat_rate_pct, 'prices_include_tax', v_store.prices_include_tax),

    -- records, not a return
    'output_vat_cents', v_output_vat - v_refund_vat,
    'vat_on_sales_cents', v_output_vat,
    'vat_refunded_cents', v_refund_vat,
    'taxable_sales_cents', v_taxable,
    'zero_rated_sales_cents', v_zero,
    'input_vat_purchases_cents', v_input_purchases,
    'input_vat_expenses_cents', v_input_expenses,
    'input_vat_total_cents', v_input_purchases + v_input_expenses,
    -- deliberately a difference, not "payable": liability depends on rules this app does not encode
    'vat_difference_cents', v_output_vat - v_refund_vat - (v_input_purchases + v_input_expenses),

    'sales_count', v_sales_count,
    'purchase_count', v_purchase_count,
    'expense_count', v_expense_count,

    'warnings', to_jsonb(v_warnings),
    'disclaimer', 'These are organised records for your accountant. They are not a tax return, and this application does not certify compliance or determine what is owed.'
  );
end $$;
