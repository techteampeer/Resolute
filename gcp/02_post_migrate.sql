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
