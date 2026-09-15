-- =====================================================================
-- Change notifications, in place of Supabase Realtime
-- =====================================================================
-- The SPA subscribed to postgres_changes on `orders` and `support_messages`.
-- Both callbacks did the same thing: refetch. So all that is needed is a signal,
-- and Postgres has one natively.
--
-- Deliberately in gcp/ and NOT in supabase/migrations/: the SSE endpoint that
-- consumes this only exists in the Express server, which runs on Cloud Run. The
-- live Supabase project has no use for these triggers, and everything in
-- supabase/migrations/ is applied to it by `supabase db push`.
--
-- pg_notify's payload is capped at 8000 bytes, so only the table and the row id
-- are sent -- never the row. The client refetches through the API, where RLS
-- applies. Sending row data here would leak it: NOTIFY has no row-level
-- security, and every listener receives every message regardless of who they are.

create or replace function public.notify_portal_change()
returns trigger
language plpgsql
as $$
begin
  perform pg_notify(
    'portal_changes',
    json_build_object(
      'table', tg_table_name,
      'op', tg_op,
      'id', coalesce(new.id::text, old.id::text)
    )::text
  );
  return coalesce(new, old);
end $$;

drop trigger if exists orders_notify_change on public.orders;
create trigger orders_notify_change
  after insert or update or delete on public.orders
  for each row execute function public.notify_portal_change();

drop trigger if exists support_messages_notify_change on public.support_messages;
create trigger support_messages_notify_change
  after insert on public.support_messages
  for each row execute function public.notify_portal_change();

-- Not SECURITY DEFINER and not callable by anyone: it only ever runs as a
-- trigger, and 20260915000000 exists because functions are created with EXECUTE
-- granted to PUBLIC by default.
revoke execute on function public.notify_portal_change() from public, anon, authenticated;
