-- Clarification flow. Admin requests a clarification (sets clarification =
-- 'pending' via the normal staff UPDATE). The client responds from their order
-- view — but clients have no UPDATE on orders, so flipping it to 'responded'
-- goes through this narrow SECURITY DEFINER RPC (own order + only pending→
-- responded). It also records an order_events row so Admin is notified.
create or replace function public.client_respond_clarification(p_order_id text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_client text;
  v_actor  text;
begin
  select client_code into v_client from public.orders where id = p_order_id;
  if v_client is null then raise exception 'client_respond_clarification: order not found'; end if;
  if v_client is distinct from public.my_client_code() then
    raise exception 'client_respond_clarification: not your order';
  end if;
  select name into v_actor from public.profiles where id = auth.uid();
  update public.orders set clarification = 'responded'
   where id = p_order_id and clarification = 'pending';
  if found then
    insert into public.order_events (order_id, action, type, actor)
      values (p_order_id, coalesce(v_actor,'Client') || ' responded to the clarification on ' || p_order_id, 'status', v_actor);
  end if;
end;
$$;

revoke all on function public.client_respond_clarification(text) from public, anon;
grant execute on function public.client_respond_clarification(text) to authenticated;
