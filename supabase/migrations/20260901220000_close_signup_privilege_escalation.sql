-- =====================================================================
-- Close the signup privilege escalation
-- =====================================================================
-- This migration exists in the production database but was never committed, so
-- any rebuild from this repo (a fresh environment, `supabase db reset`, or the
-- AWS pg_dump -> RDS re-apply) silently reopened both holes below. Recovered
-- from the live schema and committed so the history reproduces production.
--
-- Two ways an ordinary account could make itself an administrator:
--
-- 1. handle_new_user() took the new profile's role from the signup payload
--    (`coalesce((new.raw_user_meta_data->>'role')::user_role, 'client')`), and
--    /auth/v1/signup is public and takes arbitrary metadata:
--
--      POST /auth/v1/signup  {"email":…,"password":…,"data":{"role":"admin"}}
--        -> HTTP 200, and profiles.role = 'admin'
--
--    Role is an authorization input. It is granted by an administrator through
--    api/admin/users.js (service role), never claimed by the account being
--    created, so it is no longer read from metadata at all. The display name
--    still is: a name is not an authorization input.
--
-- 2. profiles_update_self allows a user to update their own row, with no column
--    restriction, so the account holder could set their own privilege columns:
--
--      PATCH /rest/v1/profiles?id=eq.<self>  {"role":"admin","super_admin":true}
--        -> HTTP 200, row updated
--
--    With super_admin true, client identity masking is off for that user
--    (displayClient), so every client's name, contact, email and phone becomes
--    readable. Rather than narrow the policy — which would also block the
--    legitimate self-service edits it exists for (name) — a BEFORE UPDATE
--    trigger rejects any change to the privilege columns unless the caller is
--    the service role, which is what the admin user-management endpoint uses.
-- =====================================================================

-- ── 1. Role is never claimed by the account being created ──────────────────
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, name, email, role, client_code, status)
  values (
    new.id,
    -- A display name is harmless: it is not an authorization input.
    coalesce(new.raw_user_meta_data->>'name', ''),
    new.email,
    -- Deliberately NOT read from metadata. Role is granted by an admin through
    -- api/admin/users.js, never claimed by the account being created.
    'client',
    null,
    'active')
  on conflict (id) do nothing;
  return new;
end $$;

-- ── 2. The account holder cannot grant themselves privileges ───────────────
create or replace function public.profiles_guard_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- The service role bypasses RLS and is what api/admin/users.js uses; it is
  -- the only caller allowed to change these columns.
  if current_setting('request.jwt.claim.role', true) is distinct from 'service_role'
     and auth.uid() is not null then
    if new.role        is distinct from old.role
       or new.super_admin is distinct from old.super_admin
       or new.client_code is distinct from old.client_code
       or new.status      is distinct from old.status then
      raise exception 'role, super_admin, client_code and status are set by an administrator, not by the account holder';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists profiles_guard_privileges on public.profiles;
create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.profiles_guard_privilege_columns();
