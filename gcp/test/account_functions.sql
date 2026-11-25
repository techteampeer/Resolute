-- =====================================================================
-- GCP account-management SQL -- TEST FIXTURE, DISPOSABLE DATABASES ONLY
-- =====================================================================
-- The production GCP definitions of the account functions and everything
-- they depend on, extracted VERBATIM from the reference GCP SQL (branch
-- integration/gcp-admin-reference-20261125, commit 9d167690). Nothing below
-- the extract markers is edited; each extract's sha256 is recorded so a
-- reviewer can check it against the source with git show.
--
-- NOT a migration and not for resolute_live (refused below). gcp/test/run.sh
-- applies it, as the schema owner, to a disposable PostgreSQL 15 database that
-- gcp/bootstrap.sh built in the production shape, with
--   PGOPTIONS='-c resolute.app_user=<restricted test login>'
-- so 01 §4/§5 create that login (NOINHERIT; member of authenticated + anon
-- only -- never service_role, never BYPASSRLS) and grant it the resolver.
--
-- Extracts (file, lines, what):
--   01_bootstrap.sql       63-126  01 §2  auth.uid() fails closed; auth.role()
--                        sha256 2e01777a2f55f235b739e85ef8c4f3e07a311574395c4266ea0bb821434393d3
--   01_bootstrap.sql      127-157  01 §3  auth.users: no application role reads it
--                        sha256 5f9c75e68b2839d0018b2df5c79d73727e5289c79ade1eda1e288ec7179550e6
--   01_bootstrap.sql      158-230  01 §4  the restricted app login (NOINHERIT; authenticated + anon only)
--                        sha256 343692beaacc347915b68686ee80d0dce25fdb360210e6bb39ba78a7da7349cd
--   01_bootstrap.sql      231-273  01 §5  auth.resolve_app_user (executable by the app login only)
--                        sha256 17efa2f97945140c0859a37ef5531209612948ef7b008740498045f2705c2fb0
--   02_post_migrate.sql    57-127  02 §4  privilege guard + owner-only per-transaction marker
--                        sha256 aed77c6ccdfed36e3725f690d174a7b244c681c99c0bbf92a2ef9861e22f178e
--   02_post_migrate.sql   167-483  02 §7  account_required_authority, provision_app_user, activate_app_user
--                        sha256 6d7ba5fc7dbc187a0295d13bfb1c20fc88ff85c3d6134fa8c5b5b4510280b451
--   02_post_migrate.sql   484-577  02 §8  profiles created/removed only by provisioning
--                        sha256 d9cf344fb373ecd6747cca130ff833e521d26e9a03ee31460f5bedeb8f1f1d12
--   02_post_migrate.sql   578-616  02 §9  role helpers answer only for active accounts
--                        sha256 9e4d4f7ee3882ef0182782c935e2b60cae354c05ee075c7d46b38b84c702f2ad
--   02_post_migrate.sql  2193-2468 02 §13 update_app_user, set_app_user_status, admin_account_uids
--                        sha256 3f811a06adc588ace5af62e6c54ae485bb4f4140bd7b89690a8f96a9dbde6b94
--
-- Left out on purpose: 01 §1 (compatibility roles -- the harness cluster's
-- service_role predates this database; the test login is never a member of
-- it), 01 §6 (storage stub), and 02 §1-3, §5-6, §10-12, §14 (storage,
-- search_path/temp hardening, documents, messages, payments, contacts: no
-- account function calls them). The reference's verify_bootstrap.sql is not
-- part of the reference set and is not used.
-- =====================================================================
\set ON_ERROR_STOP on
\if :{?disposable_test_db}
\else
  \echo 'account_functions.sql is a test fixture: apply it only to a disposable database (-v disposable_test_db=1)'
  do $$ begin raise exception 'refusing to run without -v disposable_test_db=1'; end $$;
\endif
do $$ begin
  if lower(current_database()) in ('resolute_live', 'resolute_prod') or current_database() !~ '^resolute_gcp_test' then
    raise exception 'account_functions.sql: refusing database %', current_database();
  end if;
end $$;

-- ┌── EXTRACT 01 §2  auth.uid() fails closed; auth.role()
-- │ integration-reference/gcp-live/gcp/01_bootstrap.sql lines 63-126 @ 9d167690, verbatim; sha256 2e01777a2f55f235b739e85ef8c4f3e07a311574395c4266ea0bb821434393d3
-- └──────────────────────────────────────────────────────────────────────────
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


-- ┌── EXTRACT 01 §3  auth.users: no application role reads it
-- │ integration-reference/gcp-live/gcp/01_bootstrap.sql lines 127-157 @ 9d167690, verbatim; sha256 5f9c75e68b2839d0018b2df5c79d73727e5289c79ade1eda1e288ec7179550e6
-- └──────────────────────────────────────────────────────────────────────────
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


-- ┌── EXTRACT 01 §4  the restricted app login (NOINHERIT; authenticated + anon only)
-- │ integration-reference/gcp-live/gcp/01_bootstrap.sql lines 158-230 @ 9d167690, verbatim; sha256 343692beaacc347915b68686ee80d0dce25fdb360210e6bb39ba78a7da7349cd
-- └──────────────────────────────────────────────────────────────────────────
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


