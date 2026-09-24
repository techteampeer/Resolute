-- =====================================================================
-- D3 — retire the four stage LOGIN roles; the production desk is the one
-- production login. (ADR 0001, workstream D. Follows D1 rename + D2 UI.)
-- =====================================================================
-- After D1 (operator->user) and D2 (the /user "Production Desk" is the standard
-- workspace and Admin's default routing target), the four stage roles
-- (screener/examiner/typer/delivery) are no longer login roles — a single
-- `user` works an order through whichever stage is next, with the Admin
-- approval gate between phases. The stage NAMES survive only as pipeline-stage
-- identifiers (ROLE_SEQUENCE / statusForRole / roleAfter — application code and
-- the derived `completed_dates`), never as an account's role.
--
-- This migration lands the auth-critical half:
--   1. Re-role every existing stage account to `user`.
--   2. Re-point any in-flight order still sitting on a stage desk into the
--      production pool, so it stays actionable under the new policy.
--   3. Replace orders_update_assigned's role==queue coupling
--      (`assigned_to = my_role()`) with an explicit production-capability check.
--
-- Deliberately UNCHANGED (never weakened here):
--   • admin / super-admin order writes (orders_write_admin = is_admin()).
--   • the Vivek-only money controls (can_confirm_payments + the payout /
--     subscription / payment-confirmation guards).
--   • the F2 handoff trigger (guard_order_handoff, 20260921000000): it is
--     role-agnostic — it already permits exactly a production user's legitimate
--     writes (mid-stage save = assigned_to unchanged, return-to-Admin =
--     'admin', delivery completion = null) and blocks cross-client moves and
--     desk-to-desk skips. It keeps enforcing the Admin gate for `user` too.
--   • the client-reply access split (support_admin_reply vs support_staff_note).
--
-- The `user_role` enum keeps its stage labels: Postgres cannot drop an enum
-- value, and they remain valid as historical `assigned_to` values / pipeline
-- identifiers. Nothing new is ever assigned them.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- ── 1. Existing stage accounts become production users ──────────────────────
-- A migration/psql session has a null auth.uid(), so profiles_guard_privilege_
-- columns() (which blocks end-user role changes) passes this through. On a fresh
-- CI stack `profiles` is still empty here (seed runs after migrations); on a
-- real database this re-roles the live screener/examiner/typer/delivery staff.
update public.profiles
   set role = 'user'
 where role in ('screener', 'examiner', 'typer', 'delivery');

-- ── 2. In-flight orders on a stage desk move into the production pool ────────
-- Their pipeline position is derived from completed_dates (nextRoleFor), not
-- from assigned_to, so routing them to the `user` pool preserves the stage a
-- user picks them up at. Without this they would be stranded: no account holds a
-- stage role any more, and the new policy below scopes writes to the user pool.
-- Runs as the migration superuser, so guard_order_handoff() no-ops (its
-- current_user <> 'authenticated' short-circuit).
update public.orders
   set assigned_to = 'user',
       workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{singleSeating}', 'true'::jsonb, true)
 where assigned_to in ('screener', 'examiner', 'typer', 'delivery');

-- ── 3. Authorization: an explicit production-capability check ────────────────
-- orders_update_assigned was `is_staff() and assigned_to = my_role()`. That
-- coupled the queue name to the login-role name — which only worked because the
-- two happened to be equal. With the stage roles retired, express the intent
-- directly: a production user may act on an order sitting in the production pool.
-- SECURITY DEFINER + granted to the querying roles, exactly like the other RLS
-- helpers (see 20260915000000): Postgres checks EXECUTE on a policy's functions
-- against the querying role, so anon/authenticated must keep the grant.
create or replace function public.can_work_production()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'user', false) $$;

revoke execute on function public.can_work_production() from public;
grant  execute on function public.can_work_production() to anon, authenticated;

-- A production user may UPDATE an order that is currently in the user pool.
-- The WITH CHECK stays is_staff() (as before): the legitimate handoffs move
-- assigned_to AWAY from the pool (to 'admin', or null on delivery), so a strict
-- new-row test would break every handoff — guard_order_handoff() is what
-- constrains the target, and it is unchanged.
drop policy if exists orders_update_assigned on public.orders;
create policy orders_update_assigned on public.orders for update
  using (public.can_work_production() and assigned_to = 'user'::public.user_role)
  with check (public.is_staff());
