-- =====================================================================
-- Cloud SQL: remove what only made sense on Supabase
-- =====================================================================
-- Run AFTER supabase/migrations/*.sql. These objects are created by those
-- migrations and are actively wrong once Firebase owns identity and Cloud
-- Storage owns documents.
-- =====================================================================

-- ── 1. Identity provisioning belongs to the API now ────────────────────────
-- 20260601000000 hangs on_auth_user_created off auth.users so that GoTrue
-- signups provision a profile. Firebase does not write to this database at all,
-- so the trigger can never fire for a real signup -- but it DOES fire on the
-- mapping row the API inserts, and then fails or silently creates a half-formed
-- profile. Demonstrated: inserting a mapping row raised
--   ERROR: record "new" has no field "raw_user_meta_data"
-- and took the whole transaction with it.
--
-- The API creates the profile explicitly instead, in the same transaction as
-- the mapping row, which is also the only place the role can be decided safely.
drop trigger if exists on_auth_user_created on auth.users;
drop function if exists public.handle_new_user();

-- ── 2. Storage policies cannot be enforced from Postgres ───────────────────
-- Nine policies were written against storage.objects / storage.buckets. Cloud
-- Storage does not consult Postgres, so leaving them would be worse than
-- removing them: they would read as protection that is not there.
--
-- Document access control moves into the API, at the point where a signed URL
-- is minted -- the same check the policy expressed, in the one place that can
-- still enforce it. Nothing else may hand out a URL.
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    execute 'drop schema storage cascade';
  end if;
end $$;

-- ── 3. Prove RLS is actually on ────────────────────────────────────────────
-- A table with policies but RLS disabled silently serves every row. Cheap to
-- assert, expensive to discover in production.
do $$
declare bad text;
begin
  select string_agg(c.relname, ', ')
    into bad
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and exists (select 1 from pg_policy p where p.polrelid = c.oid)
     and not c.relrowsecurity;
  if bad is not null then
    raise exception 'tables carry policies but have RLS disabled: %', bad;
  end if;
end $$;

-- ── 4. Prove the API's roles work the way services/api/src/db.js uses them ──
-- Every request runs `SET LOCAL ROLE authenticated` (withUserClaims) and the
-- Firebase identity lookup runs `SET LOCAL ROLE service_role`
-- (withServiceRole). The previous bootstrap granted the app role
-- authenticated + anon but NOT service_role, so every sign-in failed with
-- "permission denied to set role" on a database it had built. Each property
-- below is one the app depends on, asserted rather than assumed; any failure
-- aborts with a nonzero exit.
--
-- Needs the same setting as 01_bootstrap.sql (bootstrap.sh passes it):
--   PGOPTIONS="-c resolute.app_user=<role>"
do $$
declare
  u   text := nullif(current_setting('resolute.app_user', true), '');
  app pg_roles%rowtype;
  svc pg_roles%rowtype;
begin
  if u is null then
    raise exception 'post-migrate: resolute.app_user is not set';
  end if;
  select * into app from pg_roles where rolname = u;
  if not found then
    raise exception 'post-migrate: app role % does not exist', u;
  end if;
  if app.rolsuper or app.rolbypassrls then
    raise exception 'post-migrate: app role % is a superuser or BYPASSRLS; RLS would not apply', u;
  end if;
  if app.rolinherit then
    raise exception 'post-migrate: app role % must be NOINHERIT', u;
  end if;
  if not pg_has_role(u, 'authenticated', 'MEMBER') then
    raise exception 'post-migrate: app role % cannot SET ROLE authenticated (every request would fail)', u;
  end if;
  if not pg_has_role(u, 'service_role', 'MEMBER') then
    raise exception 'post-migrate: app role % cannot SET ROLE service_role (every sign-in would fail)', u;
  end if;

  select * into svc from pg_roles where rolname = 'service_role';
  if not svc.rolbypassrls or svc.rolcanlogin then
    raise exception 'post-migrate: service_role must be NOLOGIN BYPASSRLS';
  end if;
  if not (has_table_privilege('service_role', 'auth.users', 'SELECT')
          and has_table_privilege('service_role', 'public.profiles', 'SELECT')) then
    raise exception 'post-migrate: service_role cannot read auth.users/profiles; identity resolution would fail';
  end if;

  -- The identity map holds every Firebase UID and sign-in email and has no RLS.
  if has_table_privilege('authenticated', 'auth.users', 'SELECT')
     or has_table_privilege('anon', 'auth.users', 'SELECT') then
    raise exception 'post-migrate: auth.users is readable by a session role';
  end if;
end $$;

-- ── 5. No SECURITY DEFINER function is executable by PUBLIC ────────────────
-- 20260915000000 asserts this at the end of its own run; re-assert after the
-- whole sequence, since a later migration can add a definer function and
-- 20260722000000's default privileges grant EXECUTE on every new function.
do $$
declare bad text;
begin
  select string_agg(p.oid::regprocedure::text, ', ' order by 1)
    into bad
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.prosecdef
     and has_function_privilege('public', p.oid, 'EXECUTE');
  if bad is not null then
    raise exception 'post-migrate: SECURITY DEFINER functions executable by PUBLIC: %', bad;
  end if;
end $$;
