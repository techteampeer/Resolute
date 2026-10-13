-- =====================================================================
-- Tell the person the work was assigned to
-- =====================================================================
-- Every one of the six notification types routed to {admin}, and the event
-- classifier recognised only 'new', 'progress', "returned to Admin" and
-- "requested cancellation". Admin's assignment logs type='status' with the
-- action "Admin assigned RTS-… to screener · Sam Carter", which matched no
-- branch and therefore raised nothing.
--
-- Net effect, confirmed by draining the outbox after a full run: all 96 messages
-- went to the four admins and no screener, examiner, typer, delivery or Single
-- Seating account ever received anything. The one event that matters to a
-- production role — work landing in their queue — notified nobody, so staff had
-- to poll their own dashboard to discover they had work.
--
-- Routing for this type cannot be a static role list: the recipient is whichever
-- role the order was just assigned to. enqueue_notification() therefore takes an
-- optional role override, and the classifier reads the target role out of the
-- event action (see the note on the race in notify_on_order_event below).
-- =====================================================================

insert into public.notification_types (key, label, description, default_roles, default_mode, sort_order) values
  ('order.assigned', 'Work assigned to you',
   'Admin assigned an order to your desk. Routed to the role that received it, not to Admin.',
   '{}', 'immediate', 15)
on conflict (key) do update set
  label = excluded.label, description = excluded.description,
  default_roles = excluded.default_roles, default_mode = excluded.default_mode,
  sort_order = excluded.sort_order;

-- p_roles overrides the type's default_roles when the audience is dynamic.
-- Existing five-argument callers are unaffected (it defaults to null).
create or replace function public.enqueue_notification(
  p_type_key text, p_order_id text, p_payload jsonb, p_dedupe_seed text,
  p_exclude_email text default null, p_roles user_role[] default null)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type   public.notification_types%rowtype;
  v_roles  user_role[];
  v_count  int := 0;
  r        record;
begin
  select * into v_type from public.notification_types where key = p_type_key;
  if not found then return 0; end if;

  v_roles := coalesce(p_roles, v_type.default_roles);
  if v_roles is null or cardinality(v_roles) = 0 then return 0; end if;

  for r in
    select p.id, p.email, p.name, p.role,
           coalesce(np.mode, v_type.default_mode) as mode
    from public.profiles p
    left join public.notification_preferences np
      on np.profile_id = p.id and np.type_key = p_type_key
    where p.role = any (v_roles)
      and p.status = 'active'
      and p.email is not null
      and p.email <> ''
      -- Never notify someone about their own action.
      and (p_exclude_email is null or lower(p.email) <> lower(p_exclude_email))
      and coalesce(np.mode, v_type.default_mode) <> 'off'
  loop
    insert into public.notification_outbox
      (type_key, order_id, recipient_id, recipient_email, recipient_name, recipient_role, mode, payload, dedupe_key)
    values
      (p_type_key, p_order_id, r.id, r.email, r.name, r.role, r.mode, p_payload,
       p_type_key || ':' || p_dedupe_seed || ':' || r.id::text)
    on conflict (dedupe_key) do nothing;
    v_count := v_count + 1;
  end loop;

  return v_count;
end $$;

revoke execute on function public.enqueue_notification(text, text, jsonb, text, text, user_role[]) from anon, authenticated;

-- Drop the five-argument version this one replaces.
--
-- `create or replace` with an added parameter creates an OVERLOAD, not a
-- replacement, so both signatures end up on the database. A five-argument call
-- then matches both candidates -- the 5-arg exactly, and the 6-arg via its
-- default -- and Postgres refuses to choose:
--
--   ERROR:  function public.enqueue_notification(unknown, text, jsonb, text, unknown) is not unique
--   HINT:   Could not choose a best candidate function.
--
-- notify_on_client_message() still makes exactly that call, and it runs in an
-- AFTER INSERT trigger, so the error aborts the insert rather than just losing a
-- notification: a client could not send a support message at all. Per CLAUDE.md
-- the portal is the only channel a client has, so that is the whole of client
-- communication, and nothing in the UI would have explained it.
--
-- Reproduced against a local database with both signatures present, and the
-- insert confirmed working again once this drop is in place. The remaining
-- five-argument callers resolve to the function above with p_roles defaulting to
-- null, which coalesces to the type's default_roles -- their existing behaviour.
drop function if exists public.enqueue_notification(text, text, jsonb, text, text);

-- Classify an assignment, and route it to the role that received the work.
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

  -- The audience for an assignment is the role that received the work. It is
  -- read out of the action text rather than from orders.assigned_to, because the
  -- app writes the order UPDATE and the order_events INSERT as two independent
  -- un-awaited calls: the event frequently lands first, and the row would still
  -- read 'admin', so the notification was skipped. The action text is written in
  -- the same statement as the event, so it cannot race.
  -- Format: "Admin assigned RTS-10051 to screener · Sam Carter"
  if v_type = 'order.assigned' then
    v_target := substring(new.action from 'assigned .* to ([a-z_]+)');
    -- Parking back with Admin is already covered by order.awaiting_admin.
    if v_target is null or v_target = 'admin'
       or v_target not in ('screener','examiner','typer','delivery','operator') then
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
    -- For an assignment, the target role comes from the action text, not the row:
    -- the row may not have been updated yet (see the race note above), which made
    -- the mail read "Now with: admin" in the message telling a screener it was theirs.
    'assignedTo',   coalesce(v_target, v_order.assigned_to::text),
    'eta',          v_order.eta
  );

  -- Idempotency seed. Usually the event's own id — each stage completion is a
  -- distinct thing worth hearing about.
  --
  -- 'order.new' and 'order.delivered' key on the ORDER instead, because they can
  -- only meaningfully happen once and the app writes them twice: placing an
  -- order fires log_order_created() in the database AND OrderContext's own
  -- log(), so there are two type='new' rows per order. Both are wanted in the
  -- audit trail (they carry different audiences), but they are one piece of
  -- news, and without this every new order would mail Admin twice.
  perform public.enqueue_notification(
    v_type, new.order_id, v_payload,
    case when v_type in ('order.new', 'order.delivered')
         then coalesce(new.order_id, new.id::text)
         else new.id::text end,
    new.actor_email,
    v_roles);
  return new;
end $$;
