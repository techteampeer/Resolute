-- Client-facing billing: a client marks an invoice paid (ACH trace # / check #).
-- Orders have no client UPDATE policy (updates are staff/admin only) and granting
-- one would let clients mutate status/assignment/etc. Instead expose a narrow
-- SECURITY DEFINER RPC that writes ONLY workflow.payment, only for the caller's
-- own order, and only to the 'marked' state — confirming/bouncing a deposit
-- stays with the billing super admin (Vivek), who updates via the staff path.
create or replace function public.client_mark_payment(p_order_id text, p_payment jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.orders
     set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', p_payment, true)
   where id = p_order_id
     and client_code = public.my_client_code()                              -- own order only
     and (p_payment->>'status') = 'marked'                                  -- client may only MARK
     and coalesce(workflow->'payment'->>'status', 'unpaid') <> 'confirmed'; -- can't undo a confirmed deposit
  if not found then
    raise exception 'client_mark_payment: order not found, not owned, or not markable';
  end if;
end;
$$;

revoke all on function public.client_mark_payment(text, jsonb) from public, anon;
grant execute on function public.client_mark_payment(text, jsonb) to authenticated;
