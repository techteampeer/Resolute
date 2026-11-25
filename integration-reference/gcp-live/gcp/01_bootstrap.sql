-- =====================================================================
-- Cloud SQL bootstrap: roles, the auth shim, and grants
-- =====================================================================
-- Run this ONCE against resolute_prod before applying supabase/migrations/*.sql.
--
-- Deliberately NOT in supabase/migrations/. Everything in that directory is
-- applied to the live Supabase project by `supabase db push`; none of this
-- belongs there, and putting it there would fire it at the wrong database.
--
-- Why this file has to exist at all: the existing policies are portable
-- Postgres, but they lean on four things Supabase provides and Cloud SQL does
-- not. Without the shims below, `supabase db push` against Cloud SQL fails on
-- the first GRANT and every policy that mentions auth.uid().
-- =====================================================================

-- ── 1. The roles the existing GRANTs already name ──────────────────────────
-- Supabase creates anon / authenticated / service_role; Cloud SQL does not, and
-- the migrations contain 26 GRANT/REVOKE statements naming them. They are
-- NOLOGIN: nothing connects as them; the app login SETs ROLE to them.
--
-- service_role has NO BYPASSRLS here. Creating a BYPASSRLS role needs a
-- superuser, which Cloud SQL does not provide, and nothing on GCP needs one:
-- the migrations' SECURITY DEFINER functions read past RLS as table owner. It
-- exists only as a GRANT target; nothing logs in as it or is a member of it.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin;
  end if;
end $$;

-- Refuse -- never repair -- compatibility roles more powerful than the ones
-- created above (e.g. a service_role left over with BYPASSRLS), or that are
-- members of another role (any membership is a SET ROLE path for the app login).
do $$
declare bad text;
begin
  select string_agg(rolname, ', ' order by rolname) into bad
    from pg_roles
   where rolname in ('anon', 'authenticated', 'service_role')
     and (rolcanlogin or rolsuper or rolbypassrls or rolcreaterole
          or rolcreatedb or rolreplication);
  if bad is not null then
    raise exception 'compatibility role(s) % carry LOGIN/SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION -- fix them by hand and re-run; the bootstrap does not alter existing roles', bad;
  end if;

  select string_agg(r.rolname || ' -> ' || g.rolname, ', ' order by r.rolname) into bad
    from pg_auth_members m
    join pg_roles r on r.oid = m.member
    join pg_roles g on g.oid = m.roleid
   where r.rolname in ('anon', 'authenticated', 'service_role');
  if bad is not null then
    raise exception 'compatibility roles must not be members of other roles: %', bad;
  end if;
end $$;

-- ── 2. The auth schema shim ────────────────────────────────────────────────
-- 32 policies call auth.uid(). In Supabase it reads the verified JWT that the
-- API gateway put on the session; here the API does that itself, per
-- transaction, with `set_config('request.jwt.claims', ..., true)`.
--
-- IMPORTANT: the value this returns must be the portal's own profiles.id UUID,
-- NOT the raw Firebase UID. Firebase issues 28-character strings, profiles.id
-- is a uuid, and every policy and foreign key in the schema is built on the
-- uuid. Mapping Firebase UID -> profiles.id in the API (and minting it as a
-- custom claim) keeps all 32 policies and every FK working unchanged; changing
-- the column type instead would rewrite the entire schema.
create schema if not exists auth;

--
-- auth.uid() FAILS CLOSED. With a `sub` in this transaction's claims it returns
-- that uuid (a non-uuid sub, or malformed JSON, raises). With no sub -- claims
-- never set, '' (what a pooled connection carries after any earlier request),
-- or JSON without a sub -- it returns NULL ONLY to operator sessions: a
-- superuser, or the CREATEROLE admin that runs this bootstrap and the
-- migrations. The migrations read that NULL as "trusted maintenance session"
-- (can_confirm_payments(), profiles_guard_privilege_columns()). Every other
-- login -- the app login above all -- gets an error, so a request that forgot
-- its claims is never mistaken for a trusted caller. The rule keys on
-- session_user, which neither SET ROLE nor SECURITY DEFINER changes, so it also
-- holds inside the migrations' definer functions. No fixed search_path (that
-- would cost a GUC swap per call), so every name is schema-qualified.
create or replace function auth.uid()
returns uuid
language plpgsql
stable
as $$
declare
  sub text := nullif(
    nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    '');
begin
  if sub is not null then
    return sub::uuid;
  end if;
  if exists (select 1 from pg_catalog.pg_roles r
              where r.rolname = session_user
                and (r.rolsuper or r.rolcreaterole)) then
    return null;
  end if;
  raise exception 'auth.uid(): no authenticated identity in this transaction (request.jwt.claims has no sub)'
    using errcode = 'insufficient_privilege';
end $$;

-- Supabase's auth.role() equivalent, for parity if a policy ever needs it.
-- '' (a reused connection) means "no claims", not a JSON syntax error.
create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', ''),
    'anon'
  )
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- ── 3. auth.users is gone; profiles must stand alone ───────────────────────
-- profiles.id is `references auth.users(id) on delete cascade`, and
-- 20260601000000 hangs a trigger (on_auth_user_created -> handle_new_user) off
-- auth.users to provision a profile per signup. Firebase owns identity now, so
-- neither the table nor the trigger exists: the API creates the profile row
-- when it first sees a new Firebase user.
--
-- A stand-in table keeps the FK and the existing migrations applying unchanged,
-- and gives the app one place to record the Firebase UID -> profile mapping.
create table if not exists auth.users (
  id                  uuid primary key default gen_random_uuid(),
  firebase_uid        text unique not null,
  email               text,
  -- Carried only because 20260601000000 creates handle_new_user() against it.
  -- 02_post_migrate.sql drops that trigger; the column keeps the migration
  -- applying cleanly in between.
  raw_user_meta_data  jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now()
);

comment on table auth.users is
  'Identity mapping, not an identity store. Firebase (Google Cloud Identity '
  'Platform) authenticates; this table maps its UID to the portal profiles.id '
  'uuid that every RLS policy and foreign key is built on.';

-- Only the table owner reads this mapping -- directly, or through
-- auth.resolve_app_user() (section 5). No application role may enumerate
-- Firebase UIDs / emails; the revoke also corrects databases bootstrapped
-- before this rule existed.
revoke all on table auth.users from public, anon, authenticated, service_role;

-- ── 4. The application role ────────────────────────────────────────────────
-- Created here without a password; the password is set by bootstrap.sh from
-- $DB_PASS so no credential is ever written into the repository.
--
-- READ THIS BEFORE CHANGING IT. This role must never be a superuser and must
-- never hold BYPASSRLS. Postgres skips row-level security entirely for both,
-- so an app connecting as the Cloud SQL `postgres` user would silently lose
-- every access-control rule in this schema at once: client PII, the
-- billing-owner guard, message visibility, fulfillment scoping. Nothing would
-- error -- the queries would simply start returning everything.
--
-- Create it HERE, in SQL -- never through the Cloud SQL API (Terraform
-- google_sql_user, console, gcloud): those users are made members of
-- cloudsqlsuperuser with CREATEROLE, and in PostgreSQL 15 a CREATEROLE role can
-- grant itself any non-superuser role -- service_role, or the role that owns
-- every table. An existing login is accepted only if it already has exactly the
-- shape created below; anything else stops the bootstrap and is NOT altered.
do $$
declare
  u   text := current_setting('resolute.app_user');
  r   record;
  bad text;
begin
  if not exists (select 1 from pg_roles where rolname = u) then
    execute format('create role %I login noinherit nosuperuser nocreaterole nocreatedb nobypassrls noreplication', u);
  end if;

  select * into r from pg_roles where rolname = u;
  if r.rolsuper or r.rolbypassrls or r.rolcreaterole or r.rolcreatedb
     or r.rolreplication or r.rolinherit or not r.rolcanlogin then
    raise exception 'app login "%" already exists with unsafe attributes (superuser=%, bypassrls=%, createrole=%, createdb=%, replication=%, inherit=%, login=%) -- drop it and re-run; the bootstrap does not alter an existing account',
      u, r.rolsuper, r.rolbypassrls, r.rolcreaterole, r.rolcreatedb, r.rolreplication, r.rolinherit, r.rolcanlogin;
  end if;

  select string_agg(g.rolname || case when m.admin_option then ' (admin option)' else '' end, ', ' order by g.rolname)
    into bad
    from pg_auth_members m
    join pg_roles g on g.oid = m.roleid
   where m.member = r.oid
     and (g.rolname not in ('authenticated', 'anon') or m.admin_option);
  if bad is not null then
    raise exception 'app login "%" has unexpected role memberships: % -- drop it and re-run; the bootstrap does not alter an existing account', u, bad;
  end if;

  -- An owner skips RLS on its own tables, so the app login must own nothing.
  if exists (select 1 from pg_class where relowner = r.oid)
     or exists (select 1 from pg_namespace where nspowner = r.oid)
     or exists (select 1 from pg_proc where proowner = r.oid) then
    raise exception 'app login "%" owns objects in this database -- an owner bypasses RLS; drop it and re-run', u;
  end if;
end $$;

-- The app acts as `authenticated` and elevates per request; NOINHERIT above
-- means it must SET ROLE explicitly rather than picking the rights up silently.
do $$
declare u text := current_setting('resolute.app_user');
begin
  execute format('grant authenticated, anon to %I', u);
  execute format('grant connect on database %I to %I', current_database(), u);
  execute format('grant usage on schema public, auth to %I', u);
end $$;

-- Table privileges. RLS decides the rows; these decide the verbs.
grant usage on schema public to anon, authenticated, service_role;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant select on all tables in schema public to anon;
grant usage, select on all sequences in schema public to authenticated;

alter default privileges in schema public
  grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant usage, select on sequences to authenticated;

-- ── 5. Firebase UID -> portal identity (the one pre-claims lookup) ─────────
-- The API must learn profiles.id before it can set claims, so it calls this as
-- the app login, before SET ROLE. It replaces a SET ROLE service_role read that
-- the app login could never perform -- and that would have bypassed RLS on
-- every table if it could.
--   * SECURITY DEFINER, owned by the bootstrap admin: the owner of auth.users
--     and of public.profiles. Neither table FORCEs RLS, so the owner reads them
--     without BYPASSRLS (verify_bootstrap.sql asserts both facts).
--   * Plain SQL, no dynamic SQL, fixed search_path, every name qualified.
--   * Exact firebase_uid match, at most one row, only (id, role, status).
--     STRICT: a NULL uid returns nothing. It creates and grants nothing.
--   * EXECUTE is revoked from PUBLIC in the transaction that creates it and
--     granted only to the app login -- not to anon / authenticated /
--     service_role, so code running under user claims cannot enumerate accounts.
-- public.profiles does not exist until the migrations have run, so the body is
-- not validated here (check_function_bodies is off for this transaction only)
-- and role is returned as text; verify_bootstrap.sql calls it to validate it.
begin;
set local check_function_bodies = off;

create or replace function auth.resolve_app_user(p_firebase_uid text)
returns table (id uuid, role text, status text)
language sql
stable
strict
security definer
set search_path = pg_catalog, pg_temp
as $$
  select p.id, p.role::text, p.status
    from auth.users u
    join public.profiles p on p.id = u.id
   where u.firebase_uid = p_firebase_uid
   limit 1
$$;

revoke all on function auth.resolve_app_user(text) from public, anon, authenticated, service_role;
do $$
begin
  execute format('grant execute on function auth.resolve_app_user(text) to %I',
                 current_setting('resolute.app_user'));
end $$;
commit;

-- ── 6. Temporary Supabase Storage stub (dropped by 02_post_migrate.sql) ────
-- Two migrations write to Supabase Storage: 20260601000000_init inserts the
-- `documents` bucket into storage.buckets and puts two policies on
-- storage.objects; 20260722010000_documents_client_insert adds a third. Cloud
-- SQL has no `storage` schema, so under ON_ERROR_STOP the very first migration
-- aborts the bootstrap. These two tables give those statements exactly the
-- columns they reference, so every migration applies unchanged -- nothing is
-- edited, skipped or error-suppressed.
--
-- It is scaffolding, not document storage, and it enforces nothing: no grants
-- to any application role, and 02_post_migrate.sql drops the whole `storage`
-- schema at the end of the bootstrap (gcp/verify_bootstrap.sql asserts it is
-- gone). Document access control on GCP lives in the API (ADR 0002, B5).
create schema if not exists storage;

create table if not exists storage.buckets (
  id     text primary key,
  name   text not null,
  public boolean not null default false
);

create table if not exists storage.objects (
  bucket_id text,
  name      text
);
alter table storage.objects enable row level security;