-- ┌── EXTRACT 01 §5  auth.resolve_app_user (executable by the app login only)
-- │ integration-reference/gcp-live/gcp/01_bootstrap.sql lines 231-273 @ 9d167690, verbatim; sha256 17efa2f97945140c0859a37ef5531209612948ef7b008740498045f2705c2fb0
-- └──────────────────────────────────────────────────────────────────────────
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


-- ┌── EXTRACT 02 §4  privilege guard + owner-only per-transaction marker
-- │ integration-reference/gcp-live/gcp/02_post_migrate.sql lines 57-127 @ 9d167690, verbatim; sha256 aed77c6ccdfed36e3725f690d174a7b244c681c99c0bbf92a2ef9861e22f178e
-- └──────────────────────────────────────────────────────────────────────────
-- ── 4. Payment and privilege guards: no claim-controlled escape hatch ───────
-- On Supabase, can_confirm_payments() (20260908010000) and
-- profiles_guard_privilege_columns() (latest body: 20261013000000) stand down
-- when request.jwt.claim.role = 'service_role'. Here any session can set that
-- custom setting, so it proves nothing about the caller. These GCP versions are
-- the same rules without that clause:
--   * payments are confirmed only by a profile with can_confirm_payments;
--   * protected profile columns change only in operator sessions.
-- "Operator session" is a NULL auth.uid(), which on GCP only a superuser or the
-- CREATEROLE bootstrap admin can get (gcp/01_bootstrap.sql) -- the app login
-- raises instead -- so maintenance keeps working and the app gains no bypass.
-- CREATE OR REPLACE keeps each function's owner, grants and the triggers that
-- call it. search_path is pg_catalog then pg_temp, with every non-catalog name
-- schema-qualified, so no writable schema is ever searched.
-- The migrations are untouched (Supabase keeps its own definitions); a migration
-- that re-creates either function is overridden again by the next bootstrap,
-- and verify_bootstrap.sql fails if any function still reads the claim role.
--
-- The one non-operator exception: a row in auth.profile_privileged_changes for
-- (this transaction, this profile). Only the table owner can write it -- no
-- application role has any privilege on it -- and only the owner's SECURITY
-- DEFINER account functions do (section 7: activation), immediately around
-- their own UPDATE and in the same transaction. Unlike a session setting it
-- cannot be forged by a caller, and it expires with the transaction.
begin;

create table if not exists auth.profile_privileged_changes (
  txid       bigint not null,
  profile_id uuid   not null,
  primary key (txid, profile_id)
);
revoke all on table auth.profile_privileged_changes from public, anon, authenticated, service_role;

create or replace function public.can_confirm_payments()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(
    auth.uid() is null
    or (select p.can_confirm_payments from public.profiles p where p.id = auth.uid() and p.status = 'active'),
    false)
$$;

create or replace function public.profiles_guard_privilege_columns()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if auth.uid() is not null
     and not exists (select 1 from auth.profile_privileged_changes t
                      where t.txid = txid_current() and t.profile_id = old.id) then
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

commit;


-- ┌── EXTRACT 02 §7  account_required_authority, provision_app_user, activate_app_user
-- │ integration-reference/gcp-live/gcp/02_post_migrate.sql lines 167-483 @ 9d167690, verbatim; sha256 6d7ba5fc7dbc187a0295d13bfb1c20fc88ff85c3d6134fa8c5b5b4510280b451
-- └──────────────────────────────────────────────────────────────────────────
-- ── 7. Account provisioning and activation: narrow, admin-authorized ──────
-- The API cannot write auth.users (no application role can) and protected
-- profile columns change only in operator sessions (section 4), so these two
-- SECURITY DEFINER functions are the only application path to a new portal
-- identity and to activating it:
--   * auth.provision_app_user(...): given a Firebase account the trusted backend
--     has ALREADY created (disabled), insert its UID mapping and a 'pending'
--     profile in one statement; return the new internal profiles.id. The gate
--     admits only 'active' profiles, so the account cannot sign in yet.
--   * auth.activate_app_user(id): 'pending' -> 'active' (idempotent for an
--     active account); returns the Firebase UID and email so the backend can
--     then enable the Firebase account. Nothing else changes.
--
-- Authorization comes from the caller's own profile row, read and share-locked
-- in the same statement -- never from a claim role, a submitted flag or a NULL
-- operator identity -- and is re-checked at each step:
--   * the caller must be an active admin (auth.uid() must name one);
--   * client and production `user` accounts: any active admin;
--   * admin accounts, super_admin, and grants of elevated capabilities (or of
--     capabilities outside the account's role bundle): a super admin;
--   * can_confirm_payments or a payments.confirm grant: the billing owner (a
--     super admin who holds can_confirm_payments) -- the money gate is never
--     handed out by someone who does not hold it.
-- auth.account_required_authority() is the single statement of those rules,
-- computed from the account's own attributes (the request when provisioning,
-- the stored row when activating). It also validates permissions: the
-- capability lists mirror packages/domain/src/permissions.ts and
-- api/admin/users.js, and an unknown capability is refused, so a new one cannot
-- be granted until it is added here.
-- The request is validated and authorized before any existing account or client
-- is looked up, so a refused caller learns nothing about them, and errors never
-- echo the submitted values. An existing UID or email is refused
-- (unique_violation) and never modified. All three functions are owned by the
-- table owner (verify_bootstrap.sql checks); the two entry points are
-- executable by `authenticated` only -- i.e. inside a withUserClaims
-- transaction; the NOINHERIT app login cannot call them as itself. Re-running
-- replaces the bodies in place and re-applies the same grants.
begin;

