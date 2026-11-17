-- Notify the admin tier when a client RESOLVES an additional fee.
--
-- Raising a fee already surfaces in-portal to the client (the "Charge approval"
-- chip + Activity). The RESOLUTION was silent: resolve_order_charge only flipped
-- the charge's status, so Admin learned of an approval/decline only by reopening
-- the order. This wires the resolution into the EXISTING notification pipeline:
--   * resolve_order_charge now records the decision as a durable order_events row
--     (so it appears in the in-app Activity feed + bell for Admin AND the owning
--     client, cross-session), and
--   * two new notification_types (charge.approved / charge.declined, reaching the
--     admin role) let notify_on_order_event() fan the same event out to staff
--     email (immediate), honoring each admin's Notifications preferences.
-- Approval is consent-to-bill, never a payment — the Vivek deposit-confirmation
-- path is untouched; declining stays non-blocking.

-- 1) Two new types. default_roles '{admin}' reaches the whole admin tier (admins,
--    super admins and the billing owner are all role 'admin'); immediate by
--    default, and each person can switch it to digest/off under Notifications.
insert into public.notification_types (key, label, description, default_roles, default_mode, sort_order) values
  ('charge.approved', 'Additional fee approved',
   'A client approved an additional fee — it is added to the order invoice.',
   '{admin}'::user_role[], 'immediate', 70),
  ('charge.declined', 'Additional fee declined',
   'A client declined an additional fee — it will not be billed.',
   '{admin}'::user_role[], 'immediate', 71)
on conflict (key) do nothing;

-- 2) Teach the order-event classifier the two new events. resolve_order_charge
--    (below) writes each action string in exactly one place, so an ilike match is
--    unambiguous. Everything else in this function is unchanged.
create or replace function public.notify_on_order_event()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_type    text;
  v_order   public.orders%rowtype;
  v_client  text;
  v_payload jsonb;
begin
  v_type := case
    when new.type = 'new'      then 'order.new'
    when new.type = 'progress' then
      case when new.action ilike '%delivered%' then 'order.delivered' else 'order.progress' end
    when new.action ilike '%requested cancellation%'     then 'order.cancel_requested'
    when new.action ilike '%returned to Admin%'          then 'order.awaiting_admin'
    when new.action ilike '%approved an additional fee%' then 'charge.approved'
    when new.action ilike '%declined an additional fee%' then 'charge.declined'
    else null
  end;

  if v_type is null then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  select name into v_client from public.clients where code = v_order.client_code;

  v_payload := jsonb_build_object(
    'orderId',      new.order_id,
    'action',       new.action,
    'actor',        new.actor,
    'occurredAt',   new.created_at,
    'clientName',   v_client,
    'clientCode',   v_order.client_code,
    'clientFileNo', v_order.client_file_no,
    'orderType',    v_order.type,
    'state',        v_order.state,
    'county',       v_order.county,
    'priority',     v_order.priority,
    'status',       v_order.status,
    'assignedTo',   v_order.assigned_to,
    'eta',          v_order.eta
  );

  perform public.enqueue_notification(
    v_type, new.order_id, v_payload,
    case when v_type in ('order.new', 'order.delivered')
         then coalesce(new.order_id, new.id::text)
         else new.id::text end,
    new.actor_email);
  return new;
end $$;

-- 3) resolve_order_charge also records the decision as a durable order_events row
--    (as definer, so the audit line the client cannot insert directly is written
--    on their behalf). actor_email is null: the client is not a mail recipient and
--    no admin should be excluded. The action string matches the classifier above.
create or replace function public.resolve_order_charge(p_order_id text, p_charge_id text, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
begin
  if p_decision not in ('approved', 'declined') then
    raise exception 'resolve_order_charge: decision must be approved or declined (got %)', p_decision;
  end if;

  -- Capture the charge amount for the audit line, scoped exactly like the update.
  select (c->>'amount')::numeric into v_amount
    from public.orders o
    cross join lateral jsonb_array_elements(coalesce(o.workflow->'pendingCharges', '[]'::jsonb)) c
   where o.id = p_order_id
     and o.client_code = public.my_client_code()
     and c->>'id' = p_charge_id
     and coalesce(c->>'status', 'pending') = 'pending'
   limit 1;

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
     and client_code = public.my_client_code()
     and exists (
       select 1 from jsonb_array_elements(coalesce(workflow->'pendingCharges', '[]'::jsonb)) c
        where c->>'id' = p_charge_id and coalesce(c->>'status', 'pending') = 'pending'
     );
  if not found then
    raise exception 'resolve_order_charge: order not found, not owned, or no pending charge %', p_charge_id;
  end if;

  insert into public.order_events (order_id, action, type, actor, actor_email, audience)
  values (
    p_order_id,
    format('Client %s an additional fee of $%s on %s',
           p_decision,
           to_char(coalesce(v_amount, 0), 'FM999,999,990.00'),
           p_order_id),
    'status', 'Client', null, 'all');
end;
$$;

revoke all on function public.resolve_order_charge(text, text, text) from public, anon;
grant execute on function public.resolve_order_charge(text, text, text) to authenticated;
