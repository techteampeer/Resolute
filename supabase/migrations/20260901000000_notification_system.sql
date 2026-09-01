-- Notification system — the whole cycle, defined in one migration.
--
-- CLAUDE.md requires that email is NOT reintroduced piecemeal, so this defines
-- the complete path up front: an event happens → the DB fans it out to one
-- outbox row per recipient → a sender drains the outbox. Nothing in here knows
-- or cares which provider sends the mail or where the sender runs, which is
-- what makes the Vercel→AWS move a change of one adapter file.
--
-- Why fan-out happens in SQL rather than in the app:
--   • Every write path already lands in order_events — the client cancel RPC,
--     the admin actions, the stage completions. Fanning out here catches all of
--     them, including the SECURITY DEFINER RPCs a client triggers, which the
--     browser could never enqueue itself under RLS.
--   • One outbox row per recipient gives per-person retry and a dedupe key, so
--     a re-run of the sender cannot double-send.
--
-- The outbox is service-role only. It holds staff email addresses and order
-- context; no browser session — client or staff — may read or write it.

-- ---------------------------------------------------------------------------
-- 1. The client's own file number, captured at intake.
-- ---------------------------------------------------------------------------
-- Clients track work by THEIR reference, not ours. Carrying it lets a
-- notification subject read "CL04-2291 · RTS-10049" so the team can match an
-- email to the client's system without opening the portal.
alter table public.orders add column if not exists client_file_no text;
comment on column public.orders.client_file_no is
  'The client''s own file/reference number, captured at intake. Display only — never an identifier we join on.';

-- ---------------------------------------------------------------------------
-- 2. What a notification can be about.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_types (
  key          text primary key,
  label        text not null,
  description  text,
  -- Roles that receive this by default. A user's own preference overrides it.
  default_roles user_role[] not null default '{}',
  -- 'immediate' sends on the next drain; 'digest' waits for the daily roll-up.
  default_mode text not null default 'digest' check (default_mode in ('immediate','digest','off')),
  sort_order   int not null default 0
);

insert into public.notification_types (key, label, description, default_roles, default_mode, sort_order) values
  ('order.new',              'New order placed',
   'A client submitted a new order. It is parked with Admin for confirmation.',
   '{admin}',                                   'immediate', 10),
  ('order.progress',         'Stage completed',
   'A production role finished its stage and handed the order on.',
   '{admin}',                                   'digest',    20),
  ('order.awaiting_admin',   'Awaiting Admin approval',
   'An order returned to Admin and cannot advance until someone assigns it.',
   '{admin}',                                   'immediate', 30),
  ('order.delivered',        'Order delivered',
   'The completed package reached the client and the invoice was released.',
   '{admin}',                                   'immediate', 40),
  ('order.cancel_requested', 'Cancellation requested',
   'A client asked to cancel an order that is already in production.',
   '{admin}',                                   'immediate', 50),
  ('message.client',         'Client message',
   'A client wrote in the portal. Only Admins can reply.',
   '{admin}',                                   'immediate', 60)
on conflict (key) do update set
  label = excluded.label, description = excluded.description,
  default_roles = excluded.default_roles, sort_order = excluded.sort_order;

-- ---------------------------------------------------------------------------
-- 3. Per-person preferences — every role, not just Admin.
-- ---------------------------------------------------------------------------
-- A row here overrides the type's default_mode for one person. No row means
-- "use the default", so an empty table is a working system.
create table if not exists public.notification_preferences (
  profile_id uuid not null references public.profiles(id) on delete cascade,
  type_key   text not null references public.notification_types(key) on delete cascade,
  mode       text not null check (mode in ('immediate','digest','off')),
  updated_at timestamptz not null default now(),
  primary key (profile_id, type_key)
);

alter table public.notification_preferences enable row level security;

-- Everyone manages their own; Admins may read all so they can see who is on
-- what. Nobody edits anyone else's — an Admin muting a colleague's alerts
-- silently is exactly the failure this avoids.
drop policy if exists notif_pref_own_read   on public.notification_preferences;
drop policy if exists notif_pref_own_write  on public.notification_preferences;
drop policy if exists notif_pref_own_update on public.notification_preferences;
drop policy if exists notif_pref_own_delete on public.notification_preferences;

create policy notif_pref_own_read on public.notification_preferences
  for select using (profile_id = auth.uid() or public.is_admin());
create policy notif_pref_own_write on public.notification_preferences
  for insert with check (profile_id = auth.uid());
create policy notif_pref_own_update on public.notification_preferences
  for update using (profile_id = auth.uid()) with check (profile_id = auth.uid());
create policy notif_pref_own_delete on public.notification_preferences
  for delete using (profile_id = auth.uid());

grant select, insert, update, delete on public.notification_preferences to authenticated;
grant select on public.notification_types to authenticated;

-- ---------------------------------------------------------------------------
-- 4. The outbox — one row per recipient per event.
-- ---------------------------------------------------------------------------
create table if not exists public.notification_outbox (
  id             bigint generated always as identity primary key,
  type_key       text not null references public.notification_types(key),
  order_id       text,
  recipient_id   uuid references public.profiles(id) on delete cascade,
  recipient_email text not null,
  recipient_name  text,
  -- Carried so the renderer can apply the client-identity masking rule without
  -- a second lookup: only admins see client names, everyone else sees codes.
  recipient_role  user_role,
  mode           text not null check (mode in ('immediate','digest')),
  -- Everything the renderer needs, frozen at fan-out time. Templates must not
  -- re-read orders later: a digest sent at 6pm should describe what happened at
  -- 9am, not the order's state now.
  payload        jsonb not null default '{}'::jsonb,
  status         text not null default 'pending' check (status in ('pending','sending','sent','failed','cancelled')),
  attempts       int  not null default 0,
  last_error     text,
  -- Idempotency. A re-run of the sender, or a replayed trigger, collides here
  -- instead of sending twice.
  dedupe_key     text not null unique,
  created_at     timestamptz not null default now(),
  sent_at        timestamptz
);