create or replace function auth.account_required_authority(
  p_context              text,
  p_role                 text,
  p_super_admin          boolean,
  p_can_confirm_payments boolean,
  p_permissions          jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
declare
  c_catalog  constant text[] := array[
    'orders.read', 'orders.work', 'orders.assign', 'orders.hold', 'orders.clarify',
    'clients.view_pii', 'payouts.view', 'payouts.manage', 'payments.confirm',
    'support.reply_client', 'support.note', 'users.manage', 'users.grant_super', 'client.portal'];
  c_elevated constant text[] := array[
    'payments.confirm', 'users.grant_super', 'users.manage', 'clients.view_pii', 'payouts.view', 'payouts.manage'];
  c_stages   constant text[] := array['screener', 'examiner', 'searchqc', 'typer', 'qc', 'delivery'];
  v_bundle   text[];
  v_entry    jsonb;
  v_cap      text;
  v_elevated boolean;
  v_billing  boolean;
begin
  if p_role is null or p_role not in ('admin', 'user', 'client') then
    raise exception '%: unsupported role', p_context using errcode = '22023';
  end if;
  if p_super_admin is null or p_can_confirm_payments is null then
    raise exception '%: super_admin and can_confirm_payments must be true or false', p_context using errcode = '22023';
  end if;
  if p_permissions is null or jsonb_typeof(p_permissions) <> 'array' or jsonb_array_length(p_permissions) > 32 then
    raise exception '%: permissions must be an array of at most 32 entries', p_context using errcode = '22023';
  end if;
  v_elevated := p_role = 'admin' or p_super_admin;
  v_billing := p_can_confirm_payments;
  v_bundle := case p_role
    when 'admin' then array['orders.read', 'orders.work', 'orders.assign', 'orders.hold', 'orders.clarify',
                            'support.reply_client', 'support.note', 'users.manage']
    when 'user'  then array['orders.read', 'orders.work', 'support.note']
    else              array['client.portal'] end;

  -- Permissions: [{capability, effect: grant|revoke, scope?: {stages: [...]}}].
  for v_entry in select e from jsonb_array_elements(p_permissions) e loop
    if jsonb_typeof(v_entry) <> 'object' then
      raise exception '%: invalid permission entry', p_context using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_object_keys(v_entry) k where k not in ('capability', 'effect', 'scope'))
       or jsonb_typeof(v_entry -> 'capability') is distinct from 'string'
       or jsonb_typeof(v_entry -> 'effect') is distinct from 'string'
       or (v_entry ->> 'effect') not in ('grant', 'revoke')
       or not ((v_entry ->> 'capability') = any (c_catalog)) then
      raise exception '%: invalid permission entry', p_context using errcode = '22023';
    end if;
    v_cap := v_entry ->> 'capability';
    if v_entry ? 'scope' then
      -- Only stage work is scopeable: {stages: [distinct known stages]}.
      if v_cap <> 'orders.work' or jsonb_typeof(v_entry -> 'scope') <> 'object' then
        raise exception '%: invalid permission scope', p_context using errcode = '22023';
      end if;
      if exists (select 1 from jsonb_object_keys(v_entry -> 'scope') k where k <> 'stages')
         or jsonb_typeof(v_entry -> 'scope' -> 'stages') is distinct from 'array' then
        raise exception '%: invalid permission scope', p_context using errcode = '22023';
      end if;
      if jsonb_array_length(v_entry -> 'scope' -> 'stages') = 0
         or exists (select 1 from jsonb_array_elements(v_entry -> 'scope' -> 'stages') s
                     where jsonb_typeof(s) <> 'string' or not ((s #>> '{}') = any (c_stages)))
         or (select count(*) <> count(distinct s) from jsonb_array_elements(v_entry -> 'scope' -> 'stages') s) then
        raise exception '%: invalid permission scope', p_context using errcode = '22023';
      end if;
    end if;
    if v_entry ->> 'effect' = 'grant' then
      if v_cap = any (c_elevated) or not (v_cap = any (v_bundle)) then
        v_elevated := true;
      end if;
      if v_cap = 'payments.confirm' then
        v_billing := true;
      end if;
    end if;
  end loop;
  return case when v_billing then 'billing_owner' when v_elevated then 'super_admin' else 'admin' end;
end $fn$;

create or replace function auth.provision_app_user(
  p_firebase_uid         text,
  p_email                text,
  p_role                 text,
  p_name                 text    default '',
  p_client_code          text    default null,
  p_super_admin          boolean default false,
  p_can_confirm_payments boolean default false,
  p_permissions          jsonb   default '[]'::jsonb)
returns uuid
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_caller uuid := auth.uid();   -- raises for a login without claims
  v_admin  record;
  v_email  text;
  v_name   text;
  v_need   text;
  v_id     uuid;
begin
  -- 1. The caller: an active admin, from the database. A NULL identity (an
  --    operator session without claims) is refused, not treated as trusted.
  if v_caller is null then
    raise exception 'provision_app_user: an authenticated administrator is required' using errcode = '42501';
  end if;
  select p.role::text as role, p.status, p.super_admin, p.can_confirm_payments
    into v_admin
    from public.profiles p
   where p.id = v_caller
     for share;
  if not found or v_admin.role is distinct from 'admin' or v_admin.status is distinct from 'active' then
    raise exception 'provision_app_user: the caller is not an active administrator' using errcode = '42501';
  end if;
  -- The duplicate checks below must see concurrent commits.
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'provision_app_user: requires READ COMMITTED' using errcode = '0A000';
  end if;

  -- 2. The request's shape.
  if p_firebase_uid is null or p_firebase_uid !~ '^[A-Za-z0-9_-]{1,128}$' then
    raise exception 'provision_app_user: invalid firebase uid' using errcode = '22023';
  end if;
  v_email := lower(btrim(p_email));
  if v_email is null or length(v_email) > 254
     or v_email !~ '^[^[:space:][:cntrl:]@]+@[^[:space:][:cntrl:]@]+\.[^[:space:][:cntrl:]@]+$' then
    raise exception 'provision_app_user: invalid email' using errcode = '22023';
  end if;
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) > 200 or v_name ~ '[[:cntrl:]]' then
    raise exception 'provision_app_user: invalid name' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('admin', 'user', 'client') then
    raise exception 'provision_app_user: unsupported role' using errcode = '22023';
  end if;
  if p_super_admin is null or p_can_confirm_payments is null then
    raise exception 'provision_app_user: super_admin and can_confirm_payments must be true or false' using errcode = '22023';
  end if;
  if p_role <> 'admin' and (p_super_admin or p_can_confirm_payments) then
    raise exception 'provision_app_user: super admin and billing apply only to admin accounts' using errcode = '22023';
  end if;
  if p_role = 'client' and p_client_code is null then
    raise exception 'provision_app_user: a client account needs a client code' using errcode = '22023';
  elsif p_role <> 'client' and p_client_code is not null then
    raise exception 'provision_app_user: only client accounts carry a client code' using errcode = '22023';
  end if;
  v_need := auth.account_required_authority('provision_app_user', p_role, p_super_admin,
                                            p_can_confirm_payments, p_permissions);

  -- 3. Privilege: who may provision what (see the header).
  if p_role = 'admin' and not v_admin.super_admin then
    raise exception 'provision_app_user: only a super admin may provision an admin account' using errcode = '42501';
  end if;
  if v_need <> 'admin' and not v_admin.super_admin then
    raise exception 'provision_app_user: only a super admin may grant super-admin or elevated capabilities' using errcode = '42501';
  end if;
  if v_need = 'billing_owner' and not v_admin.can_confirm_payments then
    raise exception 'provision_app_user: only the billing owner may grant payment confirmation' using errcode = '42501';
  end if;

  -- 4. Existing state, serialized per UID and per email so that two concurrent
  --    submissions cannot both pass the checks.
  perform pg_advisory_xact_lock(hashtextextended('auth.provision_app_user.uid:' || p_firebase_uid, 0));
  perform pg_advisory_xact_lock(hashtextextended('auth.provision_app_user.email:' || v_email, 0));
  if p_role = 'client' then
    perform 1 from public.clients c where c.code = p_client_code for key share;
    if not found then
      raise exception 'provision_app_user: unknown client code' using errcode = '22023';
    end if;
  end if;
  if exists (select 1 from auth.users u where u.firebase_uid = p_firebase_uid) then
    raise exception 'provision_app_user: the firebase uid is already mapped' using errcode = '23505';
  end if;
  if exists (select 1 from auth.users u where lower(u.email) = v_email)
     or exists (select 1 from public.profiles p where lower(p.email) = v_email) then
    raise exception 'provision_app_user: the email already belongs to an account' using errcode = '23505';
  end if;

  -- 5. Both rows or neither: one statement. The id is generated here, never
  --    derived from the Firebase UID.
  v_id := pg_catalog.gen_random_uuid();
  insert into auth.users (id, firebase_uid, email) values (v_id, p_firebase_uid, v_email);
  insert into public.profiles (id, name, email, role, client_code, super_admin, can_confirm_payments, permissions, status)
  values (v_id, v_name, v_email, p_role::public.user_role, p_client_code, p_super_admin, p_can_confirm_payments,
          p_permissions, 'pending');
  return v_id;
end $fn$;

create or replace function auth.activate_app_user(p_profile_id uuid)
returns table (firebase_uid text, email text, activated boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_caller uuid := auth.uid();   -- raises for a login without claims
  v_admin  record;
  v_target record;
  v_need   text;
begin
  if v_caller is null then
    raise exception 'activate_app_user: an authenticated administrator is required' using errcode = '42501';
  end if;
  select p.role::text as role, p.status, p.super_admin, p.can_confirm_payments
    into v_admin
    from public.profiles p
   where p.id = v_caller
     for share;
  if not found or v_admin.role is distinct from 'admin' or v_admin.status is distinct from 'active' then
    raise exception 'activate_app_user: the caller is not an active administrator' using errcode = '42501';
  end if;
  if p_profile_id is null then
    raise exception 'activate_app_user: invalid account id' using errcode = '22023';
  end if;

  select p.id, p.role::text as role, p.status, p.super_admin, p.can_confirm_payments, p.permissions,
         p.email as profile_email, u.firebase_uid as uid
    into v_target
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_profile_id
     for update of p;
  if not found then
    raise exception 'activate_app_user: no such account' using errcode = 'P0002';
  end if;
  -- The authority provisioning this account needed, from the stored row --
  -- re-checked against the caller's current profile.
  v_need := auth.account_required_authority('activate_app_user', v_target.role, v_target.super_admin,
                                            v_target.can_confirm_payments, v_target.permissions);
  if v_need <> 'admin' and not v_admin.super_admin then
    raise exception 'activate_app_user: only a super admin may activate this account' using errcode = '42501';
  end if;
  if v_need = 'billing_owner' and not v_admin.can_confirm_payments then
    raise exception 'activate_app_user: only the billing owner may activate a billing account' using errcode = '42501';
  end if;

  if v_target.status = 'active' then
    return query select v_target.uid, v_target.profile_email, false;
    return;
  end if;
  if v_target.status is distinct from 'pending' then
    raise exception 'activate_app_user: the account is not pending' using errcode = '55000';
  end if;
  -- Section 4's guard admits this one status change: an owner-only token for
  -- this transaction and profile, removed again straight after.
  insert into auth.profile_privileged_changes (txid, profile_id) values (txid_current(), p_profile_id)
    on conflict do nothing;
  update public.profiles set status = 'active' where id = p_profile_id;
  delete from auth.profile_privileged_changes where txid = txid_current() and profile_id = p_profile_id;
  return query select v_target.uid, v_target.profile_email, true;
end $fn$;

comment on function auth.provision_app_user(text, text, text, text, text, boolean, boolean, jsonb) is
  'Maps an already-created Firebase UID to a new pending portal profile, authorized by the caller''s own '
  'active admin profile (gcp/02_post_migrate.sql section 7). Returns the new profiles.id.';
comment on function auth.activate_app_user(uuid) is
  'pending -> active for one profile, authorized by the caller''s own active admin profile against the '
  'account''s stored privileges (gcp/02_post_migrate.sql section 7). Returns its Firebase UID and email.';

revoke all on function auth.account_required_authority(text, text, boolean, boolean, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function auth.provision_app_user(text, text, text, text, text, boolean, boolean, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function auth.activate_app_user(uuid)
  from public, anon, authenticated, service_role;
grant execute on function auth.provision_app_user(text, text, text, text, text, boolean, boolean, jsonb)
  to authenticated;
grant execute on function auth.activate_app_user(uuid)
  to authenticated;

commit;


-- ┌── EXTRACT 02 §8  profiles created/removed only by provisioning
-- │ integration-reference/gcp-live/gcp/02_post_migrate.sql lines 484-577 @ 9d167690, verbatim; sha256 d9cf344fb373ecd6747cca130ff833e521d26e9a03ee31460f5bedeb8f1f1d12
-- └──────────────────────────────────────────────────────────────────────────
-- ── 8. Profiles are created and removed only by provisioning ──────────────
-- The migrations grant ALL on every public table to anon, authenticated and
-- service_role (20260722000000 and its default privileges), let any admin
-- INSERT and DELETE profiles through profiles_admin_write (FOR ALL), and guard
-- the privilege columns on UPDATE only. Together that let a non-super,
-- non-billing admin delete a profile -- another's, or in one statement its own
-- -- and re-insert it as super admin with billing, or skip 'pending'. Separately,
-- TRUNCATE ignores RLS: any application role could empty orders (CASCADE to
-- fulfillments, payouts and messages); and TRIGGER let one attach functions to
-- tables. Closed in three independent layers, so no single re-grant reopens it:
--   1. privileges: no TRUNCATE / REFERENCES / TRIGGER for application roles on
--      any public table, now or for tables created later by the migration
--      owner; on profiles no INSERT / DELETE at all and UPDATE of `name` only
--      (the one column the app edits -- identity and privilege columns are
--      not updatable even where RLS would allow the row);
--   2. policy: profiles_admin_write is dropped. Reads stay with profiles_read,
--      and name edits (self, or an admin for anyone) with profiles_update_self;
--      no policy admits INSERT or DELETE;
--   3. triggers: INSERT, DELETE and TRUNCATE on profiles are refused unless run
--      by the table owner (operators, and the owner's provisioning function),
--      and id / email / created_at never change outside operator sessions --
--      alongside section 4's guard on the privilege columns.
-- Idempotent: revokes and grants re-apply, the policy drop is IF EXISTS, the
-- functions and triggers are CREATE OR REPLACE.
begin;

do $$
declare t regclass;
begin
  for t in select c.oid::regclass
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke truncate, references, trigger on table %s from public, anon, authenticated, service_role', t);
  end loop;
end $$;
alter default privileges in schema public
  revoke truncate, references, trigger on tables from public, anon, authenticated, service_role;

revoke insert, update, delete, truncate, references, trigger on table public.profiles
  from public, anon, authenticated, service_role;
grant update (name) on public.profiles to authenticated;

drop policy if exists profiles_admin_write on public.profiles;

create or replace function public.profiles_guard_lifecycle()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
begin
  -- current_user is the role running the statement (this function is NOT a
  -- definer): the table owner inside auth.provision_app_user and in operator
  -- sessions, `authenticated` / `anon` for the API.
  if not exists (select 1
                   from pg_class c
                   join pg_roles r on r.rolname = current_user
                  where c.oid = tg_relid and (c.relowner = r.oid or r.rolsuper)) then
    raise exception 'profiles are created and removed only through account provisioning' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end $fn$;

create or replace function public.profiles_guard_identity_columns()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if auth.uid() is not null
     and (new.id is distinct from old.id
          or new.email is distinct from old.email
          or new.created_at is distinct from old.created_at) then
    raise exception 'a profile''s id, email and created_at are fixed at provisioning' using errcode = '42501';
  end if;
  return new;
end $fn$;

revoke all on function public.profiles_guard_lifecycle() from public, anon, authenticated, service_role;
revoke all on function public.profiles_guard_identity_columns() from public, anon, authenticated, service_role;

create or replace trigger profiles_guard_lifecycle
  before insert or delete on public.profiles
  for each row execute function public.profiles_guard_lifecycle();
create or replace trigger profiles_guard_truncate
  before truncate on public.profiles
  for each statement execute function public.profiles_guard_lifecycle();
create or replace trigger profiles_guard_identity
  before update on public.profiles
  for each row execute function public.profiles_guard_identity_columns();

commit;


-- ┌── EXTRACT 02 §9  role helpers answer only for active accounts
-- │ integration-reference/gcp-live/gcp/02_post_migrate.sql lines 578-616 @ 9d167690, verbatim; sha256 9e4d4f7ee3882ef0182782c935e2b60cae354c05ee075c7d46b38b84c702f2ad
-- └──────────────────────────────────────────────────────────────────────────
-- ── 9. Role helpers answer only for active accounts ────────────────────────
-- The migrations' helpers read the caller's role from profiles without looking
-- at status, so claims naming an inactive or pending account would still count
-- as admin / staff / production / a client of its code. The API only sets
-- claims for an active profile, so this is defense in depth: whatever sets
-- claims in future, a profile that is not 'active' holds no role. Same
-- signatures, owner and grants (CREATE OR REPLACE); for active accounts the
-- answers are unchanged, and an operator session (NULL auth.uid()) still gets
-- NULL / false exactly as before. can_confirm_payments() (section 4) applies
-- the same rule.
begin;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select p.role = 'admin' from public.profiles p where p.id = auth.uid() and p.status = 'active'), false)
$$;
create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select p.role <> 'client' from public.profiles p where p.id = auth.uid() and p.status = 'active'), false)
$$;
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select p.super_admin from public.profiles p where p.id = auth.uid() and p.status = 'active'), false)
$$;
create or replace function public.can_work_production()
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select coalesce((select p.role = 'user' from public.profiles p where p.id = auth.uid() and p.status = 'active'), false)
$$;
create or replace function public.my_role()
returns public.user_role language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;
create or replace function public.my_client_code()
returns text language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select p.client_code from public.profiles p where p.id = auth.uid() and p.status = 'active'
$$;

