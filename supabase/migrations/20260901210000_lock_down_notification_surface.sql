-- =====================================================================
-- Lock down the notification surface
-- =====================================================================
-- This migration exists in the production database but was never committed,
-- so any rebuild from this repo (a fresh environment, `supabase db reset`, or
-- the AWS pg_dump -> RDS re-apply) silently reopened the hole below. Recovered
-- from the live schema and committed so the history reproduces production.
--
-- notification_types decides WHO gets told about WHAT. The notification_system
-- migration granted `select` on it to `authenticated`, but a table created in
-- `public` also inherits Supabase's default privileges for `anon` and
-- `authenticated`, and RLS was never enabled on it. The grant was therefore
-- additive to full read/write access rather than a restriction, and the table
-- was writable through the browser API by anyone with an account:
--
--   as client@resolute.com:
--     PATCH /rest/v1/notification_types?key=eq.order.new
--       {"default_roles":["client"]}            -> HTTP 200, routing rewritten
--     DELETE /rest/v1/notification_types?key=eq.order.delivered
--                                               -> HTTP 200, type deleted (6 -> 5 rows)
--
-- A client could silence the staff notification system, or aim staff
-- notifications at clients — which would also breach the rule that clients are
-- never contacted by email (CLAUDE.md). Routing is configuration, not user data:
-- staff may read it, and nothing reaches it from a browser.
--
-- The outbox itself was already correct (RLS on, zero policies, revoked from
-- anon and authenticated) and is untouched here.
-- =====================================================================

-- Staff read the routing table; nobody writes it through the API. RLS is
-- enabled with exactly one SELECT policy, so INSERT/UPDATE/DELETE have no
-- policy to satisfy and are denied outright.
alter table public.notification_types enable row level security;

drop policy if exists notif_types_staff_read on public.notification_types;
create policy notif_types_staff_read on public.notification_types
  for select using (public.is_staff());

-- Belt and braces: strip the inherited table privileges too, so the table is
-- unreachable for anon and read-only for authenticated even before RLS runs.
-- `anon` has no business here at all — routing is never read before sign-in.
revoke all on public.notification_types from anon;
revoke insert, update, delete, truncate on public.notification_types from authenticated;
grant select on public.notification_types to authenticated;
