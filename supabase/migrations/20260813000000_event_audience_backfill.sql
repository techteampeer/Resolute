-- Order events carry an `audience` ('staff' | 'client' | 'all') that decides
-- both client visibility (order_events_client_read) and who gets the email in
-- notifications. Until now nothing ever set it, so every row defaulted to
-- 'staff' and clients could see none of their own order history.
--
-- Backfill the existing rows from their action text. Idempotent: it only
-- promotes rows still sitting at the default.

-- The column was introduced on the branch claude/supabase-mcp-integration-6ten6w
-- (20260729000000_order_events_audience.sql), which was applied to the project
-- but never merged — so the project had the column while this history did not,
-- and the file failed on a fresh database, taking every later migration with
-- it. Adding it here makes this file self-contained; on a project that already
-- has the column it is a no-op. The policy and trigger that migration also
-- carried are restored in 20260901200000.
alter table public.order_events
  add column if not exists audience text not null default 'staff';
do $$ begin
  alter table public.order_events
    add constraint order_events_audience_check check (audience in ('staff','client','all'));
exception when duplicate_object then null; end $$;

-- Order placed → the client should see their own order appear.
update public.order_events
set audience = 'all'
where audience = 'staff'
  and (type = 'new' or action ilike 'new order%placed%');

-- Final delivery — the moment the client has been waiting for.
update public.order_events
set audience = 'all'
where audience = 'staff'
  and action ilike '%→ delivered%';

-- Outcome of a cancellation request: the client asked, so tell them.
update public.order_events
set audience = 'all'
where audience = 'staff'
  and (action ilike '%approved cancellation%' or action ilike '%declined cancellation%');

-- Client-initiated actions recorded by the SECURITY DEFINER RPCs.
update public.order_events
set audience = 'all'
where audience = 'staff'
  and (action ilike '%requested cancellation%' or action ilike '%cancelled%before screening%');

-- Everything else (assignment, stage hand-offs, returns to Admin) stays
-- 'staff': internal routing the client has no reason to see.

create index if not exists order_events_audience_idx on public.order_events(audience);
