-- =====================================================================
-- Cloud SQL bootstrap: roles, the auth shim, and grants
-- =====================================================================
-- Run this ONCE against a NEW, empty Cloud SQL database before applying
-- supabase/migrations/*.sql (gcp/bootstrap.sh does all three steps).
--
-- NEVER against resolute_live: production already exists, and CLAUDE.md
-- forbids running supabase/migrations/* there. Changes to the live database go
-- through gcp/preflight.sh (read-only) and the guarded gcp/migrations/ files.
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
-- NOLOGIN: nothing connects as them; the app role SETs ROLE to them per
-- transaction (services/api/src/db.js).
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end $$;

-- service_role carries BYPASSRLS because withServiceRole() resolves a verified
-- Firebase UID to its profiles.id before any user claims exist (and the
-- admin-user route edits privilege columns the guard trigger only lets a
-- claim-less session change). PostgreSQL 15 lets ONLY a superuser create a
-- BYPASSRLS role, and Cloud SQL has no true superuser -- so on Cloud SQL this
-- CREATE fails for the built-in `postgres` user. That used to surface as a bare
-- "must be superuser" halfway through the bootstrap; it now stops with the
-- prerequisite spelled out. See gcp/PRODUCTION-PREREQUISITES.md.
do $$
declare r pg_roles%rowtype;
begin
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    begin
      create role service_role nologin bypassrls;
    exception when insufficient_privilege then
      raise exception 'bootstrap: % cannot create service_role WITH BYPASSRLS', current_user
        using detail = 'PostgreSQL 15 only lets a superuser create a BYPASSRLS role; Cloud SQL has no true superuser.',
              hint   = 'Create service_role (NOLOGIN BYPASSRLS) once with a role that can, then re-run. See gcp/PRODUCTION-PREREQUISITES.md.';
    end;
  end if;

  select * into r from pg_roles where rolname = 'service_role';
  if not r.rolbypassrls then
    raise exception 'bootstrap: service_role exists but lacks BYPASSRLS; identity resolution would silently find no profile';
  end if;
  if r.rolcanlogin or r.rolsuper then
    raise exception 'bootstrap: service_role must be NOLOGIN and not a superuser';
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

create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    current_setting('request.jwt.claims', true)::jsonb ->> 'sub',
    ''
  )::uuid
$$;

-- Supabase's auth.role() equivalent, for parity if a policy ever needs it.
create or replace function auth.role()
returns text
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', ''),
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

-- Only the identity-resolution path (service_role) reads the mapping. It holds
-- every Firebase UID and sign-in email and carries no RLS, so a signed-in
-- session (`authenticated`) must not be able to list it; no policy or
-- invoker function reads it (the profiles FK is checked as the table owner).
revoke all on auth.users from public, anon, authenticated;
grant select on auth.users to service_role;

-- ── 3b. A storage schema stand-in, so the migrations apply ─────────────────
-- 20260601000000 inserts the `documents` bucket into storage.buckets and puts
-- policies on storage.objects, and 20260722010000 adds another. Supabase
-- Storage provides both tables; Cloud SQL has no storage schema, so without
-- this the very first migration stops at its storage.buckets insert and
-- bootstrap.sh (set -e, ON_ERROR_STOP) aborts there -- reproduced on
-- PostgreSQL 15 with 2 of 51 migrations failing.
--
-- These tables exist ONLY so those statements parse and apply. Cloud Storage
-- never consults Postgres, so the policies on them enforce nothing;
-- 02_post_migrate.sql drops the whole schema afterwards rather than leave rules
-- that read as protection. Document access is enforced in the API, where a
-- signed URL is minted.
create schema if not exists storage;

create table if not exists storage.buckets (
  id      text primary key,
  name    text,
  public  boolean not null default false
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text references storage.buckets(id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz not null default now()
);
alter table storage.objects enable row level security;

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
do $$
declare
  u text := nullif(current_setting('resolute.app_user', true), '');
  r pg_roles%rowtype;
begin
  if u is null then
    raise exception 'bootstrap: resolute.app_user is not set'
      using hint = 'Run through gcp/bootstrap.sh, or pass PGOPTIONS="-c resolute.app_user=<role>".';
  end if;
  if not exists (select 1 from pg_roles where rolname = u) then
    execute format('create role %I login noinherit nosuperuser nobypassrls nocreatedb nocreaterole', u);
  end if;

  -- An existing role is checked, not trusted: re-running against a database
  -- where someone widened it must stop here rather than carry on looking fine.
  select * into r from pg_roles where rolname = u;
  if r.rolsuper or r.rolbypassrls then
    raise exception 'bootstrap: app role % is a superuser or holds BYPASSRLS; RLS would not apply to it', u;
  end if;
  if r.rolinherit then
    raise exception 'bootstrap: app role % must be NOINHERIT so it only gains rights through SET ROLE', u;
  end if;
end $$;

-- The app acts as `authenticated` per request and as `service_role` for the one
-- identity lookup; NOINHERIT above means it must SET ROLE explicitly rather
-- than picking either role's rights up silently. Both memberships are what
-- db.js actually does: without `service_role` here, SET LOCAL ROLE service_role
-- fails ("permission denied to set role") and every Firebase sign-in
-- (resolveAppUser) and the admin-user route fail with it -- reproduced against
-- the previous version of this file. `anon` is not granted: nothing in the API
-- acts as it.
do $$
declare u text := current_setting('resolute.app_user');
begin
  execute format('grant authenticated, service_role to %I', u);
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
