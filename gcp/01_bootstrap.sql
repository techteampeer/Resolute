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
-- NOLOGIN: nothing connects as them, the app role inherits from them.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
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
  -- Nullable on purpose, and it is an ordering constraint rather than a
  -- preference. The data migration loads these rows first, carrying the uuids
  -- every profile and policy already depends on; the Firebase accounts are
  -- created and bound afterwards by scripts/link-firebase-users.mjs. NOT NULL
  -- here would make that order impossible and force accounts to be minted
  -- before the data they belong to exists.
  --
  -- A row with a null firebase_uid is simply an account nobody can sign in to
  -- yet: profileForFirebaseUid() matches on firebase_uid, so it resolves to
  -- nothing and login is refused with "not linked to a portal account".
  firebase_uid        text unique,
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

-- The Express server is the ONLY thing that reaches this schema -- there is no
-- PostgREST in front of it any more -- so the app role manages the mapping
-- directly. It carries no RLS because nothing untrusted can query it.
grant select on auth.users to authenticated, service_role;

-- ── 3b. A storage schema stand-in, so the migrations apply ─────────────────
-- Two of the migrations (20260601000000 and 20260722010000) create policies on
-- storage.objects / storage.buckets. Supabase Storage provides those tables;
-- Cloud SQL has no such schema, so without this the schema build stops on the
-- first of them -- which is exactly what happened when it was tried.
--
-- These stubs exist only so those statements parse and apply. The policies on
-- them enforce nothing: Cloud Storage never consults Postgres. 02_post_migrate
-- drops the whole schema afterwards rather than leave rules that look like
-- protection they cannot provide -- document access is enforced in the API, at
-- the point a signed URL is minted (server/routes/documents.js).
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

insert into storage.buckets (id, name, public) values ('documents','documents',false)
  on conflict (id) do nothing;

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
begin
  if not exists (select 1 from pg_roles where rolname = current_setting('resolute.app_user', true)) then
    execute format('create role %I login noinherit', current_setting('resolute.app_user'));
  end if;
end $$;

-- The app acts as `authenticated` and elevates per request; NOINHERIT above
-- means it must SET ROLE explicitly rather than picking the rights up silently.
do $$
declare u text := current_setting('resolute.app_user');
begin
  execute format('grant authenticated, anon to %I', u);
  -- The Express server is the only thing that reaches the auth schema -- there
  -- is no PostgREST in front of it any more -- so the app role manages the
  -- identity mapping directly. Granted here rather than where the table is
  -- created, because the role does not exist until this block.
  execute format('grant select, insert, update, delete on auth.users to %I', u);
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
