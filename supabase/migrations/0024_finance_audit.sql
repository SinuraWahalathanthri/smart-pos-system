-- Audit trail, review alerts, financial settings and the grants that open the finance RPCs.
--
-- The audit trail itself already exists: `audit_logs` has been append-only since 0001 and every
-- finance function in 0022 writes to it. What was missing was a way to read it as a story - who did
-- what, to which record, before and after, and why - and a set of review alerts that point a human at
-- the entries worth a second look.
--
-- THE ALERTS ARE NOT ACCUSATIONS. Each one is a pattern that is often innocent (a large fuel bill in
-- harvest week, two identical sales to two customers who really did buy the same thing). They are
-- worded as questions, they carry the evidence, and nothing is blocked or reversed automatically.

-- ---------------------------------------------------------------------------------------------
-- reading the trail
-- ---------------------------------------------------------------------------------------------
create or replace function public.audit_trail(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_action text default null,
  p_entity text default null,
  p_limit int default 200
) returns table (
  id uuid, created_at timestamptz, action text, entity text, entity_id uuid,
  actor text, approver text, reason text, before jsonb, after jsonb
)
language plpgsql stable security definer set search_path = public as $$
begin
  -- Owner only, matching 0002's audit_read policy. Reading the trail is not a supervisor task, so
  -- this raises rather than quietly returning nothing: an empty list would look like "no activity".
  if public.app_role() is distinct from 'owner' then
    raise exception 'the audit trail is for the shop owner' using errcode = '42501';
  end if;

  return query
  select a.id, a.created_at, a.action, a.entity, a.entity_id,
         actor.full_name, approver.full_name, a.reason, a.before, a.after
    from public.audit_logs a
    left join public.profiles actor on actor.id = a.requested_by
    left join public.profiles approver on approver.id = a.approved_by
   where a.store_id = public.app_store_id()
     and (p_from is null or a.created_at >= p_from)
     and (p_to is null or a.created_at < p_to)
     and (p_action is null or trim(p_action) = '' or a.action = p_action)
     and (p_entity is null or trim(p_entity) = '' or a.entity = p_entity)
   order by a.created_at desc
   limit greatest(coalesce(p_limit, 200), 1);
end $$;

-- The distinct things that have happened, so the screen can offer a filter without a hardcoded list.
create or replace function public.audit_actions()
returns table (action text, occurrences int)
language plpgsql stable security definer set search_path = public as $$
begin
  if public.app_role() is distinct from 'owner' then
    raise exception 'the audit trail is for the shop owner' using errcode = '42501';
  end if;
  return query
  select a.action, count(*)::int
    from public.audit_logs a
   where a.store_id = public.app_store_id()
   group by a.action
   order by count(*) desc, a.action;
end $$;