commit;


-- ┌── EXTRACT 02 §13 update_app_user, set_app_user_status, admin_account_uids
-- │ integration-reference/gcp-live/gcp/02_post_migrate.sql lines 2193-2468 @ 9d167690, verbatim; sha256 3f811a06adc588ace5af62e6c54ae485bb4f4140bd7b89690a8f96a9dbde6b94
-- └──────────────────────────────────────────────────────────────────────────
-- ── 13. Account administration: edit, deactivate, reactivate ──────────────
-- Section 7 creates and activates accounts; these functions are the only other
-- application path to an account's protected columns (section 4's guard admits
-- them through the same owner-only, per-transaction marker):
--   * auth.update_app_user(id, version, name, role, client code, super admin,
--     billing, permissions): edit an account. The caller must be an active
--     admin holding the authority the account needs BOTH as stored and as
--     edited (auth.account_required_authority, section 7): a plain admin edits
--     client and production accounts within their role bundles; admin accounts,
--     super admin and elevated capabilities need a super admin; anything that
--     holds or grants payment confirmation needs the billing owner. An admin may
--     rename themselves but never change their own role, client code, access or
--     permissions. Id, email, created_at and the Firebase mapping never change.
--   * auth.set_app_user_status(id, active, version): 'active' -> 'inactive' or
--     back, with the same authority as activation, never on one's own account,
--     never for a 'pending' account (that is activation). Returns the Firebase
--     UID and email so the backend can then disable or enable sign-in; the
--     gate admits only 'active' profiles and every role helper (section 9)
--     answers false for any other status, so the database alone decides
--     portal access -- whatever state the Firebase account is in.
--   * auth.admin_account_uids(): the Firebase UID of every account, for an
--     active admin's account list to report each sign-in state. The UIDs stay
--     in the backend.
-- profiles.updated_at is the optimistic-lock version: a change made on a
-- version that has moved on is refused (40001), so two administrators cannot
-- silently overwrite each other. A repeated status change already in effect is
-- a no-op, so an interrupted deactivation or reactivation can be finished.
begin;

