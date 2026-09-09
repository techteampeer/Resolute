-- =====================================================================
-- Database housekeeping: duplicate constraint, per-row auth.uid(), FK indexes,
-- and the anon grant on the RLS helpers
-- =====================================================================

-- 1. order_events carries the same audience CHECK twice.
-- 20260813000000 added order_events_audience_check; 20260901200000 restored the
-- column and added order_events_audience_chk with an identical predicate. Both
-- exist in production, so every insert into the audit trail evaluates the same
-- test twice and psql prints the constraint twice on \d. Keep the first.
alter table public.order_events drop constraint if exists order_events_audience_chk;

-- 2. auth.uid() was being re-evaluated per row (Supabase's auth_rls_initplan).
-- Wrapping it in a scalar subquery lets the planner evaluate it once as an
-- InitPlan. Same predicate, same result — the profiles roster and every
-- notification-preference read just stop paying for it per row.
drop policy if exists notif_pref_own_read   on public.notification_preferences;
drop policy if exists notif_pref_own_write  on public.notification_preferences;
drop policy if exists notif_pref_own_update on public.notification_preferences;
drop policy if exists notif_pref_own_delete on public.notification_preferences;

create policy notif_pref_own_read on public.notification_preferences
  for select using (profile_id = (select auth.uid()) or public.is_admin());
create policy notif_pref_own_write on public.notification_preferences
  for insert with check (profile_id = (select auth.uid()));
create policy notif_pref_own_update on public.notification_preferences
  for update using (profile_id = (select auth.uid()))
          with check (profile_id = (select auth.uid()));
create policy notif_pref_own_delete on public.notification_preferences
  for delete using (profile_id = (select auth.uid()));

drop policy if exists profiles_read         on public.profiles;
drop policy if exists profiles_update_self  on public.profiles;

create policy profiles_read on public.profiles
  for select using (id = (select auth.uid()) or public.is_staff());
create policy profiles_update_self on public.profiles
  for update using (id = (select auth.uid()) or public.is_admin())
          with check (id = (select auth.uid()) or public.is_admin());

-- 3. Four foreign keys had no covering index. Each one is read on a hot path:
-- the outbox is drained by recipient, preferences are joined by type on every
-- enqueue, and fulfillments.updated_by is now written on every autosave. Without
-- an index a delete of the parent row also has to scan the child table.
create index if not exists notification_outbox_recipient_id_idx
  on public.notification_outbox (recipient_id);
create index if not exists notification_outbox_type_key_idx
  on public.notification_outbox (type_key);
create index if not exists notification_preferences_type_key_idx
  on public.notification_preferences (type_key);
create index if not exists fulfillments_updated_by_idx
  on public.fulfillments (updated_by);

-- 4. Make the grant on the RLS helpers explicit instead of implicit.
--
-- Supabase's security advisor flags anon as able to execute is_admin(),
-- is_staff(), my_role() and my_client_code(). Revoking it is the wrong move,
-- and this is what happens if you do: these four are named inside the RLS
-- policies that protect the tables, and Postgres checks EXECUTE on a function
-- in a policy expression against the *querying* role. With the grant removed,
-- every anonymous read stopped returning an empty set and started returning
--
--   HTTP 401 {"code":"42501","message":"permission denied for function my_client_code"}
--
-- on orders, profiles, order_events, fulfillments, clients, vendor_payouts,
-- support_messages and subscriptions — worse than before, since the error also
-- names the policy's internals. Called directly by anon the functions answer
-- false / false / null / null, because they all resolve through auth.uid():
-- there is nothing behind the grant to reach.
--
-- So keep the access and remove the guesswork: drop the default PUBLIC grant
-- that every function is created with, and name the two roles that need it.
revoke execute on function
  public.is_admin(), public.is_staff(), public.my_role(), public.my_client_code()
  from public;
grant execute on function
  public.is_admin(), public.is_staff(), public.my_role(), public.my_client_code()
  to anon, authenticated;
