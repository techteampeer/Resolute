-- =====================================================================
-- Take EXECUTE away from PUBLIC on every SECURITY DEFINER function
-- =====================================================================
-- Every function is created with EXECUTE granted to PUBLIC. Revoking it from
-- `anon` does nothing while that default stands: anon is a member of PUBLIC, so
-- the grant it inherits is still there. 20260908010000 and 20260908020000 both
-- did exactly that -- `revoke execute ... from anon` -- and left the function
-- reachable anyway.
--
-- 20260909000000 already describes this mechanism and fixes it for is_admin(),
-- is_staff(), my_role() and my_client_code(). It simply was never applied to the
-- functions those two migrations introduced.
--
-- What that left open, confirmed against production by calling it as `anon`:
--
--   set local role anon;
--   select public.enqueue_notification('order.new', null, '{"probe":1}'::jsonb,
--                                      'probe', null, null);   -- returned 4
--
-- Four rows into notification_outbox, one per admin, with a payload the caller
-- chose, from an unauthenticated session -- reachable over the internet as
-- POST /rest/v1/rpc/enqueue_notification with nothing but the public anon key.
-- (The probe ran in a transaction and was rolled back.)
--
-- Nothing drains the outbox today, so no mail was or could be sent. This is
-- worth a migration rather than a note because of what happens when the drain is
-- switched on, which is a planned step: the same call then becomes "anyone on
-- the internet can email Resolute staff arbitrary content", and the rows would
-- already be queued.
--
-- SECOND FINDING, and the reason this migration is broader than those two
-- functions. Production has ten further SECURITY DEFINER functions whose PUBLIC
-- grant is already revoked -- claim_notifications, handle_new_user,
-- log_order_created, mark_notification_sent/failed, notify_on_order_event,
-- notify_on_client_message, profiles_guard_privilege_columns, next_order_id,
-- is_super_admin -- and NO migration in this repo performs those revokes. The
-- hardening was applied out of band, like 20260909120000 before it. A database
-- rebuilt from this directory was therefore materially less locked down than
-- production: a fresh environment would expose the notification drain functions
-- and the signup guard to anon. Restated explicitly below so the repo
-- reproduces production rather than trailing it.
--
-- The trigger functions in the list are the least interesting -- calling one
-- directly raises "trigger functions can only be called as triggers" -- but they
-- carry the same accidental grant, and a long advisor list is somewhere a real
-- finding can hide.
-- =====================================================================

-- ── Nothing outside the database may call these ───────────────────────────
-- Each is reached either from a trigger or from the service role. A trigger
-- function is invoked by Postgres itself and an internal call from another
-- SECURITY DEFINER function does not test the caller's EXECUTE privilege, so
-- none of these grants was ever load-bearing.
revoke execute on function
  public.enqueue_notification(text, text, jsonb, text, text, user_role[])
  from public, anon, authenticated;

revoke execute on function public.guard_payout_paid()              from public, anon, authenticated;
revoke execute on function public.guard_subscription_paid()        from public, anon, authenticated;
revoke execute on function public.guard_payment_confirmation()     from public, anon, authenticated;
revoke execute on function public.fulfillments_stamp_author()      from public, anon, authenticated;
revoke execute on function public.notify_on_order_event()          from public, anon, authenticated;
revoke execute on function public.notify_on_client_message()       from public, anon, authenticated;
revoke execute on function public.log_order_created()              from public, anon, authenticated;
revoke execute on function public.handle_new_user()                from public, anon, authenticated;
revoke execute on function public.profiles_guard_privilege_columns() from public, anon, authenticated;
revoke execute on function public.claim_notifications(text, integer)  from public, anon, authenticated;
revoke execute on function public.mark_notification_sent(bigint)      from public, anon, authenticated;
revoke execute on function public.mark_notification_failed(bigint, text) from public, anon, authenticated;

-- ── Callable, but only by a signed-in user ────────────────────────────────
revoke execute on function public.can_confirm_payments() from public, anon;
grant  execute on function public.can_confirm_payments() to authenticated;

revoke execute on function public.next_order_id() from public, anon;
grant  execute on function public.next_order_id() to authenticated;

-- ── The RLS helpers must KEEP their grants ────────────────────────────────
-- They are named inside the policies protecting every table, and Postgres checks
-- EXECUTE on a function in a policy expression against the QUERYING role. So
-- revoking these hardens nothing; it turns every anonymous read into
--   401 {"code":"42501","message":"permission denied for function my_client_code"}
-- which is worse than before, because the error also names the policy's
-- internals. Called directly by anon they answer false / false / null / null --
-- there is nothing behind the grant to reach.
--
-- Granted explicitly to the two roles rather than left to PUBLIC, so the
-- assertion below can hold without exceptions. Written out because the natural
-- instinct on reading this file is to add them to the list above.
revoke execute on function
  public.is_admin(), public.is_staff(), public.my_role(),
  public.my_client_code(), public.is_super_admin()
  from public;
grant execute on function
  public.is_admin(), public.is_staff(), public.my_role(),
  public.my_client_code(), public.is_super_admin()
  to anon, authenticated;

-- ── Assert it actually holds ──────────────────────────────────────────────
-- Not a formality: this migration's whole subject is a grant nobody wrote and
-- everybody forgets, so the next function added here will have it too.
do $$
declare bad text;
begin
  select string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')', ', '
                    order by p.proname)
    into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and has_function_privilege('public', p.oid, 'EXECUTE');
  if bad is not null then
    raise exception
      'SECURITY DEFINER functions still executable by PUBLIC: %', bad;
  end if;
end $$;
