-- =====================================================================
-- FA-2 — per-user capability grants (the authz store behind the admin panel).
-- =====================================================================
-- Phase A of the auth/permissions rework. Adds a place to store per-user
-- capability grants/revokes (the portable model in packages/domain/permissions.ts)
-- and protects it the same way the other privilege columns are protected.
--
--   profiles.permissions jsonb  — an array of
--     { "capability": "...", "effect": "grant"|"revoke", "scope": { "stages": [...] } }
--   Empty array = pure role+flags behaviour (today). An admin sets it via the
--   service-role user-management endpoint; the account holder can NEVER set it.
--
-- This is the "grant billing to one account" / "a trainee may only work the
-- screener stage" store. It is read onto the signed-in user (mapUser) and drives
-- can()/workableStages() in the UI; the critical rules (money, pipeline) stay
-- enforced by their own triggers regardless.
--
-- Idempotent. Safe to re-run. Dashboard-safe (no SELECT INTO).
-- =====================================================================

alter table public.profiles
  add column if not exists permissions jsonb not null default '[]'::jsonb;

-- Fold `permissions` into the existing privilege-column guard: only the service
-- role (api/admin/users.js) may change role / super_admin / client_code / status /
-- can_confirm_payments / permissions. A null auth.uid() is a migration/seed/psql
-- session and is not blocked. (Trigger profiles_guard_privileges already points
-- at this function by name — replacing the body is enough.)
create or replace function public.profiles_guard_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $fn$
begin
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and auth.uid() is not null then
    if new.role               is distinct from old.role
       or new.super_admin      is distinct from old.super_admin
       or new.client_code      is distinct from old.client_code
       or new.status           is distinct from old.status
       or new.can_confirm_payments is distinct from old.can_confirm_payments
       or new.permissions      is distinct from old.permissions then
      raise exception
        'role, super_admin, client_code, status, can_confirm_payments and permissions are set by an administrator, not by the account holder';
    end if;
  end if;
  return new;
end $fn$;

revoke execute on function public.profiles_guard_privilege_columns() from public, anon, authenticated;
