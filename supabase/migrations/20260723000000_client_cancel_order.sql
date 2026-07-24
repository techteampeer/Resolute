-- Client-initiated cancellation (BUG_003) under Supabase. Clients have no UPDATE
-- policy on orders, so cancelOrder's saveOrder was silently denied — the order
-- looked cancelled to the client but never changed in the DB, so Admin never
-- saw it. This RPC performs the cancel for the caller's OWN order and records an
-- order_events row (definer bypasses the staff-only insert) so Admin is notified.
--
-- Policy = free while still queued ('received'); once work has started it's a
-- request Admin must approve (workflow.cancelRequested). Returns 'cancelled' or
-- 'requested'.
create or replace function public.client_cancel_order(p_order_id text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status order_status;
  v_client text;
  v_actor  text;
  v_mode   text;
begin
  select status, client_code into v_status, v_client
    from public.orders where id = p_order_id;
  if v_status is null then raise exception 'client_cancel_order: order not found'; end if;
  if v_client is distinct from public.my_client_code() then
    raise exception 'client_cancel_order: not your order';
  end if;
  select name into v_actor from public.profiles where id = auth.uid();
  v_actor := coalesce(v_actor, 'Client');

  if v_status = 'received' then
    update public.orders
       set status = 'cancelled', assigned_to = null, progress = 0,
           workflow = coalesce(workflow, '{}'::jsonb) - 'cancelRequested'
     where id = p_order_id;
    v_mode := 'cancelled';
    insert into public.order_events (order_id, action, type, actor)
      values (p_order_id, v_actor || ' cancelled ' || p_order_id || ' before screening', 'status', v_actor);
  elsif v_status in ('delivered', 'cancelled') then
    raise exception 'client_cancel_order: order not cancellable in status %', v_status;
  else
    update public.orders
       set workflow = jsonb_set(
             coalesce(workflow, '{}'::jsonb), '{cancelRequested}',
             jsonb_build_object('by', v_actor, 'at', to_char(now(), 'YYYY-MM-DD')), true)
     where id = p_order_id;
    v_mode := 'requested';
    insert into public.order_events (order_id, action, type, actor)
      values (p_order_id, v_actor || ' requested cancellation of ' || p_order_id || ' — awaiting Admin approval', 'status', v_actor);
  end if;

  return v_mode;
end;
$$;

revoke all on function public.client_cancel_order(text) from public, anon;
grant execute on function public.client_cancel_order(text) to authenticated;
