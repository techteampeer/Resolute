-- Client notifications = client-facing milestones only. Internal pipeline steps
-- (screening/examining/typing handoffs, admin routing/approvals, delivery
-- close-out, payouts) must never reach a client. We tag every event with an
-- audience and let a client read only client/all events for their own orders.

-- 1) audience column (defaults to 'staff' → existing rows become staff-only).
alter table public.order_events add column if not exists audience text not null default 'staff';
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'order_events_audience_chk') then
    alter table public.order_events
      add constraint order_events_audience_chk check (audience in ('staff', 'client', 'all'));
  end if;
end $$;

-- 2) Backfill: hide all pre-existing internal entries from clients (the default
--    already set them to 'staff'), but keep the server-generated "order placed"
--    receipts client-visible so clients don't lose their order confirmations.
update public.order_events
  set audience = 'client'
  where type = 'new' and action ~* 'placed';

-- 3) Client reads ONLY client/all events for their own orders.
drop policy if exists order_events_client_read on public.order_events;
create policy order_events_client_read on public.order_events for select
  using (
    order_id is not null
    and audience in ('client', 'all')
    and exists (
      select 1 from public.orders o
      where o.id = order_events.order_id
        and o.client_code = public.my_client_code()
    )
  );

-- 4) The order-placed trigger emits a client-facing receipt.
create or replace function public.log_order_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_events (order_id, action, type, actor, audience)
  values (new.id, 'Order ' || new.id || ' placed (' || coalesce(new.type, 'Search') || ')', 'new', null, 'client');
  return new;
end;
$$;
