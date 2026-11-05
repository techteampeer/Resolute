-- Client-facing billing: a client approves or declines an additional charge that
-- Admin or the Typer raised on the order (an extra county, a document rush, …).
--
-- Like client_mark_payment, this exists because clients have no UPDATE policy on
-- orders and granting one would let them mutate status/assignment/amounts. The
-- narrow SECURITY DEFINER RPC writes ONLY the one charge's `status` (and its
-- resolvedAt), only for the caller's own order, and only when that charge is
-- still 'pending'. It can never change a charge's AMOUNT, so a client can't forge
-- consent into a different fee, and it can't un-resolve a charge already decided.
--
-- Approving is consent-to-bill, NOT a payment: the approved amount joins the
-- invoice total (see approvedChargesTotal in packages/domain/src/money.ts) but the
-- invoice stays Outstanding until the deposit is confirmed by the billing super
-- admin (Vivek) on the untouched payment path. Declining is non-blocking — the
-- order proceeds, the charge simply never bills.
create or replace function public.resolve_order_charge(p_order_id text, p_charge_id text, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_decision not in ('approved', 'declined') then
    raise exception 'resolve_order_charge: decision must be approved or declined (got %)', p_decision;
  end if;

  update public.orders
     set workflow = jsonb_set(
           coalesce(workflow, '{}'::jsonb),
           '{pendingCharges}',
           (
             select coalesce(jsonb_agg(
               case
                 when c->>'id' = p_charge_id and coalesce(c->>'status', 'pending') = 'pending'
                 then c || jsonb_build_object('status', p_decision, 'resolvedAt', to_char(now(), 'YYYY-MM-DD'))
                 else c
               end
               order by ord), '[]'::jsonb)
             from jsonb_array_elements(coalesce(workflow->'pendingCharges', '[]'::jsonb)) with ordinality as t(c, ord)
           ),
           true)
   where id = p_order_id
     and client_code = public.my_client_code()                                          -- own order only
     and exists (                                                                        -- a matching PENDING charge must exist
       select 1 from jsonb_array_elements(coalesce(workflow->'pendingCharges', '[]'::jsonb)) c
        where c->>'id' = p_charge_id and coalesce(c->>'status', 'pending') = 'pending'
     );
  if not found then
    raise exception 'resolve_order_charge: order not found, not owned, or no pending charge %', p_charge_id;
  end if;
end;
$$;

revoke all on function public.resolve_order_charge(text, text, text) from public, anon;
grant execute on function public.resolve_order_charge(text, text, text) to authenticated;
