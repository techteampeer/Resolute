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
-- constrains the target.
drop policy if exists orders_update_assigned on public.orders;
create policy orders_update_assigned on public.orders for update
  using (public.can_work_production() and assigned_to = 'user'::public.user_role)
  with check (public.is_staff());

-- ── 4. Keep the pipeline ordered under the wider pool policy ─────────────────
-- Before D3, orders_update_assigned scoped a non-admin write to ONE desk, so a
-- staffer could only terminal-jump (clear the desk => delivered) an order that
-- was already on their stage. Now that a `user` may write any order in the pool,
-- guard_order_handoff must itself enforce that the terminal transition only
-- happens FROM the delivery stage — otherwise a pooled user could PATCH an order
-- still in screening straight to {assigned_to: null, status: delivered}, skipping
-- examination/typing/delivery. Extend the guard (everything else is byte-for-byte
-- the 20260921000000 version; only the new terminal-stage check is added). It
-- reads the OLD (stored) row, which the caller cannot forge, so faking
-- completed_dates in the same PATCH does not help.
create or replace function public.guard_order_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_seq  text[] := array['screener', 'examiner', 'typer', 'delivery'];
  v_old  jsonb  := coalesce(old.completed_dates, '{}'::jsonb);
  v_new  jsonb  := coalesce(new.completed_dates, '{}'::jsonb);
  v_next text;
  k      text;
begin
  -- Only guard direct end-user REST writes; RPCs (owner), service role and
  -- migrations/seed are trusted and pass through.
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Admins may reassign/route freely; their writes use orders_write_admin.
  if public.is_admin() then
    return new;
  end if;

  -- From here: a non-admin staff member updating an order in the pool.

  -- 1. An order can never be moved to another client.
  if new.client_code is distinct from old.client_code then
    raise exception 'an order cannot be reassigned to a different client';
  end if;

  -- 2. Legitimate handoff targets only: back to Admin ('admin'), completed /
  --    unassigned (null, delivery completion), or the same desk (mid-stage save).
  --    Handing directly to any OTHER live desk is refused — that skips the gate.
  if new.assigned_to is not null
     and new.assigned_to <> 'admin'
     and new.assigned_to is distinct from old.assigned_to then
    raise exception
      'a stage hands an order back to Admin, not directly to another desk (assigned_to must be admin, unchanged, or cleared)';
  end if;

  -- 3. The pipeline advances ONE stage at a time, in order. completed_dates may
  --    gain at most the single NEXT-stage date and must never lose or rewrite an
  --    earlier one. Without this a pooled user could back-fill all three
  --    pre-delivery dates in one PATCH (or over several) and then clear the desk,
  --    skipping the pipeline — trusting completed_dates in check 4 is not enough
  --    because the same caller can modify that column. Enforcing the transition
  --    here makes it authoritative: stages can only be stamped in sequence.
  if v_new is distinct from v_old then
    select s into v_next
      from unnest(v_seq) with ordinality as t(s, ord)
     where v_old ->> s is null
     order by ord limit 1;
    -- No earlier stage date may be cleared or changed.
    for k in select jsonb_object_keys(v_old) loop
      if not (v_new ? k) or (v_new ->> k) is distinct from (v_old ->> k) then
        raise exception 'a completed stage date cannot be changed or cleared';
      end if;
    end loop;
    -- Any newly added date must be exactly the next stage due.
    for k in select jsonb_object_keys(v_new) loop
      if not (v_old ? k) and k is distinct from v_next then
        raise exception
          'stages complete in order — only the current stage (%) may be stamped', coalesce(v_next, 'none');
      end if;
    end loop;
  end if;

  -- 4. Clearing the desk (assigned_to => null) is the delivery-completion
  --    transition and nothing else for a pooled user. Valid only when it (a)
  --    writes status 'delivered' — so it can't leave an unassigned order in an
  --    earlier state — and (b) happens from the delivery stage: the three earlier
  --    stages must already be stamped on the STORED row. With check 3 enforcing
  --    ordered stamping, those three can only have arrived by working the pipeline
  --    in sequence. (Client/admin cancellations also clear the desk, but run as
  --    the RPC owner or admin and are handled by the short-circuits above.)
  if new.assigned_to is null and old.assigned_to is not null then
    if new.status is distinct from 'delivered' then
      raise exception
        'clearing an order''s desk is only valid on delivery completion (status must be delivered)';
    end if;
    if not (v_old ->> 'screener' is not null
            and v_old ->> 'examiner' is not null
            and v_old ->> 'typer'    is not null) then
      raise exception
        'an order can only be completed from the delivery stage — screening, examination and typing must be done first';
    end if;
  end if;

  return new;
end $$;

revoke execute on function public.guard_order_handoff() from public, anon, authenticated;