alter table public.profiles add column if not exists updated_at timestamptz not null default now();
drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- 'admin' < 'super_admin' < 'billing_owner'
create or replace function auth.account_authority_rank(p_need text)
returns integer
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case p_need when 'billing_owner' then 2 when 'super_admin' then 1 else 0 end
$fn$;

-- Refuses unless an admin with these privileges holds authority p_need.
create or replace function auth.account_require(p_context text, p_need text, p_super boolean, p_billing boolean)
returns void
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if p_need <> 'admin' and not coalesce(p_super, false) then
    raise exception '%: only a super admin may change an admin account, super admin or elevated capabilities', p_context
      using errcode = '42501';
  end if;
  if p_need = 'billing_owner' and not coalesce(p_billing, false) then
    raise exception '%: only the billing owner may change a billing account or payment confirmation', p_context
      using errcode = '42501';
  end if;
end $fn$;

create or replace function auth.update_app_user(
  p_profile_id           uuid,
  p_expected             timestamptz,
  p_name                 text,
  p_role                 text,
  p_client_code          text,
  p_super_admin          boolean,
  p_can_confirm_payments boolean,
  p_permissions          jsonb)
returns timestamptz
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_caller uuid := auth.uid();   -- raises for a login without claims
  v_admin  record;
  v_target record;
  v_name   text;
  v_need   text;
  v_old    text;
  v_at     timestamptz;
