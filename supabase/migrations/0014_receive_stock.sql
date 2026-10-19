-- Receiving stock, and the history that explains it.
--
-- Before this, the only way stock could enter the shop was the "opening stock" field on the product
-- form. Editing a product afterwards offered the same field, but it re-posted an opening movement
-- rather than adding to what was there, so a product could never actually be restocked from the UI.
--
-- Stock is never written directly: stock_on_hand and packets_on_hand are maintained by
-- apply_stock_movement() from the append-only stock_movements ledger (see 0001_core). Receiving is
-- therefore one `purchase` movement, which also raises or clears the low-stock alert for free.

create or replace function public.receive_stock(
  p_product         uuid,
  p_pack_size       uuid,
  p_qty             numeric,
  p_unit_cost_cents bigint default null,
  p_supplier        text default null,
  p_note            text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me public.profiles;
  v_product public.products;
  v_on_hand numeric;
begin
  v_me := public.assert_can_manage_products();

  select * into v_product from public.products where id = p_product and store_id = v_me.store_id;
  if not found then raise exception 'unknown product'; end if;
  if coalesce(p_qty, 0) <= 0 then raise exception 'quantity must be greater than zero'; end if;
  if p_unit_cost_cents is not null and p_unit_cost_cents < 0 then
    raise exception 'unit cost cannot be negative';
  end if;

  -- A weighted product's stock lives on its packets, so receiving without naming a packet would
  -- post into a column the till never reads.
  if v_product.sale_mode = 'weighted' then
    if p_pack_size is null then raise exception 'choose which packet size is being received'; end if;
    if not exists (
      select 1 from public.pack_sizes
       where id = p_pack_size and product_id = p_product and store_id = v_me.store_id
    ) then
      raise exception 'unknown packet size';
    end if;
  elsif p_pack_size is not null then
    raise exception 'this product is sold by unit, not by packet';
  end if;

  insert into public.stock_movements
    (store_id, product_id, pack_size_id, qty_change, type, unit_cost_cents, reason, created_by)
  values
    (v_me.store_id, p_product, p_pack_size, p_qty, 'purchase', p_unit_cost_cents,
     nullif(trim(concat_ws(' / ', nullif(trim(coalesce(p_supplier, '')), ''), nullif(trim(coalesce(p_note, '')), ''))), ''),
     v_me.id);

  select case when p_pack_size is null then p.stock_on_hand else ps.packets_on_hand end
    into v_on_hand
    from public.products p
    left join public.pack_sizes ps on ps.id = p_pack_size
   where p.id = p_product;

  return jsonb_build_object('product_id', p_product, 'pack_size_id', p_pack_size, 'on_hand', v_on_hand);
end $$;

revoke all on function public.receive_stock(uuid, uuid, numeric, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.receive_stock(uuid, uuid, numeric, bigint, text, text) to authenticated;

-- Why is stock what it is? The ledger already holds the answer; this just joins the person in, and
-- keeps the join server-side so the dashboard does not depend on PostgREST resolving two FKs.
create or replace function public.product_movements(p_product uuid, p_limit int default 25)
returns table (
  id uuid,
  created_at timestamptz,
  type public.stock_move_type,
  qty_change numeric,
  pack_label text,
  unit_cost_cents bigint,
  reason text,
  by_name text
)
language sql stable security definer set search_path = public as $$
  select m.id,
         m.created_at,
         m.type,
         m.qty_change,
         ps.label,
         m.unit_cost_cents,
         m.reason,
         pr.full_name
    from public.stock_movements m
    left join public.pack_sizes ps on ps.id = m.pack_size_id
    left join public.profiles pr on pr.id = m.created_by
   where m.product_id = p_product
     and m.store_id = public.app_store_id()
     and public.app_role() in ('owner', 'supervisor')
   order by m.created_at desc
   limit greatest(coalesce(p_limit, 25), 1)
$$;

revoke all on function public.product_movements(uuid, int) from public, anon, authenticated;
grant execute on function public.product_movements(uuid, int) to authenticated;
