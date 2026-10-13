-- =====================================================================
-- D1 — rename the production role `operator` -> `user`
-- =====================================================================
-- The single-seating "operator" desk becomes the consolidated production login
-- `user` (see docs/adr/0001-user-role-consolidation.md). RENAME VALUE relabels
-- the enum in place, so every existing occurrence — profiles.role, orders
-- assigned_to, the notification_types.default_roles arrays — reads 'user'
-- afterwards with no data migration. Atomic and cheap.
--
-- RLS is untouched: it is generic (is_staff() = role <> 'client';
-- orders_update_assigned keys on assigned_to = my_role()), so a `user` behaves
-- exactly as the operator did.
--
-- The one place that hardcodes the production role list is notify_on_order_event
-- (20260908020000): it parses the assigned role out of the event text and checks
-- it against a literal set. After the rename that set must contain 'user', not
-- 'operator', or an order assigned to a user would notify nobody. It is
-- re-created below with the updated list; everything else in that function is
-- unchanged.
--
-- Idempotent: the RENAME is guarded so a re-run (or a DB already on 'user') is a
-- no-op.
-- =====================================================================

do $$
begin
  if exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'user_role' and e.enumlabel = 'operator'
  ) then
    alter type public.user_role rename value 'operator' to 'user';
  end if;
end $$;

-- Re-create the assignment classifier with 'user' in the recognised set.
create or replace function public.notify_on_order_event()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type    text;
  v_order   public.orders%rowtype;
  v_client  text;
  v_payload jsonb;
  v_roles   user_role[] := null;
  v_target  text;
begin
  v_type := case
    when new.type = 'new'      then 'order.new'
    when new.type = 'progress' then
      case when new.action ilike '%delivered%' then 'order.delivered' else 'order.progress' end
    when new.action ilike '%requested cancellation%' then 'order.cancel_requested'
    when new.action ilike '%returned to Admin%'      then 'order.awaiting_admin'
    when new.action ilike 'Admin assigned%'          then 'order.assigned'
    else null
  end;

  if v_type is null then return new; end if;

  select * into v_order from public.orders where id = new.order_id;
  select name into v_client from public.clients where code = v_order.client_code;

  if v_type = 'order.assigned' then
    v_target := substring(new.action from 'assigned .* to ([a-z_]+)');
    -- Parking back with Admin is already covered by order.awaiting_admin.
    if v_target is null or v_target = 'admin'
       or v_target not in ('screener','examiner','typer','delivery','user') then
      return new;
    end if;
    v_roles := array[v_target::user_role];
  end if;

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
    'assignedTo',   coalesce(v_target, v_order.assigned_to::text),
    'eta',          v_order.eta
  );

  perform public.enqueue_notification(
    v_type, new.order_id, v_payload,
    case when v_type in ('order.new', 'order.delivered')
         then coalesce(new.order_id, new.id::text)
         else new.id::text end,
    new.actor_email,
    v_roles);
  return new;
end $$;