begin
  if v_caller is null then
    raise exception 'update_app_user: an authenticated administrator is required' using errcode = '42501';
  end if;
  select p.role::text as role, p.status, p.super_admin, p.can_confirm_payments
    into v_admin
    from public.profiles p
   where p.id = v_caller
     for share;
  if not found or v_admin.role is distinct from 'admin' or v_admin.status is distinct from 'active' then
    raise exception 'update_app_user: the caller is not an active administrator' using errcode = '42501';
  end if;
  if p_profile_id is null then
    raise exception 'update_app_user: invalid account id' using errcode = '22023';
  end if;

  -- The request's shape (section 7's rules).
  v_name := btrim(coalesce(p_name, ''));
  if length(v_name) > 200 or v_name ~ '[[:cntrl:]]' then
    raise exception 'update_app_user: invalid name' using errcode = '22023';
  end if;
  if p_role is null or p_role not in ('admin', 'user', 'client') then
    raise exception 'update_app_user: unsupported role' using errcode = '22023';
  end if;
  if p_super_admin is null or p_can_confirm_payments is null then
    raise exception 'update_app_user: super_admin and can_confirm_payments must be true or false' using errcode = '22023';
  end if;
  if p_role <> 'admin' and (p_super_admin or p_can_confirm_payments) then
    raise exception 'update_app_user: super admin and billing apply only to admin accounts' using errcode = '22023';
  end if;
  if p_role = 'client' and p_client_code is null then
    raise exception 'update_app_user: a client account needs a client code' using errcode = '22023';
  elsif p_role <> 'client' and p_client_code is not null then
    raise exception 'update_app_user: only client accounts carry a client code' using errcode = '22023';
  end if;
  v_need := auth.account_required_authority('update_app_user', p_role, p_super_admin, p_can_confirm_payments, p_permissions);

  -- The account, locked; a profile without its sign-in mapping is not editable here.
  select p.id, p.role::text as role, p.status, p.name, p.client_code, p.super_admin, p.can_confirm_payments,
         p.permissions, p.updated_at
    into v_target
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_profile_id
     for update of p;
  if not found then
    raise exception 'update_app_user: no such account' using errcode = 'P0002';
  end if;

  -- Authority before anything else about the account is answered.
  if v_target.id = v_caller then
    if (p_role, p_client_code, p_super_admin, p_can_confirm_payments, p_permissions)
       is distinct from (v_target.role, v_target.client_code, v_target.super_admin, v_target.can_confirm_payments,
                         coalesce(v_target.permissions, '[]'::jsonb)) then
      raise exception 'update_app_user: you cannot change your own role, client code, access or permissions'
        using errcode = '42501';
    end if;
  else
    v_old := auth.account_required_authority('update_app_user', v_target.role, v_target.super_admin,
                                             v_target.can_confirm_payments, coalesce(v_target.permissions, '[]'::jsonb));
    perform auth.account_require('update_app_user',
      case when auth.account_authority_rank(v_old) >= auth.account_authority_rank(v_need) then v_old else v_need end,
      v_admin.super_admin, v_admin.can_confirm_payments);
  end if;
  if p_expected is null or v_target.updated_at <> p_expected then
    raise exception 'update_app_user: the account changed since it was read' using errcode = '40001';
  end if;
  if p_role = 'client' then
    perform 1 from public.clients c where c.code = p_client_code for key share;
    if not found then
      raise exception 'update_app_user: unknown client code' using errcode = '22023';
    end if;
  end if;

  if (v_name, p_role, p_client_code, p_super_admin, p_can_confirm_payments, p_permissions)
     is not distinct from (v_target.name, v_target.role, v_target.client_code, v_target.super_admin,
                           v_target.can_confirm_payments, coalesce(v_target.permissions, '[]'::jsonb)) then
    return v_target.updated_at;                              -- nothing to change
  end if;
  insert into auth.profile_privileged_changes (txid, profile_id) values (txid_current(), p_profile_id)
    on conflict do nothing;
  update public.profiles
     set name = v_name, role = p_role::public.user_role, client_code = p_client_code, super_admin = p_super_admin,
         can_confirm_payments = p_can_confirm_payments, permissions = p_permissions
   where id = p_profile_id
  returning updated_at into v_at;
  delete from auth.profile_privileged_changes where txid = txid_current() and profile_id = p_profile_id;
  return v_at;
