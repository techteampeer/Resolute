-- Restore the audience-aware client read policy that never reached main.
--
-- The `audience` column, this policy and the log_order_created() audience were
-- introduced together on 2026-07-29 in
-- `claude/supabase-mcp-integration-6ten6w`. That branch was applied to the
-- project but never merged, so the project has all three while main's migration
-- history has only what 20260722030000 defined — a client read policy with NO
-- audience filter.
--
-- Why that matters more than a tidy-up: rebuilding the schema from this repo
-- (a fresh environment, a staging copy, the AWS migration) would produce a
-- database where a client can read EVERY order_event on their own orders —
-- screening handoffs, admin routing decisions, approval and cancellation
-- chatter, delivery close-out. All of it internal, none of it meant for them.
-- The portal would look correct and quietly leak the pipeline.
--
-- Everything here is idempotent and matches what the project already has, so
-- this is a no-op there and a correction everywhere else.

-- The column, again defensively — 20260813000000 also adds it, and this file
-- must stand on its own if that one is ever reordered.
alter table public.order_events
  add column if not exists audience text not null default 'staff';

do $$ begin
  alter table public.order_events
    add constraint order_events_audience_chk check (audience in ('staff','client','all'));
exception when duplicate_object then null; end $$;

-- Clients read only client-facing events, and only on their own orders.
-- 'staff' events stay invisible to them; 'all' is the shared middle ground for
-- milestones both sides should see.
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

-- The server-side order receipt is client-facing by definition: it is the
-- client's own confirmation that the order was placed. Without this it defaults
-- to 'staff' and the client loses sight of their own order being created.
create or replace function public.log_order_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_events (order_id, action, type, actor, audience)
  values (new.id, 'Order ' || new.id || ' placed (' || coalesce(new.type, 'Search') || ')',
          'new', null, 'client');
  return new;
end;
$$;

revoke execute on function public.log_order_created() from anon, authenticated;
