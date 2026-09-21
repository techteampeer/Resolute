-- =====================================================================
-- Phase 0 hardening: close the privilege-escalation gap, lock the order-id
-- sequence, and make order handoffs server-authoritative.
-- =====================================================================
-- Three fixes, all reproducible over the REST API before this migration:
--
--   F1. can_confirm_payments was self-grantable. profiles_guard_privilege_columns
--       (20260901220000) rejects end-user changes to role/super_admin/client_code/
--       status, but can_confirm_payments was added LATER (20260908010000) and never
--       added to the guard. So any authenticated account could:
--         PATCH /profiles?id=eq.<self> {"can_confirm_payments": true}   -> 200
--       which, combined with the admin write policies (or F2 below for staff),
--       reopens the "only the billing owner confirms money" control. Add the
--       column to the guard.
--
--   F2. orders_update_assigned (20260601000000) is
--         using (is_staff() and assigned_to = my_role())
--         with check (is_staff())
--       The USING pins the write to an order on the caller's own desk, but the
--       WITH CHECK only re-asserts is_staff(). A staffer holding an order could
--       therefore, over the REST API, set ANY column to ANY value on it: move it
--       to another client (client_code), hand it to an arbitrary desk, or jump the
--       pipeline — bypassing the Admin approval gate entirely. Mirroring the desk
--       test into WITH CHECK is NOT the fix: the legitimate handoffs deliberately
--       change assigned_to away from my_role() (returnToAdmin -> 'admin',
--       delivery completion -> null), so a strict check would break every handoff.
--       Instead a BEFORE UPDATE trigger allows exactly the legitimate transitions
--       and blocks the two integrity vectors — cross-client moves and reassignment
--       to some other live desk — which also enforces the Admin gate in the DB.
--
--   F3 (amount validation) is a separate, larger change and is NOT in this
--   migration; see docs/ARCHITECTURE-ROADMAP.md workstream A.
--
--   Sequence grant. 20260722000000 did `grant all on all sequences ... to
--   authenticated`, which includes UPDATE — so a client can setval
--   public.order_id_seq and perturb order-id generation. Revoke UPDATE (keeps
--   USAGE+SELECT, so next_order_id() still works) and stop granting it by default.
--
-- Idempotent. Safe to re-run.
-- =====================================================================

-- ── F1. can_confirm_payments joins the protected privilege columns ──────────
create or replace function public.profiles_guard_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The service role bypasses RLS and is what api/admin/users.js uses; it is the
  -- only caller allowed to change these columns. A null auth.uid() is a migration
  -- / seed / psql session, which must not be blocked.
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and auth.uid() is not null then
    if new.role               is distinct from old.role
       or new.super_admin      is distinct from old.super_admin
       or new.client_code      is distinct from old.client_code
       or new.status           is distinct from old.status
       or new.can_confirm_payments is distinct from old.can_confirm_payments then
      raise exception
        'role, super_admin, client_code, status and can_confirm_payments are set by an administrator, not by the account holder';
    end if;
  end if;
  return new;
end $$;

-- The trigger itself (profiles_guard_privileges) was created in 20260901220000
-- and points at this function by name, so replacing the body is enough. Keep the
-- function off the RPC surface (it is trigger-only).
revoke execute on function public.profiles_guard_privilege_columns() from public, anon, authenticated;

-- ── Sequence lockdown: authenticated may read/advance, never setval ─────────
revoke update on all sequences in schema public from anon, authenticated;
alter default privileges in schema public revoke update on sequences from anon, authenticated;
-- next_order_id() is SECURITY DEFINER and runs as the owner, so nextval() there
-- is unaffected; USAGE+SELECT remain for any legitimate client read.

-- ── F2. Order handoffs are server-authoritative ─────────────────────────────
-- Runs as SECURITY INVOKER (the default) ON PURPOSE: current_user then reflects
-- the real caller. A direct PostgREST write by a logged-in user runs as the
-- 'authenticated' role; a write made INSIDE a SECURITY DEFINER RPC
-- (client_mark_payment / client_cancel_order / client_respond_clarification) runs
-- as the function owner, and migrations/seed run as the superuser. We only
-- constrain the first case — the sanctioned RPCs already check ownership
-- themselves, and admin/service writes are trusted.
--
-- NOTE (GCP): this, like the existing money guards, assumes the caller's role is
-- 'authenticated' for direct end-user writes. The future Cloud SQL API tier must
-- `set local role authenticated` per request (or this guard silently no-ops).
create or replace function public.guard_order_handoff()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  -- Only guard direct end-user REST writes. Everything else (RPCs run as owner,
  -- the service role, migrations/seed) is trusted and passes through.
  if current_user <> 'authenticated' then
    return new;
  end if;
  -- Admins may reassign/route freely (Assign modal, hold/resume, resolve-cancel);
  -- their writes go through orders_write_admin, not the assigned-desk policy.
  if public.is_admin() then
    return new;
  end if;

  -- From here: a non-admin staff member updating an order on their own desk
  -- (orders_update_assigned). Enforce the two integrity vectors.

  -- 1. An order can never be moved to another client.
  if new.client_code is distinct from old.client_code then
    raise exception 'an order cannot be reassigned to a different client';
  end if;

  -- 2. Legitimate handoff targets only: back to Admin for approval ('admin'),
  --    completed/unassigned (null, e.g. delivery completion), or keep the order
  --    on the current desk (mid-stage save). Handing it directly to any OTHER
  --    live desk/role is refused — that is what would skip the Admin gate.
  if new.assigned_to is not null
     and new.assigned_to <> 'admin'
     and new.assigned_to is distinct from old.assigned_to then
    raise exception
      'a stage hands an order back to Admin, not directly to another desk (assigned_to must be admin, unchanged, or cleared)';
  end if;

  return new;
end $$;

drop trigger if exists orders_guard_handoff on public.orders;
create trigger orders_guard_handoff
  before update on public.orders
  for each row execute function public.guard_order_handoff();

revoke execute on function public.guard_order_handoff() from public, anon, authenticated;