end $fn$;

create or replace function auth.set_app_user_status(p_profile_id uuid, p_active boolean, p_expected timestamptz)
returns table (firebase_uid text, email text, status text, updated_at timestamptz, changed boolean)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $fn$
declare
  v_caller uuid := auth.uid();   -- raises for a login without claims
  v_admin  record;
  v_target record;
  v_next   text := case when p_active then 'active' else 'inactive' end;
  v_at     timestamptz;
begin
  if v_caller is null then
    raise exception 'set_app_user_status: an authenticated administrator is required' using errcode = '42501';
  end if;
  select p.role::text as role, p.status, p.super_admin, p.can_confirm_payments
    into v_admin
    from public.profiles p
   where p.id = v_caller
     for share;
  if not found or v_admin.role is distinct from 'admin' or v_admin.status is distinct from 'active' then
    raise exception 'set_app_user_status: the caller is not an active administrator' using errcode = '42501';
  end if;
  if p_profile_id is null or p_active is null then
    raise exception 'set_app_user_status: invalid request' using errcode = '22023';
  end if;
  select p.id, p.role::text as role, p.status, p.super_admin, p.can_confirm_payments, p.permissions,
         p.email as profile_email, p.updated_at as version, u.firebase_uid as uid
    into v_target
    from public.profiles p
    join auth.users u on u.id = p.id
   where p.id = p_profile_id
     for update of p;
  if not found then
    raise exception 'set_app_user_status: no such account' using errcode = 'P0002';
  end if;
  if v_target.id = v_caller then
    raise exception 'set_app_user_status: you cannot change the status of your own account' using errcode = '42501';
  end if;
  perform auth.account_require('set_app_user_status',
    auth.account_required_authority('set_app_user_status', v_target.role, v_target.super_admin,
                                    v_target.can_confirm_payments, coalesce(v_target.permissions, '[]'::jsonb)),
    v_admin.super_admin, v_admin.can_confirm_payments);

  if v_target.status = v_next then                          -- already so: finish, change nothing
    return query select v_target.uid, v_target.profile_email, v_next, v_target.version, false;
    return;
  end if;
  if v_target.status is distinct from (case when p_active then 'inactive' else 'active' end) then
    raise exception 'set_app_user_status: a pending account is activated, not %', case when p_active then 'reactivated' else 'deactivated' end
      using errcode = '55000';
  end if;
  if p_expected is null or v_target.version <> p_expected then
    raise exception 'set_app_user_status: the account changed since it was read' using errcode = '40001';
  end if;
  insert into auth.profile_privileged_changes (txid, profile_id) values (txid_current(), p_profile_id)
    on conflict do nothing;
  update public.profiles set status = v_next where id = p_profile_id returning profiles.updated_at into v_at;
  delete from auth.profile_privileged_changes where txid = txid_current() and profile_id = p_profile_id;
  return query select v_target.uid, v_target.profile_email, v_next, v_at, true;