create index if not exists notif_outbox_pending_idx
  on public.notification_outbox (mode, created_at) where status in ('pending','sending');
-- Set when a row is claimed, so a crashed run can be told apart from one still
-- in flight and reclaimed after a grace period.
alter table public.notification_outbox add column if not exists claimed_at timestamptz;
create index if not exists notif_outbox_order_idx on public.notification_outbox (order_id);

-- No policies at all: RLS on with zero policies denies every browser session.
-- Only the service role (which bypasses RLS) touches this table.
alter table public.notification_outbox enable row level security;
revoke all on public.notification_outbox from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Fan-out.
-- ---------------------------------------------------------------------------
-- Resolve recipients for a type and enqueue one row each. Skips anyone who has
-- turned the type off, anyone deactivated, and anyone without an address.
create or replace function public.enqueue_notification(
  p_type_key   text,
  p_order_id   text,
  p_payload    jsonb,
  p_dedupe_seed text,
  p_exclude_email text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_type   public.notification_types%rowtype;
  v_count  int := 0;
  r        record;
begin
  select * into v_type from public.notification_types where key = p_type_key;
  if not found then return 0; end if;

  for r in
    select p.id, p.email, p.name, p.role,
           coalesce(np.mode, v_type.default_mode) as mode
    from public.profiles p
    left join public.notification_preferences np
      on np.profile_id = p.id and np.type_key = p_type_key
    where p.role = any (v_type.default_roles)
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

revoke execute on function public.enqueue_notification(text, text, jsonb, text, text) from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Triggers — order events and client messages.
-- ---------------------------------------------------------------------------
-- order_events carries a coarse `type` ('new' | 'progress' | 'status'). That is
-- enough to classify everything except the two status events worth an immediate
-- alert, which the action text identifies unambiguously because the app writes
-- both strings in exactly one place each (OrderContext.resolveCancel /
-- returnToAdmin).
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
    when new.action ilike '%requested cancellation%' then 'order.cancel_requested'
    when new.action ilike '%returned to Admin%'      then 'order.awaiting_admin'
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
    new.actor_email);
  return new;
end $$;

-- actor_email lets the fan-out skip the person who caused the event. Nullable:
-- events raised by RPCs on a client's behalf have no staff actor.
alter table public.order_events add column if not exists actor_email text;

drop trigger if exists order_event_notify on public.order_events;
create trigger order_event_notify
  after insert on public.order_events
  for each row execute function public.notify_on_order_event();

-- Client messages. Internal staff notes must never raise one: they are not
-- client contact, and routing them as such would leak internal traffic into a
-- channel labelled "a client wrote in".
create or replace function public.notify_on_client_message()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_client  text;
  v_payload jsonb;
begin
  if new.sender <> 'client' then return new; end if;

  select name into v_client from public.clients where code = new.client_code;

  v_payload := jsonb_build_object(
    'orderId',    new.order_id,
    'clientCode', new.client_code,
    'clientName', v_client,
    'author',     new.author,
    'body',       left(coalesce(new.body, ''), 400),
    'occurredAt', new.created_at
  );

  perform public.enqueue_notification(
    'message.client', new.order_id, v_payload, new.id::text, null);
  return new;
end $$;

drop trigger if exists client_message_notify on public.support_messages;
create trigger client_message_notify
  after insert on public.support_messages
  for each row execute function public.notify_on_client_message();

-- ---------------------------------------------------------------------------
-- 7. Draining — what the sender calls.
-- ---------------------------------------------------------------------------
-- Claims a batch and moves it to 'sending' in one statement.
--
-- `for update skip locked` alone is not enough: it only holds rows for the life
-- of the transaction, so once the claim commits the rows would still read as
-- pending and an overlapping run would send them a second time. Flipping the
-- status is what makes the claim durable.
--
-- Rows stuck in 'sending' for over 15 minutes are reclaimed — that is a run
-- that died mid-drain, and without this they would never be sent. The window is
-- long enough that it cannot overlap a healthy run.
create or replace function public.claim_notifications(p_mode text, p_limit int default 100)
returns setof public.notification_outbox
language sql security definer set search_path = public as $$
  update public.notification_outbox o
     set status = 'sending', attempts = o.attempts + 1, claimed_at = now()
   where o.id in (
     select id from public.notification_outbox
      where mode = p_mode and attempts < 5
        and (status = 'pending'
             or (status = 'sending' and claimed_at < now() - interval '15 minutes'))
      order by created_at
      limit p_limit
      for update skip locked)
  returning o.*;
$$;

create or replace function public.mark_notification_sent(p_id bigint)
returns void language sql security definer set search_path = public as $$
  update public.notification_outbox
     set status = 'sent', sent_at = now(), last_error = null, claimed_at = null
   where id = p_id;
$$;

-- Back to pending so the next drain retries, until the attempt budget is spent.
-- A message is never dropped silently: it ends up either 'sent' or 'failed',
-- and 'failed' rows keep last_error for diagnosis.
create or replace function public.mark_notification_failed(p_id bigint, p_error text)
returns void language sql security definer set search_path = public as $$
  update public.notification_outbox
     set status = case when attempts >= 5 then 'failed' else 'pending' end,
         last_error = p_error, claimed_at = null
   where id = p_id;
$$;

revoke execute on function public.claim_notifications(text, int)        from anon, authenticated;
revoke execute on function public.mark_notification_sent(bigint)        from anon, authenticated;
revoke execute on function public.mark_notification_failed(bigint,text) from anon, authenticated;