-- ---------------------------------------------------------------------------------------------
-- review alerts
-- ---------------------------------------------------------------------------------------------
-- One row per thing worth a look. `severity` is 'review' for everything: this function has no way to
-- know whether a pattern is a mistake, and presenting a guess as a finding would be worse than silence.
create or replace function public.finance_alerts(p_from date default null, p_to date default null)
returns table (
  code text,
  severity text,
  headline text,
  detail text,
  amount_cents bigint,
  entity text,
  entity_id uuid,
  happened_on date
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_finance_access();
  v_from date := coalesce(p_from, current_date - 90);
  v_to date := coalesce(p_to, current_date);
  v_start timestamptz := v_from::timestamptz;
  v_end timestamptz := (v_to + 1)::timestamptz;
begin
  return query
  -- 1. an expense far above what that category usually costs
  with category_norm as (
    select e.category,
           percentile_cont(0.5) within group (order by e.amount_cents) as median,
           count(*) as n
      from public.expenses e
     where e.store_id = v_me.store_id and e.voided_at is null
       and e.expense_on >= v_from - 365 and e.expense_on <= v_to
     group by e.category
    having count(*) >= 3
  )
  select 'unusual_expense',
         'review',
         'Large ' || lower(e.category) || ' expense',
         e.description || ' is far above the usual ' || lower(e.category)
           || ' cost (median about ' || round(cn.median::numeric / 100.0, 0)::text || ').',
         e.amount_cents, 'expenses', e.id, e.expense_on
    from public.expenses e
    join category_norm cn on cn.category = e.category
   where e.store_id = v_me.store_id and e.voided_at is null
     and e.expense_on >= v_from and e.expense_on <= v_to
     and e.amount_cents > cn.median * 3
     and cn.n >= 3

  union all
  -- 2. the same bill entered twice: same amount, same payee, within two days
  select 'possible_duplicate_expense',
         'review',
         'Possible duplicate expense',
         e2.description || ' repeats ' || to_char(e1.expense_on, 'DD Mon')
           || ' with the same amount and payee.',
         e2.amount_cents, 'expenses', e2.id, e2.expense_on
    from public.expenses e1
    join public.expenses e2
      on e2.store_id = e1.store_id
     and e2.id <> e1.id
     and e2.amount_cents = e1.amount_cents
     and e2.category = e1.category
     and coalesce(e2.payee, '') = coalesce(e1.payee, '')
     and e2.expense_on between e1.expense_on and e1.expense_on + 2
   where e1.store_id = v_me.store_id
     and e1.voided_at is null and e2.voided_at is null
     and e1.expense_on >= v_from and e1.expense_on <= v_to
     and e2.expense_on >= v_from and e2.expense_on <= v_to
     -- report each pair once, from the later voucher
     and e2.voucher_no > e1.voucher_no

  union all
  -- 3. two identical bills in the same minute: often a double-submitted sale
  select 'possible_duplicate_sale',
         'review',
         'Possible duplicate bill',
         'Receipt ' || s2.receipt_no || ' repeats receipt ' || s1.receipt_no
           || ' with the same total, almost the same minute.',
         s2.total_cents, 'sales', s2.id, s2.created_at::date
    from public.sales s1
    join public.sales s2
      on s2.store_id = s1.store_id
     and s2.id <> s1.id
     and s2.total_cents = s1.total_cents
     and s2.subtotal_cents = s1.subtotal_cents
     and s2.created_at > s1.created_at
     and s2.created_at <= s1.created_at + interval '2 minutes'
   where s1.store_id = v_me.store_id
     and s1.status <> 'cancelled' and s2.status <> 'cancelled'
     and s1.created_at >= v_start and s1.created_at < v_end
     and s2.created_at >= v_start and s2.created_at < v_end

  union all
  -- 4. stock that moved without a documented reason
  select 'unexplained_stock_change',
         'review',
         'Stock changed without a reason',
         p.name || ' was adjusted by ' || m.qty_change::text
           || ' with no reason recorded.',
         abs(m.qty_change * coalesce(pc.cost_cents, 0))::bigint,
         'products', m.product_id, m.created_at::date
    from public.stock_movements m
    join public.products p on p.id = m.product_id
    left join public.product_costs pc on pc.product_id = p.id
   where m.store_id = v_me.store_id
     and m.type = 'adjustment'
     and coalesce(trim(m.reason), '') = ''
     and m.created_at >= v_start and m.created_at < v_end

  union all
  -- 5. stock that has gone negative: either a missed delivery or an unrecorded sale
  select 'negative_stock',
         'review',
         'Negative stock',
         p.name || ' is showing ' || p.stock_on_hand::text || ' on hand.',
         null::bigint, 'products', p.id, current_date
    from public.products p
   where p.store_id = v_me.store_id and p.archived_at is null and p.stock_on_hand < 0

  union all
  -- 6. a product being sold for less than it cost
  select 'below_cost',
         'review',
         'Sold below cost',
         pp.name || ' earned less than its cost over this period.',
         pp.gross_profit_cents, 'products', pp.product_id, v_to
    from public.product_profitability(v_from, v_to) pp
   where pp.is_below_cost and pp.revenue_cents > 0

  union all
  -- 7. a cost changed with no reason given
  select 'cost_changed_without_reason',
         'review',
         'Cost changed without a reason',
         p.name || ' cost changed from ' || coalesce(h.old_cost_cents::text, 'unset')
           || ' to ' || h.new_cost_cents::text || '.',
         h.new_cost_cents - coalesce(h.old_cost_cents, 0),
         'products', h.product_id, h.changed_at::date
    from public.product_cost_history h
    join public.products p on p.id = h.product_id
   where h.store_id = v_me.store_id
     and coalesce(trim(h.reason), '') = ''
     and h.source = 'manual'
     and h.changed_at >= v_start and h.changed_at < v_end

  union all
  -- 8. an expense entered long after the date it claims
  select 'backdated_expense',
         'review',
         'Expense dated well before it was entered',
         e.description || ' is dated ' || to_char(e.expense_on, 'DD Mon YYYY')
           || ' but was entered ' || round(extract(epoch from (e.created_at - e.expense_on::timestamptz)) / 86400)::text
           || ' days later.',
         e.amount_cents, 'expenses', e.id, e.expense_on
    from public.expenses e
   where e.store_id = v_me.store_id and e.voided_at is null
     and e.expense_on >= v_from and e.expense_on <= v_to
     and e.created_at > e.expense_on::timestamptz + interval '30 days'

  union all
  -- 9. a lot of bills cancelled or refunded: worth understanding, not necessarily wrong
  select 'high_cancellation_rate',
         'review',
         'Many bills cancelled or refunded',
         counts.bad::text || ' of ' || counts.total::text || ' bills in this period were cancelled or refunded.',
         null::bigint, 'sales', null::uuid, v_to
    from (
      select count(*) filter (where s.status in ('cancelled', 'refunded')) as bad,
             count(*) as total
        from public.sales s
       where s.store_id = v_me.store_id
         and s.created_at >= v_start and s.created_at < v_end
    ) counts
   where counts.total >= 5 and counts.bad::numeric / nullif(counts.total, 0) > 0.1

  union all
  -- 10. an expense paid in full with no payment recorded against it
  select 'paid_without_payment',
         'review',
         'Marked paid with no payment recorded',
         e.description || ' is marked paid but no payment entry exists.',
         e.amount_cents, 'expenses', e.id, e.expense_on
    from public.expenses e
   where e.store_id = v_me.store_id and e.voided_at is null
     and e.expense_on >= v_from and e.expense_on <= v_to
     and e.paid_cents > 0
     and not exists (select 1 from public.expense_payments p where p.expense_id = e.id)

  order by 8 desc nulls last, 5 desc nulls last
  ;
end $$;

-- ---------------------------------------------------------------------------------------------
-- financial settings
-- ---------------------------------------------------------------------------------------------
-- VAT is configurable because it must not be guessed. Registration status, the rate and the TIN are
-- the shop's own facts; nothing here defaults to a real-world figure.
create or replace function public.save_finance_settings(
  p_is_vat_registered boolean default null,
  p_vat_rate_pct numeric default null,
  p_tin text default null,
  p_vat_no text default null,
  p_cost_method public.cost_method default null,
  p_fiscal_year_start_month int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles := public.assert_owner();
  v_store public.stores;
begin
  if p_vat_rate_pct is not null and (p_vat_rate_pct < 0 or p_vat_rate_pct >= 100) then
    raise exception 'VAT rate must be between 0 and 100';
  end if;
  if p_fiscal_year_start_month is not null and (p_fiscal_year_start_month < 1 or p_fiscal_year_start_month > 12) then
    raise exception 'fiscal year start month must be 1 to 12';
  end if;

  select * into v_store from public.stores where id = v_me.store_id;

  update public.stores set
    is_vat_registered = coalesce(p_is_vat_registered, is_vat_registered),
    vat_rate_pct = coalesce(p_vat_rate_pct, vat_rate_pct),
    tin = coalesce(nullif(trim(coalesce(p_tin, '')), ''), tin),
    vat_no = coalesce(nullif(trim(coalesce(p_vat_no, '')), ''), vat_no),
    cost_method = coalesce(p_cost_method, cost_method),
    fiscal_year_start_month = coalesce(p_fiscal_year_start_month, fiscal_year_start_month)
  where id = v_me.store_id;

  insert into public.audit_logs (store_id, action, entity, entity_id, requested_by, before, after)
  values (v_me.store_id, 'finance_settings_changed', 'stores', v_me.store_id, v_me.id,
          jsonb_build_object(
            'is_vat_registered', v_store.is_vat_registered, 'vat_rate_pct', v_store.vat_rate_pct,
            'tin', v_store.tin, 'vat_no', v_store.vat_no, 'cost_method', v_store.cost_method,
            'fiscal_year_start_month', v_store.fiscal_year_start_month),
          jsonb_build_object(
            'is_vat_registered', coalesce(p_is_vat_registered, v_store.is_vat_registered),
            'vat_rate_pct', coalesce(p_vat_rate_pct, v_store.vat_rate_pct),
            'tin', coalesce(p_tin, v_store.tin), 'vat_no', coalesce(p_vat_no, v_store.vat_no),
            'cost_method', coalesce(p_cost_method, v_store.cost_method),
            'fiscal_year_start_month', coalesce(p_fiscal_year_start_month, v_store.fiscal_year_start_month)));

  return (
    select jsonb_build_object(
      'is_vat_registered', s.is_vat_registered, 'vat_rate_pct', s.vat_rate_pct,
      'tin', s.tin, 'vat_no', s.vat_no, 'cost_method', s.cost_method,
      'fiscal_year_start_month', s.fiscal_year_start_month)
      from public.stores s where s.id = v_me.store_id
  );
end $$;

-- ---------------------------------------------------------------------------------------------
-- exports: the rows behind a figure, for a CSV/PDF an accountant can read
-- ---------------------------------------------------------------------------------------------
create or replace function public.expense_export(p_from date, p_to date)
returns table (
  voucher_no bigint, expense_on date, category text, description text, payee text,
  reference text, kind public.expense_kind, amount_cents bigint, tax_cents bigint,
  paid_cents bigint, status public.expense_status, payment_method public.pay_method, notes text
)
language sql stable security definer set search_path = public as $$
  select e.voucher_no, e.expense_on, e.category, e.description, e.payee, e.reference, e.kind,
         e.amount_cents, e.tax_cents, e.paid_cents, e.status, e.payment_method, e.notes
    from public.expenses e
   where e.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and e.voided_at is null
     and e.expense_on >= p_from and e.expense_on <= p_to
   order by e.expense_on, e.voucher_no
$$;

create or replace function public.sales_export(p_from date, p_to date)
returns table (
  receipt_no bigint, created_at timestamptz, status public.sale_status, cashier text, customer text,
  subtotal_cents bigint, discount_cents bigint, total_cents bigint, tax_cents bigint,
  cogs_cents bigint, gross_profit_cents bigint, paid_cents bigint, payment_methods text
)
language sql stable security definer set search_path = public as $$
  select s.receipt_no, s.created_at, s.status,
         coalesce(pr.full_name, ''),
         coalesce(c.name, ''),
         s.subtotal_cents, s.discount_cents, s.total_cents,
         coalesce((select sum(si.tax_cents) from public.sale_items si
                    where si.sale_id = s.id and si.status = 'active' and si.kind = 'item'), 0),
         coalesce((select sum(si.cogs_cents) from public.sale_items si
                    where si.sale_id = s.id and si.status = 'active' and si.kind = 'item'), 0),
         s.subtotal_cents - s.discount_cents
           - coalesce((select sum(si.cogs_cents) from public.sale_items si
                        where si.sale_id = s.id and si.status = 'active' and si.kind = 'item'), 0),
         coalesce((select sum(p.amount_cents) from public.payments p
                    where p.sale_id = s.id and p.method <> 'credit'), 0),
         coalesce((select string_agg(distinct p.method::text, '+') from public.payments p
                    where p.sale_id = s.id), '')
    from public.sales s
    left join public.profiles pr on pr.id = coalesce(s.cashier_id, s.recorded_by)
    left join public.customers c on c.id = s.customer_id
   where s.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and s.created_at >= p_from::timestamptz
     and s.created_at < (p_to + 1)::timestamptz
   order by s.created_at
$$;

create or replace function public.purchases_export(p_from date, p_to date)
returns table (
  id uuid, received_on date, supplier_id uuid, supplier text, supplier_invoice_no text,
  status public.purchase_status,
  subtotal_cents bigint, input_vat_cents bigint, additional_cost_cents bigint, total_cents bigint,
  paid_cents bigint, outstanding_cents bigint, due_on date
)
language sql stable security definer set search_path = public as $$
  select gr.id, gr.received_on, gr.supplier_id, coalesce(sup.name, ''), gr.supplier_invoice_no, gr.status,
         gr.subtotal_cents, gr.input_vat_cents, gr.additional_cost_cents, gr.total_cents,
         gr.paid_cents, gr.total_cents - gr.paid_cents, gr.due_on
    from public.goods_receipts gr
    left join public.suppliers sup on sup.id = gr.supplier_id
   where gr.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
     and gr.voided_at is null
     and gr.received_on >= p_from and gr.received_on <= p_to
   order by gr.received_on, gr.created_at
$$;

-- ---------------------------------------------------------------------------------------------
-- grants
-- ---------------------------------------------------------------------------------------------
revoke all on function
  public.assert_finance_access(), public.assert_owner(),
  public.expense_status_for(bigint, bigint), public.purchase_status_for(bigint, bigint),
  public.seed_expense_categories(), public.seed_expense_categories_for(uuid), public.save_expense_category(text, boolean),
  public.save_expense(jsonb), public.pay_expense(uuid, bigint, public.pay_method, date, text),
  public.void_expense(uuid, text), public.attach_expense_receipt(uuid, text, text, text),
  public.expense_list(date, date, text, public.pay_method, public.expense_status, text, bigint, bigint, int),
  public.save_purchase(jsonb), public.pay_purchase(uuid, bigint, public.pay_method, date, text),
  public.void_purchase(uuid, text), public.set_product_cost(uuid, uuid, bigint, text),
  public.save_production_run(jsonb), public.refund_sale(uuid, text, public.pay_method, boolean),
  public.void_sale(uuid, text),
  public.finance_summary(date, date), public.expense_breakdown(date, date),
  public.expense_trend(date, date, text), public.expense_category_change(date, date),
  public.product_profitability(date, date), public.tax_summary(date, date),
  public.audit_trail(timestamptz, timestamptz, text, text, int), public.audit_actions(),
  public.finance_alerts(date, date),
  public.save_finance_settings(boolean, numeric, text, text, public.cost_method, int),
  public.expense_export(date, date), public.sales_export(date, date), public.purchases_export(date, date)
  from public, anon, authenticated;

grant execute on function
  public.seed_expense_categories(), public.seed_expense_categories_for(uuid), public.save_expense_category(text, boolean),
  public.save_expense(jsonb), public.pay_expense(uuid, bigint, public.pay_method, date, text),
  public.void_expense(uuid, text), public.attach_expense_receipt(uuid, text, text, text),
  public.expense_list(date, date, text, public.pay_method, public.expense_status, text, bigint, bigint, int),
  public.save_purchase(jsonb), public.pay_purchase(uuid, bigint, public.pay_method, date, text),
  public.void_purchase(uuid, text), public.set_product_cost(uuid, uuid, bigint, text),
  public.save_production_run(jsonb), public.refund_sale(uuid, text, public.pay_method, boolean),
  public.void_sale(uuid, text),
  public.finance_summary(date, date), public.expense_breakdown(date, date),
  public.expense_trend(date, date, text), public.expense_category_change(date, date),
  public.product_profitability(date, date), public.tax_summary(date, date),
  public.audit_trail(timestamptz, timestamptz, text, text, int), public.audit_actions(),
  public.finance_alerts(date, date),
  public.save_finance_settings(boolean, numeric, text, text, public.cost_method, int),
  public.expense_export(date, date), public.sales_export(date, date), public.purchases_export(date, date)
  to authenticated;

-- assert_finance_access / assert_owner / the status helpers stay internal: they are building blocks,
-- not endpoints. Calling assert_owner() from a browser would tell an attacker whether they are one.