end $fn$;

create or replace function auth.admin_account_uids()
returns table (id uuid, firebase_uid text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if not exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin' and p.status = 'active') then
    raise exception 'admin_account_uids: administrators only' using errcode = '42501';
  end if;
  return query select u.id, u.firebase_uid from auth.users u join public.profiles p on p.id = u.id;
end $fn$;

comment on function auth.update_app_user(uuid, timestamptz, text, text, text, boolean, boolean, jsonb) is
  'Edits one account (name, role, client code, super admin, billing, permissions), authorized by the caller''s '
  'own active admin profile against the account as stored and as edited (gcp/02_post_migrate.sql section 13).';
comment on function auth.set_app_user_status(uuid, boolean, timestamptz) is
  'active <-> inactive for one account, authorized like activation; returns its Firebase UID and email for the '
  'backend to then disable or enable sign-in (gcp/02_post_migrate.sql section 13).';

do $$
declare f text;
begin
  foreach f in array array[
    'auth.account_authority_rank(text)', 'auth.account_require(text,text,boolean,boolean)',
    'auth.update_app_user(uuid,timestamptz,text,text,text,boolean,boolean,jsonb)',
    'auth.set_app_user_status(uuid,boolean,timestamptz)', 'auth.admin_account_uids()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- The API's entry points (inside a withUserClaims transaction).
grant execute on function auth.update_app_user(uuid, timestamptz, text, text, text, boolean, boolean, jsonb) to authenticated;
grant execute on function auth.set_app_user_status(uuid, boolean, timestamptz) to authenticated;
grant execute on function auth.admin_account_uids() to authenticated;

commit;
