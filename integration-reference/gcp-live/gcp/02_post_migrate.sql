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

-- ── 5. SECURITY DEFINER functions: search pg_temp last ──────────────────────
-- The migrations pin `search_path = public` on their SECURITY DEFINER functions.
-- PostgreSQL then searches the session's temporary schema FIRST for tables and
-- types (never for functions or operators), so a caller able to create
-- temporary objects could plant one they resolve -- e.g. a pg_temp.user_role for
-- enqueue_notification / notify_on_order_event, which cast to user_role.
-- `pg_catalog, public, pg_temp` keeps every function and operator lookup, and
-- the pg_catalog-before-public order, exactly as before; it only moves pg_temp
-- to the end. ALTER FUNCTION ... SET keeps each body, owner, grant and the
-- triggers that call it. Only functions still carrying exactly the migrations'
-- `search_path=public` are touched, so a re-run is a no-op and the stricter
-- paths (section 4, auth.resolve_app_user) are left alone. public is trusted:
-- only its owner (the database owner) can create in it -- verify_bootstrap.sql
-- asserts that, and that every definer function ends its path with pg_temp.
do $$
declare f regprocedure;
begin
  for f in
    select p.oid::regprocedure
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prosecdef
       and p.proconfig = array['search_path=public']
  loop
    execute format('alter function %s set search_path = pg_catalog, public, pg_temp', f);
  end loop;
end $$;

-- ── 6. No temporary objects for application roles ──────────────────────────
-- Every database grants TEMPORARY to PUBLIC by default, so the app login -- and,
-- after SET ROLE, authenticated / anon -- could create temporary tables and
-- types. Nothing in the schema or the API uses them (no migration creates one),
-- so that default is revoked for this database. The database owner and
-- superusers keep TEMP; no application role is granted it. Idempotent.
do $$
begin
  execute format('revoke temporary on database %I from public', current_database());
end $$;

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

-- ── 10. Order documents: private Cloud Storage objects, tracked here ────────
-- Supabase kept documents in its Storage bucket with storage.objects policies
-- (dropped in section 2). On GCP the files live in a PRIVATE Cloud Storage
-- bucket that only the API's service account can reach, and this table is the
-- durable record of each one: which order it belongs to, which stage it serves,
-- its server-generated object name, the validated type, size, checksum and
-- upload state. Nothing outside the API ever names an object.
--
--   * Writes go only through the SECURITY DEFINER functions below, which decide
--     who may add or remove which document, from the caller's own profile and
--     the order's stored state -- never from a submitted path or flag:
--       - an active admin: any document;
--       - a client: its own attachments ('client') on its own open orders;
--       - a production user: the documents of the stage their order is due at
--         (screener / examiner / typer: title_search, supplementary,
--         commitment), only on an order on their own desk.
--     Object names are 'orders/<order id>/<document uuid>', generated here; the
--     uploaded filename is display metadata only.
--   * Reads go through RLS: staff see every stored document (as they see every
--     order) except check scans; a client sees its own attachments, its own
--     check scans and the order's CURRENT title commitment, never the internal
--     search documents. A check scan (kind 'check', section 12) is read only by
--     the order's client and the billing owner -- it carries bank details.
--   * guard_order_documents() (on public.orders) lets a workflow refer only to a
--     stored document of THAT order and the right stage, rewrites the reference
--     from this table (a submitted name, url or path is never kept), freezes a
--     stage's document once the stage is complete, and requires the document a
--     stage depends on before that stage can be stamped: the examiner's
--     researched document and the typer's Title Search Document (the two the
--     portal already requires).
--   * Upload is two-phase so storage and database cannot silently disagree:
--     document_begin_upload() records 'uploading' BEFORE the object is written,
--     document_finish_upload() marks it 'stored' only after the object exists,
--     and document_fail_upload() marks a failed one. Deletion likewise:
--     'deleting' before the object is removed, 'deleted' after (or back to
--     'stored' if storage refused). Rows left 'uploading', 'failed' or
--     'deleting' name exactly the objects a reconciliation job removes.
begin;

create table if not exists public.order_documents (
  id           uuid primary key default gen_random_uuid(),
  order_id     text not null references public.orders(id) on delete cascade,
  kind         text not null,
  object_name  text not null unique,
  filename     text not null check (filename ~ '^[^/\\[:cntrl:]]{1,200}$' and filename !~ '^\.'),
  content_type text not null
               check (content_type in ('application/pdf', 'application/msword',
                 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                 'image/jpeg', 'image/png', 'image/tiff')),
  size_bytes   bigint check (size_bytes between 1 and 26214400),
  sha256       text check (sha256 ~ '^[0-9a-f]{64}$'),
  status       text not null default 'uploading'
               check (status in ('uploading', 'stored', 'failed', 'deleting', 'deleted')),
  uploaded_by  uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  stored_at    timestamptz,
  deleted_by   uuid references public.profiles(id) on delete set null,
  deleted_at   timestamptz,
  constraint order_documents_object_name check (object_name = 'orders/' || order_id || '/' || id::text),
  constraint order_documents_stored_complete
    check (status not in ('stored', 'deleting', 'deleted') or (size_bytes is not null and sha256 is not null and stored_at is not null))
);
create index if not exists order_documents_order_idx on public.order_documents (order_id, kind) where status = 'stored';
-- 'check': the scan of a client's check, for its payment report (section 12).
alter table public.order_documents drop constraint if exists order_documents_kind_check;
alter table public.order_documents add constraint order_documents_kind_check
  check (kind in ('client', 'screener', 'examiner', 'title_search', 'supplementary', 'commitment', 'check'));

alter table public.order_documents enable row level security;
revoke all on table public.order_documents from public, anon, authenticated, service_role;
grant select on table public.order_documents to authenticated;

drop policy if exists order_documents_read on public.order_documents;
create policy order_documents_read on public.order_documents for select to authenticated
  using (
    status = 'stored'
    and (
      (public.is_staff() and order_documents.kind <> 'check')
      or (order_documents.kind = 'check' and public.is_admin() and public.can_confirm_payments())
      or exists (select 1 from public.orders o
                  where o.id = order_documents.order_id
                    and o.client_code = public.my_client_code()
                    and (order_documents.kind in ('client', 'check')
                         or (order_documents.kind = 'commitment'
                             and o.workflow -> 'commitmentDoc' ->> 'documentId' = order_documents.id::text)))
    )
  );

-- The stage an order is waiting on: the first unstamped stage of its effective
-- sequence (QC stages only when the plan assigns them). Mirrors stageSequence()
-- / nextRoleFor() in packages/domain and the sequence in guard_order_handoff.
create or replace function public.order_due_stage(p_completed jsonb, p_plan jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select t.s
    from unnest(array['screener', 'examiner', 'searchqc', 'typer', 'qc', 'delivery']) with ordinality as t(s, ord)
   where (coalesce(p_completed, '{}'::jsonb) ->> t.s) is null
     and (t.s not in ('searchqc', 'qc')
          or (jsonb_typeof(p_plan) = 'object' and nullif(p_plan ->> t.s, '') is not null))
   order by t.ord
   limit 1
$fn$;

-- The pipeline stage a document kind belongs to (null for client attachments).
create or replace function public.document_kind_stage(p_kind text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case p_kind
    when 'screener' then 'screener'
    when 'examiner' then 'examiner'
    when 'title_search' then 'typer'
    when 'supplementary' then 'typer'
    when 'commitment' then 'typer'
  end
$fn$;

-- The reference a workflow carries for a stored document: built from this table
-- only, in the shape the portal's document components already use.
create or replace function public.document_ref(d public.order_documents)
returns jsonb
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select jsonb_build_object(
    'id', d.id, 'documentId', d.id, 'name', d.filename, 'size', d.size_bytes, 'status', 'done',
    'type', case d.content_type
              when 'application/pdf' then 'pdf'
              when 'application/msword' then 'word'
              when 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' then 'word'
              else 'other' end)
$fn$;

-- May the caller add or remove a document of this kind on this order now?
-- Internal: called by the definer functions below with the locked order row.
-- Strictly true or false: a NULL anywhere (no desk, no owner) is a refusal.
create or replace function public.document_write_allowed(p_order public.orders, p_kind text)
returns boolean
language sql
stable
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce(case
    -- an admin: any document except a check scan, which only the client adds
    when public.is_admin() then p_kind <> 'check'
    when p_kind = 'client' then
      not public.is_staff()
      and public.my_client_code() is not null
      and p_order.client_code = public.my_client_code()
      and p_order.status::text not in ('delivered', 'cancelled')
    -- a client's check scan: its own delivered (invoiced) order, not yet paid
    when p_kind = 'check' then
      not public.is_staff()
      and public.my_client_code() is not null
      and p_order.client_code = public.my_client_code()
      and p_order.status::text = 'delivered'
      and coalesce(p_order.workflow -> 'payment' ->> 'status', 'unpaid') <> 'confirmed'
    else
      public.can_work_production()
      and p_order.assigned_to = 'user'::public.user_role
      and p_order.assigned_user_id = auth.uid()
      and public.document_kind_stage(p_kind) is not null
      and public.document_kind_stage(p_kind)
          = public.order_due_stage(p_order.completed_dates, p_order.workflow -> 'stagePlan')
  end, false)
$fn$;

-- Content types accepted for each kind (signatures are checked by the API).
create or replace function public.document_type_allowed(p_kind text, p_content_type text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select coalesce(case
    when p_kind = 'commitment' then p_content_type = 'application/pdf'
    when p_kind = 'check' then p_content_type in ('application/pdf', 'image/jpeg', 'image/png', 'image/tiff')
    when p_kind = 'client' then p_content_type in ('application/pdf', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'image/jpeg', 'image/png', 'image/tiff')
    when p_kind in ('screener', 'examiner', 'title_search', 'supplementary') then p_content_type in ('application/pdf',
      'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    else false
  end, false)
$fn$;

create or replace function public.document_begin_upload(p_order_id text, p_kind text, p_filename text, p_content_type text)
returns table (out_id uuid, out_object_name text)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_order public.orders;
  v_id    uuid := gen_random_uuid();
  v_count int;
begin
  if auth.uid() is null then
    raise exception 'documents: an authenticated user is required' using errcode = '42501';
  end if;
  if p_kind is null or public.document_type_allowed(p_kind, 'application/pdf') is not true then
    raise exception 'documents: unknown document kind' using errcode = '22023';
  end if;
  if p_filename is null or p_filename !~ '^[^/\\[:cntrl:]]{1,200}$' or p_filename ~ '^\.' then
    raise exception 'documents: invalid file name' using errcode = '22023';
  end if;
  if public.document_type_allowed(p_kind, p_content_type) is not true then
    raise exception 'documents: this file type is not accepted for this document' using errcode = '22023';
  end if;
  -- The order as the caller may see it (orders_read), locked against a
  -- concurrent stage move while the authority is decided.
  select o.* into v_order
    from public.orders o
   where o.id = p_order_id
     and (public.is_staff() or (public.my_client_code() is not null and o.client_code = public.my_client_code()))
     for share;
  if not found then
    raise exception 'documents: order not found' using errcode = 'P0002';
  end if;
  if public.document_write_allowed(v_order, p_kind) is not true then
    raise exception 'documents: you may not add this document to this order now' using errcode = '42501';
  end if;
  select count(*) into v_count
    from public.order_documents d
   where d.order_id = v_order.id and d.status in ('uploading', 'stored');
  if v_count >= 50 then
    raise exception 'documents: this order already has the maximum number of documents' using errcode = '55000';
  end if;
  insert into public.order_documents (id, order_id, kind, object_name, filename, content_type, uploaded_by)
  values (v_id, v_order.id, p_kind, 'orders/' || v_order.id || '/' || v_id::text, p_filename, p_content_type, auth.uid());
  return query select v_id, 'orders/' || v_order.id || '/' || v_id::text;
end $fn$;

create or replace function public.document_finish_upload(p_id uuid, p_size bigint, p_sha256 text, p_content_type text)
returns setof public.order_documents
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_doc   public.order_documents;
  v_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'documents: an authenticated user is required' using errcode = '42501';
  end if;
  select d.* into v_doc from public.order_documents d where d.id = p_id for update;
  if not found or v_doc.uploaded_by is distinct from auth.uid() then
    raise exception 'documents: upload not found' using errcode = 'P0002';
  end if;
  if v_doc.status <> 'uploading' then
    raise exception 'documents: this upload is no longer in progress' using errcode = '55000';
  end if;
  if p_content_type is distinct from v_doc.content_type then
    raise exception 'documents: the file type does not match the upload' using errcode = '22023';
  end if;
  if p_size is null or p_size < 1 or p_size > 26214400 or p_sha256 is null or p_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'documents: invalid size or checksum' using errcode = '22023';
  end if;
  -- Re-decide the authority at completion: the order may have moved on.
  select o.* into v_order from public.orders o where o.id = v_doc.order_id for update;
  if not found or public.document_write_allowed(v_order, v_doc.kind) is not true then
    raise exception 'documents: you may no longer add this document to this order' using errcode = '42501';
  end if;
  update public.order_documents
     set status = 'stored', size_bytes = p_size, sha256 = p_sha256, stored_at = now()
   where id = p_id
  returning * into v_doc;
  -- A client attachment is listed on the order at once (clients cannot write
  -- orders themselves); the reference is built from this row.
  if v_doc.kind = 'client' then
    update public.orders
       set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{clientDocs}',
             (case when jsonb_typeof(workflow -> 'clientDocs') = 'array' then workflow -> 'clientDocs' else '[]'::jsonb end)
             || jsonb_build_array(public.document_ref(v_doc)), true)
     where id = v_order.id;
  end if;
  return next v_doc;
end $fn$;

-- The uploader marks an unfinished upload failed; returns the object name for
-- clean-up (idempotent for an already failed one).
create or replace function public.document_fail_upload(p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare v_doc public.order_documents;
begin
  if auth.uid() is null then
    raise exception 'documents: an authenticated user is required' using errcode = '42501';
  end if;
  select d.* into v_doc from public.order_documents d where d.id = p_id for update;
  if not found or v_doc.uploaded_by is distinct from auth.uid() or v_doc.status not in ('uploading', 'failed') then
    raise exception 'documents: upload not found' using errcode = 'P0002';
  end if;
  update public.order_documents set status = 'failed' where id = p_id;
  return v_doc.object_name;
end $fn$;

-- Is this document referenced by the order's workflow?
create or replace function public.document_referenced(p_workflow jsonb, p_id uuid)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select coalesce(p_workflow -> 'screenerDoc' ->> 'documentId' = p_id::text, false)
      or coalesce(p_workflow -> 'examinerDoc' ->> 'documentId' = p_id::text, false)
      or coalesce(p_workflow -> 'commitmentDoc' ->> 'documentId' = p_id::text, false)
      or coalesce(p_workflow -> 'payment' -> 'checkDoc' ->> 'documentId' = p_id::text, false)
      or exists (select 1
                   from jsonb_array_elements(case when jsonb_typeof(p_workflow -> 'clientDocs') = 'array'
                                                  then p_workflow -> 'clientDocs' else '[]'::jsonb end) e
                  where e ->> 'documentId' = p_id::text)
$fn$;

-- Removal, phase 1: authorize and mark 'deleting'; returns the object name.
-- Never for a document whose stage is complete, or one the workflow still
-- references (a client's own attachment is unlisted by phase 2 instead).
create or replace function public.document_begin_delete(p_id uuid)
returns text
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_doc   public.order_documents;
  v_order public.orders;
begin
  if auth.uid() is null then
    raise exception 'documents: an authenticated user is required' using errcode = '42501';
  end if;
  select d.* into v_doc from public.order_documents d where d.id = p_id and d.status = 'stored' for update;
  if found then
    select o.* into v_order from public.orders o where o.id = v_doc.order_id for update;
  end if;
  -- Hidden and absent are the same answer (the read policy's rule).
  if v_doc.id is null or ((public.is_staff() and v_doc.kind <> 'check')
       or (v_doc.kind = 'check' and public.is_admin() and public.can_confirm_payments())
       or (public.my_client_code() is not null and v_order.client_code = public.my_client_code() and v_doc.kind in ('client', 'check'))) is not true then
    raise exception 'documents: document not found' using errcode = 'P0002';
  end if;
  -- Record integrity first (for anyone who can see the document), then authority.
  if v_doc.kind = 'client' then
    if v_order.status::text in ('delivered', 'cancelled') then
      raise exception 'documents: the order is closed; its documents are part of the record' using errcode = '55000';
    end if;
  elsif v_doc.kind = 'check' then
    -- Once a payment report named it (now or in a report later bounced), the
    -- scan is evidence in the billing trail (section 12).
    if public.document_referenced(v_order.workflow, v_doc.id) is not false
       or exists (select 1 from public.order_events e
                   where e.order_id = v_doc.order_id and e.kind = 'payment.reported'
                     and e.meta ->> 'checkDocumentId' = v_doc.id::text) then
      raise exception 'documents: the check scan belongs to a reported payment; it is part of the record' using errcode = '55000';
    end if;
  else
    if (v_order.completed_dates ->> public.document_kind_stage(v_doc.kind)) is not null then
      raise exception 'documents: the stage is complete; its documents are part of the order record' using errcode = '55000';
    end if;
    if public.document_referenced(v_order.workflow, v_doc.id) is not false then
      raise exception 'documents: the order references this document' using errcode = '55000';
    end if;
  end if;
  if (public.is_admin() or (v_doc.uploaded_by = auth.uid() and public.document_write_allowed(v_order, v_doc.kind))) is not true then
    raise exception 'documents: you may not remove this document' using errcode = '42501';
  end if;
  update public.order_documents set status = 'deleting', deleted_by = auth.uid() where id = p_id;
  return v_doc.object_name;
end $fn$;

-- Removal, phase 2: the object is gone; record it (and unlist a client attachment).
create or replace function public.document_finish_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare v_doc public.order_documents;
begin
  select d.* into v_doc from public.order_documents d where d.id = p_id for update;
  if not found or v_doc.status <> 'deleting' or v_doc.deleted_by is distinct from auth.uid() or auth.uid() is null then
    raise exception 'documents: no removal in progress' using errcode = 'P0002';
  end if;
  update public.order_documents set status = 'deleted', deleted_at = now() where id = p_id;
  if v_doc.kind = 'client' then
    update public.orders o
       set workflow = jsonb_set(o.workflow, '{clientDocs}',
             coalesce((select jsonb_agg(e) from jsonb_array_elements(o.workflow -> 'clientDocs') e
                        where e ->> 'documentId' is distinct from p_id::text), '[]'::jsonb))
     where o.id = v_doc.order_id and jsonb_typeof(o.workflow -> 'clientDocs') = 'array';
  end if;
end $fn$;

-- Removal, abandoned (storage refused): the document is available again.
create or replace function public.document_abort_delete(p_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
begin
  update public.order_documents
     set status = 'stored', deleted_by = null
   where id = p_id and status = 'deleting' and deleted_by = auth.uid() and auth.uid() is not null;
  if not found then
    raise exception 'documents: no removal in progress' using errcode = 'P0002';
  end if;
end $fn$;

-- Workflow references to documents, checked on every application write to an
-- order (admins included; RPCs, migrations and operators pass through).
create or replace function public.guard_order_documents()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  k      text;
  v_kind text;
  v_new  jsonb;
  v_old  jsonb;
  v_id   text;
  v_doc  public.order_documents;
  v_out  jsonb;
  e      jsonb;
  c_uuid constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.workflow, '{}'::jsonb) ?| array['screenerDoc', 'examinerDoc', 'commitmentDoc', 'clientDocs'] then
      raise exception 'a new order cannot carry documents; upload them to the order once it exists';
    end if;
    return new;
  end if;

  -- 1. Stage documents: a stored document of this order and stage, rewritten
  --    from the table; frozen once the stage is complete.
  foreach k in array array['screenerDoc', 'examinerDoc', 'commitmentDoc'] loop
    v_kind := case k when 'screenerDoc' then 'screener' when 'examinerDoc' then 'examiner' else 'commitment' end;
    v_new := new.workflow -> k;
    v_old := old.workflow -> k;
    continue when v_new is not distinct from v_old;
    if (old.completed_dates ->> public.document_kind_stage(v_kind)) is not null then
      raise exception 'the % stage is complete: its document cannot be replaced or removed', public.document_kind_stage(v_kind);
    end if;
    continue when v_new is null or v_new = 'null'::jsonb;
    v_id := case when jsonb_typeof(v_new) = 'object' then v_new ->> 'documentId' end;
    if v_id is null or v_id !~ c_uuid then
      raise exception 'workflow.% must reference a stored % document of this order', k, v_kind;
    end if;
    select d.* into v_doc from public.order_documents d
     where d.id = v_id::uuid and d.order_id = new.id and d.kind = v_kind and d.status = 'stored';
    if not found then
      raise exception 'workflow.% must reference a stored % document of this order', k, v_kind;
    end if;
    new.workflow := jsonb_set(new.workflow, array[k], public.document_ref(v_doc));
  end loop;

  -- 2. Client attachments: stored client documents of this order only.
  v_new := new.workflow -> 'clientDocs';
  v_old := old.workflow -> 'clientDocs';
  if v_new is distinct from v_old and v_new is not null and v_new <> 'null'::jsonb then
    if jsonb_typeof(v_new) <> 'array' or jsonb_array_length(v_new) > 50 then
      raise exception 'workflow.clientDocs must be a list of stored client documents of this order';
    end if;
    v_out := '[]'::jsonb;
    for e in select x from jsonb_array_elements(v_new) x loop
      v_id := case when jsonb_typeof(e) = 'object' then e ->> 'documentId' end;
      if v_id is null or v_id !~ c_uuid then
        raise exception 'workflow.clientDocs must be a list of stored client documents of this order';
      end if;
      select d.* into v_doc from public.order_documents d
       where d.id = v_id::uuid and d.order_id = new.id and d.kind = 'client' and d.status = 'stored';
      if not found then
        raise exception 'workflow.clientDocs must be a list of stored client documents of this order';
      end if;
      v_out := v_out || jsonb_build_array(public.document_ref(v_doc));
    end loop;
    new.workflow := jsonb_set(new.workflow, '{clientDocs}', v_out);
  end if;

  -- 3. The documents a stage depends on, before it can be stamped.
  if (old.completed_dates ->> 'examiner') is null and (new.completed_dates ->> 'examiner') is not null then
    v_id := new.workflow -> 'examinerDoc' ->> 'documentId';
    if v_id is null or not exists (select 1 from public.order_documents d
                                     where d.id::text = v_id and d.order_id = new.id
                                       and d.kind = 'examiner' and d.status = 'stored') then
      raise exception 'completing the examiner stage requires its researched document: upload it to this order first';
    end if;
  end if;
  if (old.completed_dates ->> 'typer') is null and (new.completed_dates ->> 'typer') is not null then
    if not exists (select 1 from public.order_documents d
                    where d.order_id = new.id and d.kind = 'title_search' and d.status = 'stored') then
      raise exception 'completing typing requires the Title Search Document: upload it to this order first';
    end if;
  end if;
  return new;
end $fn$;

-- Named to fire after the handoff and payment guards (triggers run in name
-- order), so an illegal move is refused for that reason first.
drop trigger if exists orders_guard_stage_documents on public.orders;
create trigger orders_guard_stage_documents
  before insert or update on public.orders
  for each row execute function public.guard_order_documents();

comment on table public.order_documents is
  'Order documents stored as private Cloud Storage objects (gcp/02_post_migrate.sql section 10). '
  'Written only through the document_* functions; object names are server-generated.';

revoke all on function public.order_due_stage(jsonb, jsonb) from public, anon, authenticated, service_role;
revoke all on function public.document_kind_stage(text) from public, anon, authenticated, service_role;
revoke all on function public.document_ref(public.order_documents) from public, anon, authenticated, service_role;
revoke all on function public.document_write_allowed(public.orders, text) from public, anon, authenticated, service_role;
revoke all on function public.document_type_allowed(text, text) from public, anon, authenticated, service_role;
revoke all on function public.document_referenced(jsonb, uuid) from public, anon, authenticated, service_role;
revoke all on function public.guard_order_documents() from public, anon, authenticated, service_role;
revoke all on function public.document_begin_upload(text, text, text, text) from public, anon, authenticated, service_role;
revoke all on function public.document_finish_upload(uuid, bigint, text, text) from public, anon, authenticated, service_role;
revoke all on function public.document_fail_upload(uuid) from public, anon, authenticated, service_role;
revoke all on function public.document_begin_delete(uuid) from public, anon, authenticated, service_role;
revoke all on function public.document_finish_delete(uuid) from public, anon, authenticated, service_role;
revoke all on function public.document_abort_delete(uuid) from public, anon, authenticated, service_role;
-- The guard runs as the writer: the pure helpers it calls.
grant execute on function public.document_kind_stage(text) to authenticated;
grant execute on function public.document_ref(public.order_documents) to authenticated;
-- The API's entry points.
grant execute on function public.document_begin_upload(text, text, text, text) to authenticated;
grant execute on function public.document_finish_upload(uuid, bigint, text, text) to authenticated;
grant execute on function public.document_fail_upload(uuid) to authenticated;
grant execute on function public.document_begin_delete(uuid) to authenticated;
grant execute on function public.document_finish_delete(uuid) to authenticated;
grant execute on function public.document_abort_delete(uuid) to authenticated;

commit;

-- ── 11. Portal communication: messages, activity trail, in-app notifications ─
-- Who sees and writes what (the API adds nothing to these rules; it runs every
-- statement as `authenticated` inside the caller's claims transaction):
--
--   Messages (support_messages: an order's thread when order_id is set, else the
--   client's general support thread). Append-only; no application role may
--   update or delete one.
--     - client: reads the CLIENT-VISIBLE messages of its own client code (its
--       orders' threads and its general thread), never an internal note;
--       writes as 'client', client-visible, on its own orders / own thread.
--     - admin: reads everything; writes client-visible replies (the only role
--       that answers a client -- support_admin_reply) and internal notes.
--     - production user: reads (view only) and adds internal notes to the
--       threads of THEIR work only -- an order on their desk or naming them
--       in its stage plan (order_is_my_work); never another order's thread
--       and never a general support conversation. The API shows them a
--       client's messages as "Client", never the person's name.
--     Sender, author, author id, client code (from the order) and time are set
--     here from the caller's own profile, never taken from the request; the
--     existing RLS insert policies then decide. Attachments are not accepted
--     yet. A request id makes a retried send return the stored message.
--
--   Activity (order_events). Written ONLY by the triggers below, from the
--   committed change itself (order placed / updated, document stored /
--   removed), inside the same transaction -- a rolled-back write leaves no
--   event. No application role can insert, update or delete a row, and the
--   actor's id and email are not readable by them. Audience:
--     'all'   (the order's client and staff): placed, confirmed, on hold /
--             resumed, clarification requested / answered, cancellation
--             requested / approved / declined / cancelled, client attachment
--             added / removed, delivered;
--     'staff' (staff only): stage plan, assignment, stage completions and
--             routing, returned to Admin / escalated, QC corrections, payment
--             method, internal documents (search, research, title search,
--             supplementary, commitment).
--   The actor is the staff member's name, 'Client' for a client (production
--   staff never see client people's names) or 'System'. Metadata is the stage,
--   document kind and display file name -- never an email, token or file byte.
--
--   Notifications (public.notifications, in-app only). One row per recipient,
--   created by the same triggers in the same transaction as the event or
--   message (so never for a write that rolled back), deduplicated per source
--   and recipient, never for the person who acted, never for an inactive
--   account -- and one per action: a message written in the same transaction
--   as an order change does not notify again whoever that change notified. Read only by the recipient (RLS); marked read only by the
--   recipient, through notifications_mark_read / _mark_all_read.
--     order.new          -> active admins (a client or admin placed an order)
--     order.assigned     -> the production user who now owns the order
--     order.returned     -> admins (parked with Admin: returned, escalated)
--     order.confirmed / order.hold / order.clarification (requested) /
--     order.cancel (approved, declined) / order.delivered -> the client's users
--     order.clarification (answered) / order.cancel (requested, cancelled by
--     the client) / order.delivered -> admins
--     message.client     -> admins and the order's production owner
--     message.reply      -> the client's users (an admin's client-visible reply)
--     message.note       -> admins and the order's production owner, never clients
--     document.client    -> admins and the production owner (a client attachment)
begin;

-- 11.1 Messages ---------------------------------------------------------------
alter table public.support_messages add column if not exists author_id uuid references public.profiles(id) on delete set null;
alter table public.support_messages add column if not exists request_id uuid;
create unique index if not exists support_messages_request_idx
  on public.support_messages (author_id, request_id) where request_id is not null;

revoke all on table public.support_messages from public, anon, authenticated, service_role;
grant select on table public.support_messages to authenticated;
-- Only the columns a sender chooses; everything else is the server's.
grant insert (order_id, client_code, sender, visibility, body, request_id) on table public.support_messages to authenticated;

create or replace function public.guard_support_message()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_me    public.profiles;
  v_order public.orders;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  select p.* into v_me from public.profiles p where p.id = auth.uid() and p.status = 'active';
  if v_me.id is null then
    raise exception 'messages: an active account is required' using errcode = '42501';
  end if;
  new.id := gen_random_uuid();
  new.created_at := clock_timestamp();
  new.author_id := v_me.id;
  new.author := v_me.name;
  new.sender := case when v_me.role = 'client' then 'client' else 'support' end;
  if new.attachment is not null then
    raise exception 'messages: attachments are not available yet' using errcode = '22023';
  end if;
  new.body := btrim(coalesce(new.body, ''), E' \t\r\n');
  if char_length(new.body) < 1 or char_length(new.body) > 4000 then
    raise exception 'messages: a message must be 1 to 4000 characters' using errcode = '22023';
  end if;
  if new.body ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'messages: the message contains control characters' using errcode = '22023';
  end if;
  if new.order_id is not null then
    -- The order as the caller may see it (orders_read): its client code, never
    -- the submitted one.
    select o.* into v_order from public.orders o where o.id = new.order_id;
    if v_order.id is null or v_order.client_code is null then
      raise exception 'messages: order not found' using errcode = 'P0002';
    end if;
    new.client_code := v_order.client_code;
  elsif v_me.role = 'client' then
    new.client_code := v_me.client_code;
  elsif new.client_code is null
        or not exists (select 1 from public.support_messages m
                        where m.order_id is null and m.client_code = new.client_code) then
    -- Staff answer a client's existing support conversation; they never open
    -- one to an arbitrary client code.
    raise exception 'messages: conversation not found' using errcode = 'P0002';
  end if;
  if new.client_code is null then
    raise exception 'messages: conversation not found' using errcode = 'P0002';
  end if;
  return new;
end $fn$;

drop trigger if exists support_messages_guard on public.support_messages;
create trigger support_messages_guard
  before insert on public.support_messages
  for each row execute function public.guard_support_message();

-- A production user's conversations are those of their own work: an order on
-- their desk, or one whose stage plan names them (the work Admin assigned
-- them). Not every client's conversation because of the role, and never a
-- general support conversation -- those are the client's and Admin's.
create or replace function public.order_is_my_work(p_order_id text)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce((
    select public.can_work_production()
       and ((o.assigned_to = 'user' and o.assigned_user_id = auth.uid())
            or (jsonb_typeof(o.workflow -> 'stagePlan') = 'object'
                and exists (select 1 from jsonb_each_text(o.workflow -> 'stagePlan') s where s.value = auth.uid()::text)))
      from public.orders o where o.id = p_order_id), false)
$fn$;

-- Staff read and note policies, narrowed from is_staff(): Admin reads every
-- conversation and may note any; a production user reads and notes only the
-- conversations of orders that are their work. The client policies and
-- support_admin_reply are unchanged.
drop policy if exists support_staff_read on public.support_messages;
create policy support_staff_read on public.support_messages for select
  using (public.is_admin() or (order_id is not null and public.order_is_my_work(order_id)));
drop policy if exists support_staff_note on public.support_messages;
create policy support_staff_note on public.support_messages for insert
  with check (sender = 'support' and visibility = 'internal'
              and (public.is_admin() or (order_id is not null and public.order_is_my_work(order_id))));

-- 11.2 Activity ---------------------------------------------------------------
alter table public.order_events add column if not exists kind text;
alter table public.order_events add column if not exists actor_id uuid references public.profiles(id) on delete set null;
alter table public.order_events add column if not exists meta jsonb not null default '{}'::jsonb;
create index if not exists order_events_order_time_idx on public.order_events (order_id, created_at, id);

revoke all on table public.order_events from public, anon, authenticated, service_role;
grant select (id, order_id, kind, type, audience, action, actor, created_at, meta) on table public.order_events to authenticated;
do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.order_events', 'id'));
end $$;

-- Every row here is written by activity_record() (kind set). The Supabase-era
-- free-text inserts -- client_cancel_order() and client_respond_clarification()
-- still make one -- are not stored: the order trigger has already recorded the
-- same transition, structurally, in the same transaction.
create or replace function public.order_events_structured()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, pg_temp
as $fn$
begin
  if new.kind is null then
    return null;
  end if;
  return new;
end $fn$;

drop trigger if exists order_events_structured on public.order_events;
create trigger order_events_structured
  before insert on public.order_events
  for each row execute function public.order_events_structured();

-- Who acted, as the activity trail names them.
create or replace function public.activity_actor_name()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce((select case when p.role = 'client' then 'Client' else p.name end
                     from public.profiles p where p.id = auth.uid()), 'System')
$fn$;

create or replace function public.activity_stage_label(p_stage text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
  select case p_stage
    when 'screener' then 'Screening' when 'searchqc' then 'Search QC' when 'examiner' then 'Examination'
    when 'typer' then 'Typing' when 'qc' then 'Typing QC' when 'delivery' then 'Delivery'
    else coalesce(p_stage, 'the next stage') end
$fn$;

create or replace function public.activity_record(p_order_id text, p_kind text, p_audience text, p_action text,
                                                  p_meta jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_me public.profiles;
  v_id bigint;
begin
  select p.* into v_me from public.profiles p where p.id = auth.uid();
  insert into public.order_events (order_id, kind, type, audience, action, actor, actor_id, actor_email, meta)
  values (p_order_id, p_kind,
          case when p_kind = 'order.placed' then 'new'
               when p_kind in ('stage.completed', 'order.delivered') then 'progress'
               else 'status' end,
          p_audience, left(p_action, 600),
          case when v_me.id is null then 'System' when v_me.role = 'client' then 'Client' else v_me.name end,
          v_me.id,
          case when v_me.role = 'client' then null else v_me.email end,
          coalesce(p_meta, '{}'::jsonb))
  returning id into v_id;
  return v_id;
end $fn$;

-- 11.3 Notifications ----------------------------------------------------------
create table if not exists public.notifications (
  id           bigint generated always as identity primary key,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  kind         text not null check (kind ~ '^[a-z]+\.[a-z_]+$'),
  order_id     text references public.orders(id) on delete cascade,
  target       text not null default 'order' check (target in ('order', 'messages', 'support')),
  title        text not null check (char_length(title) between 1 and 200),
  body         text check (body is null or char_length(body) <= 500),
  event_id     bigint references public.order_events(id) on delete set null,
  message_id   uuid references public.support_messages(id) on delete cascade,
  dedupe_key   text not null unique,
  -- The transaction that raised it: one action (an order change and the
  -- message that goes with it) tells each recipient once.
  txid         bigint not null default txid_current(),
  created_at   timestamptz not null default clock_timestamp(),
  read_at      timestamptz
);
create index if not exists notifications_txid_idx on public.notifications (txid, order_id);
create index if not exists notifications_recipient_idx on public.notifications (recipient_id, created_at desc, id desc);

alter table public.notifications enable row level security;
revoke all on table public.notifications from public, anon, authenticated, service_role;
grant select on table public.notifications to authenticated;
do $$
begin
  execute format('revoke all on sequence %s from public, anon, authenticated, service_role',
                 pg_get_serial_sequence('public.notifications', 'id'));
end $$;

drop policy if exists notifications_own on public.notifications;
create policy notifications_own on public.notifications for select to authenticated
  using (recipient_id = auth.uid());

create or replace function public.notify_admin_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce(array_agg(p.id), '{}') from public.profiles p where p.role = 'admin' and p.status = 'active'
$fn$;

create or replace function public.notify_client_ids(p_client_code text)
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
   where p.role = 'client' and p.status = 'active' and p.client_code is not null and p.client_code = p_client_code
$fn$;

-- One notification per active recipient, never to the person who acted;
-- `p_source` (the event or message) makes a replay a no-op.
create or replace function public.notify_profiles(p_recipients uuid[], p_kind text, p_order_id text, p_target text,
                                                  p_title text, p_body text, p_source text,
                                                  p_event_id bigint default null, p_message_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare n integer;
begin
  insert into public.notifications (recipient_id, kind, order_id, target, title, body, event_id, message_id, dedupe_key)
  select p.id, p_kind, p_order_id, p_target, left(p_title, 200), left(nullif(btrim(p_body), ''), 500),
         p_event_id, p_message_id, p_source || ':' || p_kind || ':' || p.id::text
    from public.profiles p
   where p.id = any (coalesce(p_recipients, '{}'))
     and p.status = 'active'
     and p.id is distinct from auth.uid()
  on conflict (dedupe_key) do nothing;
  get diagnostics n = row_count;
  return n;
end $fn$;

create or replace function public.notifications_mark_read(p_ids bigint[])
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare n integer;
begin
  if auth.uid() is null then
    raise exception 'notifications: an authenticated user is required' using errcode = '42501';
  end if;
  if p_ids is null or cardinality(p_ids) > 500 then
    raise exception 'notifications: invalid list' using errcode = '22023';
  end if;
  update public.notifications set read_at = now()
   where recipient_id = auth.uid() and id = any (p_ids) and read_at is null;
  get diagnostics n = row_count;
  return n;
end $fn$;

create or replace function public.notifications_mark_all_read()
returns integer
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare n integer;
begin
  if auth.uid() is null then
    raise exception 'notifications: an authenticated user is required' using errcode = '42501';
  end if;
  update public.notifications set read_at = now() where recipient_id = auth.uid() and read_at is null;
  get diagnostics n = row_count;
  return n;
end $fn$;

-- 11.4 The triggers that record activity and raise notifications -------------
create or replace function public.orders_activity_insert()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare v_event bigint;
begin
  v_event := public.activity_record(new.id, 'order.placed', 'all',
    format('Order %s placed (%s)', new.id, coalesce(new.type, 'Search')),
    jsonb_build_object('source', coalesce(new.workflow -> 'intake' ->> 'source', 'web')));
  perform public.notify_profiles(public.notify_admin_ids(), 'order.new', new.id, 'order',
    format('New order %s', new.id),
    concat_ws(' · ', new.type, nullif(concat_ws(', ', nullif(new.county, ''), nullif(new.state, '')), ''),
              'client ' || new.client_code),
    'evt:' || v_event, v_event);
  return null;
end $fn$;

create or replace function public.orders_activity_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  c_stages   constant text[] := array['screener', 'searchqc', 'examiner', 'typer', 'qc', 'delivery'];
  v_actor    text := public.activity_actor_name();
  v_is_client boolean := exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'client');
  v_old_owner uuid := case when old.assigned_to = 'user' then old.assigned_user_id end;
  v_new_owner uuid := case when new.assigned_to = 'user' then new.assigned_user_id end;
  v_owner_name text;
  v_stamped  text[];
  v_reopened text[];
  v_due      text;
  v_note     text;
  v_event    bigint;
  v_route    bigint;   -- the event that put the order on a desk or back with Admin
  v_req_old  jsonb := nullif(old.workflow -> 'cancelRequested', 'null'::jsonb);
  v_req_new  jsonb := nullif(new.workflow -> 'cancelRequested', 'null'::jsonb);
  v_where    text := nullif(concat_ws(', ', nullif(new.county, ''), nullif(new.state, '')), '');
begin
  select coalesce(array_agg(x order by coalesce(array_position(c_stages, x), 99), x), '{}') into v_stamped
    from jsonb_object_keys(case when jsonb_typeof(new.completed_dates) = 'object' then new.completed_dates else '{}'::jsonb end) x
   where (new.completed_dates ->> x) is not null
     and (case when jsonb_typeof(old.completed_dates) = 'object' then old.completed_dates ->> x end) is null;
  select coalesce(array_agg(x order by coalesce(array_position(c_stages, x), 99), x), '{}') into v_reopened
    from jsonb_object_keys(case when jsonb_typeof(old.completed_dates) = 'object' then old.completed_dates else '{}'::jsonb end) x
   where (old.completed_dates ->> x) is not null
     and (case when jsonb_typeof(new.completed_dates) = 'object' then new.completed_dates ->> x end) is null;
  v_due := public.order_due_stage(new.completed_dates, new.workflow -> 'stagePlan');
  if v_new_owner is not null then
    select p.name into v_owner_name from public.profiles p where p.id = v_new_owner;
  end if;

  -- The course of flow.
  if new.workflow -> 'stagePlan' is distinct from old.workflow -> 'stagePlan'
     and jsonb_typeof(new.workflow -> 'stagePlan') = 'object' then
    perform public.activity_record(new.id, 'order.planned', 'staff',
      format('%s set the stage plan for %s%s', v_actor, new.id,
             case when new.workflow -> 'singleSeating' = 'true'::jsonb then ' (single seating)' else '' end));
  end if;

  -- Confirmation (Admin acknowledged / priced the order).
  if new.workflow -> 'confirmed' = 'true'::jsonb and old.workflow -> 'confirmed' is distinct from 'true'::jsonb then
    v_event := public.activity_record(new.id, 'order.confirmed', 'all',
      format('%s confirmed %s', v_actor, new.id) || coalesce(', estimated completion ' || to_char(new.eta, 'YYYY-MM-DD'), ''));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.confirmed', new.id, 'order',
      format('Order %s confirmed', new.id),
      'Resolute confirmed your order' || coalesce(' — estimated completion ' || to_char(new.eta, 'YYYY-MM-DD'), '') || '.',
      'evt:' || v_event, v_event);
  end if;

  -- Stage completions, and where the order went next.
  if cardinality(v_stamped) > 0 then
    v_route := public.activity_record(new.id, 'stage.completed', 'staff',
      format('%s completed %s on %s', v_actor,
             (select string_agg(public.activity_stage_label(x), ', ' order by o) from unnest(v_stamped) with ordinality u(x, o)),
             new.id)
      || case
           when new.status = 'delivered' then ' → delivered'
           when new.assigned_to = 'admin' then ' → returned to Admin'
           when v_new_owner is not null and v_new_owner is distinct from v_old_owner
             then format(' → routed to the %s owner (%s)', public.activity_stage_label(v_due), coalesce(v_owner_name, 'unknown'))
           when v_due is not null then format(' → continuing to %s', public.activity_stage_label(v_due))
           else '' end,
      jsonb_build_object('stages', to_jsonb(v_stamped), 'next', v_due));
  end if;

  -- Stages reopened (QC sent the order back for corrections).
  if cardinality(v_reopened) > 0 then
    v_note := case when new.workflow -> 'qcReview' is distinct from old.workflow -> 'qcReview'
                   then left(nullif(btrim(new.workflow -> 'qcReview' ->> 'note'), ''), 300) end;
    v_route := public.activity_record(new.id, 'stage.reopened', 'staff',
      format('%s sent %s back to %s for corrections', v_actor, new.id, public.activity_stage_label(coalesce(v_due, v_reopened[1])))
      || coalesce(' — ' || v_note, ''),
      jsonb_build_object('stages', to_jsonb(v_reopened)));
  end if;

  -- Assignment / reassignment by Admin (no stage completed in the same write).
  if cardinality(v_stamped) = 0 and cardinality(v_reopened) = 0
     and v_new_owner is not null and v_new_owner is distinct from v_old_owner then
    v_route := public.activity_record(new.id, 'order.assigned', 'staff',
      format('%s assigned %s to %s', v_actor, new.id, coalesce(v_owner_name, 'a production user'))
      || coalesce(' (' || public.activity_stage_label(v_due) || ')', ''),
      jsonb_build_object('stage', v_due));
  end if;

  -- Parked with Admin without completing a stage: escalated, or unassigned.
  if cardinality(v_stamped) = 0 and cardinality(v_reopened) = 0
     and new.assigned_to = 'admin' and old.assigned_to is distinct from 'admin'
     and new.status not in ('delivered', 'cancelled') then
    if new.workflow -> 'handoff' is distinct from old.workflow -> 'handoff' and jsonb_typeof(new.workflow -> 'handoff') = 'object' then
      v_note := left(nullif(btrim(new.workflow -> 'handoff' ->> 'note'), ''), 300);
      v_route := public.activity_record(new.id, 'order.escalated', 'staff',
        format('%s escalated %s — returned to Admin', v_actor, new.id) || coalesce(': ' || v_note, ''));
    else
      v_route := public.activity_record(new.id, 'order.unassigned', 'staff',
        format('%s returned %s to the Admin queue', v_actor, new.id));
    end if;
  end if;

  if v_new_owner is not null and v_new_owner is distinct from v_old_owner then
    perform public.notify_profiles(array[v_new_owner], 'order.assigned', new.id, 'order',
      format('%s is on your desk', new.id),
      concat_ws(' · ', public.activity_stage_label(v_due), new.type, v_where),
      'evt:' || coalesce(v_route::text, 'assign:' || new.id || ':' || txid_current()::text), v_route);
  end if;
  if new.assigned_to = 'admin' and old.assigned_to is distinct from 'admin' and new.status not in ('delivered', 'cancelled') then
    perform public.notify_profiles(public.notify_admin_ids(), 'order.returned', new.id, 'order',
      format('%s needs Admin', new.id),
      case when cardinality(v_stamped) > 0
             then format('%s complete — assign %s', public.activity_stage_label(v_stamped[cardinality(v_stamped)]),
                         public.activity_stage_label(v_due))
           when jsonb_typeof(new.workflow -> 'handoff') = 'object' and new.workflow -> 'handoff' is distinct from old.workflow -> 'handoff'
             then 'Escalated: ' || coalesce(left(nullif(btrim(new.workflow -> 'handoff' ->> 'note'), ''), 300), 'no note')
           else 'Returned to the Admin queue' end,
      'evt:' || coalesce(v_route::text, 'admin:' || new.id || ':' || txid_current()::text), v_route);
  end if;

  -- Hold / resume.
  if new.workflow -> 'onHold' = 'true'::jsonb and old.workflow -> 'onHold' is distinct from 'true'::jsonb then
    v_note := left(nullif(btrim(new.workflow ->> 'holdReason'), ''), 300);
    v_event := public.activity_record(new.id, 'order.hold', 'all',
      format('%s put %s on hold', v_actor, new.id) || coalesce(' — ' || v_note, ''));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.hold', new.id, 'order',
      format('Order %s is on hold', new.id), v_note, 'evt:' || v_event, v_event);
  elsif old.workflow -> 'onHold' = 'true'::jsonb and new.workflow -> 'onHold' is distinct from 'true'::jsonb then
    v_event := public.activity_record(new.id, 'order.resumed', 'all', format('%s resumed %s', v_actor, new.id));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.hold', new.id, 'order',
      format('Order %s has resumed', new.id), null, 'evt:' || v_event, v_event);
  end if;

  -- Clarification.
  if new.clarification = 'pending' and old.clarification is distinct from 'pending' then
    v_note := left(nullif(btrim(new.workflow ->> 'clarificationNote'), ''), 300);
    v_event := public.activity_record(new.id, 'order.clarification_requested', 'all',
      format('%s requested clarification on %s', v_actor, new.id) || coalesce(' — ' || v_note, ''));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.clarification', new.id, 'order',
      format('Clarification needed on %s', new.id), coalesce(v_note, 'Open the order to reply to Resolute.'),
      'evt:' || v_event, v_event);
  elsif new.clarification = 'responded' and old.clarification = 'pending' then
    v_event := public.activity_record(new.id, 'order.clarification_answered', 'all',
      format('%s responded to the clarification on %s', v_actor, new.id));
    perform public.notify_profiles(public.notify_admin_ids(), 'order.clarification', new.id, 'order',
      format('%s: the client responded to the clarification', new.id), null, 'evt:' || v_event, v_event);
  end if;

  -- Cancellation.
  if new.status = 'cancelled' and old.status <> 'cancelled' then
    if v_req_old is not null then
      v_event := public.activity_record(new.id, 'order.cancel_approved', 'all',
        format('%s approved cancellation of %s', v_actor, new.id));
      perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.cancel', new.id, 'order',
        format('Cancellation of %s approved', new.id), 'The order is cancelled.', 'evt:' || v_event, v_event);
    elsif v_is_client then
      v_event := public.activity_record(new.id, 'order.cancelled', 'all',
        format('%s cancelled %s before screening', v_actor, new.id));
      perform public.notify_profiles(public.notify_admin_ids(), 'order.cancel', new.id, 'order',
        format('%s was cancelled by the client', new.id), 'Cancelled before screening.', 'evt:' || v_event, v_event);
    else
      v_event := public.activity_record(new.id, 'order.cancelled', 'all', format('%s cancelled %s', v_actor, new.id));
      perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.cancel', new.id, 'order',
        format('Order %s was cancelled', new.id), null, 'evt:' || v_event, v_event);
    end if;
  elsif v_req_new is not null and v_req_old is null then
    v_event := public.activity_record(new.id, 'order.cancel_requested', 'all',
      format('%s requested cancellation of %s — awaiting Admin approval', v_actor, new.id));
    perform public.notify_profiles(public.notify_admin_ids(), 'order.cancel', new.id, 'order',
      format('Cancellation requested on %s', new.id), 'The client asked to cancel an order in progress.',
      'evt:' || v_event, v_event);
  elsif v_req_old is not null and v_req_new is null then
    v_event := public.activity_record(new.id, 'order.cancel_declined', 'all',
      format('%s declined cancellation of %s', v_actor, new.id));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.cancel', new.id, 'order',
      format('Cancellation of %s declined', new.id), 'Work continues on your order.', 'evt:' || v_event, v_event);
  end if;

  -- Delivery.
  if new.status = 'delivered' and old.status <> 'delivered' then
    v_event := public.activity_record(new.id, 'order.delivered', 'all',
      format('Order %s delivered%s', new.id,
             case when new.workflow ->> 'deliveryMethod' = 'portal' then ' through the client portal' else '' end));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'order.delivered', new.id, 'order',
      format('Order %s is complete', new.id), 'Your order has been delivered in the portal.', 'evt:' || v_event, v_event);
    perform public.notify_profiles(public.notify_admin_ids(), 'order.delivered', new.id, 'order',
      format('%s delivered', new.id), null, 'evt:' || v_event, v_event);
  end if;

  -- Payment method (the mode of payment; confirming funds is not recorded here).
  if new.payment is distinct from old.payment then
    perform public.activity_record(new.id, 'order.payment_method', 'staff',
      format('%s changed the payment method of %s to %s', v_actor, new.id, coalesce(left(new.payment, 40), 'none')));
  end if;
  return null;
end $fn$;

create or replace function public.order_documents_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_label text := case new.kind
    when 'client' then 'client attachment' when 'screener' then 'search document'
    when 'examiner' then 'researched document' when 'title_search' then 'Title Search Document'
    when 'supplementary' then 'supplementary document' when 'commitment' then 'title commitment'
    when 'check' then 'check scan'
    else 'document' end;
  -- A check scan is billing evidence: the client and Admin, never production (section 12).
  v_audience text := case when new.kind = 'client' then 'all' when new.kind = 'check' then 'billing' else 'staff' end;
  v_meta  jsonb := jsonb_build_object('documentId', new.id, 'documentKind', new.kind, 'filename', new.filename);
  v_owner uuid;
  v_event bigint;
begin
  if old.status = 'uploading' and new.status = 'stored' then
    v_event := public.activity_record(new.order_id, 'document.added', v_audience,
      format('%s added the %s "%s" to %s', public.activity_actor_name(), v_label, new.filename, new.order_id), v_meta);
    if new.kind = 'client' and exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'client') then
      select case when o.assigned_to = 'user' then o.assigned_user_id end into v_owner
        from public.orders o where o.id = new.order_id;
      perform public.notify_profiles(public.notify_admin_ids() || array_remove(array[v_owner], null),
        'document.client', new.order_id, 'order', format('New client document on %s', new.order_id), new.filename,
        'evt:' || v_event, v_event);
    end if;
  elsif old.status = 'deleting' and new.status = 'deleted' then
    perform public.activity_record(new.order_id, 'document.removed', v_audience,
      format('%s removed the %s "%s" from %s', public.activity_actor_name(), v_label, new.filename, new.order_id), v_meta);
  end if;
  return null;
end $fn$;

create or replace function public.support_messages_notify()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_owner   uuid;
  v_target  text := case when new.order_id is null then 'support' else 'messages' end;
  v_excerpt text := left(regexp_replace(new.body, '\s+', ' ', 'g'), 140);
  -- One action, one notification: when this message is part of an order change
  -- in the same transaction (Admin's hold / clarification / confirmation note,
  -- the client's clarification answer), whoever that change already told is
  -- not told again; the message is in their thread.
  v_told    uuid[] := coalesce((select array_agg(n.recipient_id) from public.notifications n
                                 where new.order_id is not null and n.order_id = new.order_id
                                   and n.txid = txid_current() and n.kind like 'order.%'), '{}');
begin
  if new.order_id is not null then
    select case when o.assigned_to = 'user' then o.assigned_user_id end into v_owner
      from public.orders o where o.id = new.order_id;
  end if;
  if new.sender = 'client' then
    perform public.notify_profiles(array(select x from unnest(public.notify_admin_ids() || array_remove(array[v_owner], null)) x
                                          where x <> all (v_told)), 'message.client',
      new.order_id, v_target,
      case when new.order_id is null then format('Support message from client %s', new.client_code)
           else format('Client message on %s', new.order_id) end,
      v_excerpt, 'msg:' || new.id::text, null, new.id);
  elsif new.visibility = 'client' then
    perform public.notify_profiles(array(select x from unnest(public.notify_client_ids(new.client_code)) x where x <> all (v_told)),
      'message.reply', new.order_id, v_target,
      case when new.order_id is null then 'New reply from Resolute Support'
           else format('New message from Resolute on %s', new.order_id) end,
      v_excerpt, 'msg:' || new.id::text, null, new.id);
  else
    perform public.notify_profiles(public.notify_admin_ids() || array_remove(array[v_owner], null), 'message.note',
      new.order_id, v_target, format('Internal note on %s', coalesce(new.order_id, 'client ' || new.client_code)),
      v_excerpt, 'msg:' || new.id::text, null, new.id);
  end if;
  return null;
end $fn$;

-- The structured triggers replace the Supabase-era free-text one.
drop trigger if exists orders_log_created on public.orders;
-- No email on this stack: nothing drains notification_outbox, so the
-- Supabase-era email fan-out would only pile up rows that read as mail about
-- to be sent. Not attached here (Supabase keeps them). When an email sender
-- exists, re-create order_event_notify (after insert on order_events ->
-- notify_on_order_event()) and client_message_notify (after insert on
-- support_messages -> notify_on_client_message()).
drop trigger if exists order_event_notify on public.order_events;
drop trigger if exists client_message_notify on public.support_messages;
drop trigger if exists orders_activity_insert on public.orders;
create trigger orders_activity_insert after insert on public.orders
  for each row execute function public.orders_activity_insert();
drop trigger if exists orders_activity_update on public.orders;
create trigger orders_activity_update after update on public.orders
  for each row execute function public.orders_activity_update();
drop trigger if exists order_documents_activity on public.order_documents;
create trigger order_documents_activity after update of status on public.order_documents
  for each row execute function public.order_documents_activity();
drop trigger if exists support_messages_notify on public.support_messages;
create trigger support_messages_notify after insert on public.support_messages
  for each row execute function public.support_messages_notify();

comment on table public.notifications is
  'In-app notifications, one row per recipient (gcp/02_post_migrate.sql section 11). Written only by the activity '
  'and message triggers; read and marked read only by the recipient.';

do $$
declare f text;
begin
  foreach f in array array[
    'public.guard_support_message()', 'public.order_events_structured()', 'public.activity_actor_name()',
    'public.activity_stage_label(text)', 'public.activity_record(text,text,text,text,jsonb)',
    'public.notify_admin_ids()', 'public.notify_client_ids(text)',
    'public.notify_profiles(uuid[],text,text,text,text,text,text,bigint,uuid)',
    'public.notifications_mark_read(bigint[])', 'public.notifications_mark_all_read()',
    'public.orders_activity_insert()', 'public.orders_activity_update()', 'public.order_documents_activity()',
    'public.support_messages_notify()'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- Called by the support_messages policies, which run as the caller.
revoke all on function public.order_is_my_work(text) from public, anon, authenticated, service_role;
grant execute on function public.order_is_my_work(text) to authenticated;
-- The API's entry points.
grant execute on function public.notifications_mark_read(bigint[]) to authenticated;
grant execute on function public.notifications_mark_all_read() to authenticated;

commit;

-- ── 12. Client payments: the client reports, the billing owner verifies ─────
-- The portal's existing two-step check workflow (CLAUDE.md "Billing & payment
-- logic"; packages/domain money.ts), on this stack. workflow.payment keeps its
-- Supabase-era shape and statuses:
--     { method 'ACH' | 'Check', reference, checkDoc, statementId,
--       status 'unpaid' | 'marked' | 'confirmed' | 'bounced',
--       markedAt, confirmedAt, confirmedBy, bouncedAt, bounceReason }
--   * 'marked' (shown "Marked Paid" -- awaiting verification) is the CLIENT's
--     report: "I have sent it". It is never payment. payment_report() writes it,
--     for the caller's own delivered (invoiced) order only, and for a Check only
--     with the stored scan of a check uploaded to THAT order (document kind
--     'check', section 10) -- a missing, failed, deleted, unrelated or other
--     order's document is not evidence. An identical retry is a no-op; a second,
--     different report while one awaits verification is refused; a confirmed
--     payment is final.
--   * 'confirmed' (shown "Paid") and 'bounced' (rejected) are the billing
--     owner's decision after the money is received (or not): payment_verify(),
--     only for an admin holding can_confirm_payments, only on a report awaiting
--     verification, only against the version of the order the decision was
--     made on (a stale decision is refused, so nothing is confirmed twice or on
--     a report that changed underneath), and a confirmation only with its
--     evidence still stored. guard_payment_confirmation (20260908010000) still
--     runs on that UPDATE.
--   * No other write may change workflow.payment while a user is signed in:
--     orders_guard_payment_writes refuses it unless the transaction holds the
--     owner-only marker these two functions set around their own UPDATE (the
--     section 4 pattern). A whole-workflow save that leaves the payment out
--     keeps the stored one (production never reads it -- the API redacts it).
--     The Supabase-era client_mark_payment() is not callable here.
--   * The trail: payment.reported / payment.confirmed / payment.bounced events
--     (audience 'billing': Admin and the order's client, never production),
--     written by the trigger below from the committed change. Notifications,
--     in-app only: a report -> the billing owner(s); a decision -> the client's
--     users. Neither carries an amount or a reference.
-- Online payment processing does not exist here: the portal is a ledger.
begin;

-- 12.1 Who reads billing events -----------------------------------------------
-- 'billing': the order's client and Admin; never production.
alter table public.order_events drop constraint if exists order_events_audience_check;
alter table public.order_events drop constraint if exists order_events_audience_chk;
alter table public.order_events add constraint order_events_audience_check
  check (audience in ('staff', 'client', 'all', 'billing'));

drop policy if exists order_events_read on public.order_events;
create policy order_events_read on public.order_events for select
  using (public.is_staff() and (audience <> 'billing' or public.is_admin()));
drop policy if exists order_events_client_read on public.order_events;
create policy order_events_client_read on public.order_events for select
  using (
    order_id is not null
    and audience in ('client', 'all', 'billing')
    and exists (select 1 from public.orders o
                 where o.id = order_events.order_id
                   and o.client_code = public.my_client_code())
  );

alter table public.notifications drop constraint if exists notifications_target_check;
alter table public.notifications add constraint notifications_target_check
  check (target in ('order', 'messages', 'support', 'billing'));

-- 12.2 Only the payment functions write workflow.payment --------------------
create table if not exists auth.order_payment_writes (
  txid     bigint not null,
  order_id text   not null,
  primary key (txid, order_id)
);
revoke all on table auth.order_payment_writes from public, anon, authenticated, service_role;

create or replace function public.guard_payment_writes()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_old jsonb := case when tg_op = 'UPDATE' then old.workflow -> 'payment' end;
begin
  if auth.uid() is null
     or (new.workflow -> 'payment') is not distinct from v_old
     or exists (select 1 from auth.order_payment_writes w where w.txid = txid_current() and w.order_id = new.id) then
    return new;
  end if;
  -- A whole-workflow save that leaves the payment out keeps the stored one.
  if v_old is not null and not (coalesce(new.workflow, '{}'::jsonb) ? 'payment') then
    new.workflow := jsonb_set(coalesce(new.workflow, '{}'::jsonb), '{payment}', v_old, true);
    return new;
  end if;
  raise exception 'payments: a payment is reported by the client and verified by the billing owner, through the payment endpoints only'
    using errcode = '42501';
end $fn$;

-- Named to fire after orders_guard_payment_confirmation (triggers run in name
-- order), so a forged confirmation is refused for that reason first.
drop trigger if exists orders_guard_payment_writes on public.orders;
create trigger orders_guard_payment_writes
  before insert or update on public.orders
  for each row execute function public.guard_payment_writes();

-- The marked report, written only by the client's own call.
create or replace function public.payment_report(p_order_id text, p_method text, p_reference text, p_check_document_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_order  public.orders;
  v_doc    public.order_documents;
  v_ref    text := btrim(coalesce(p_reference, ''), E' \t\r\n');
  v_prev   jsonb;
  v_status text;
  v_pay    jsonb;
begin
  if auth.uid() is null then
    raise exception 'payments: an authenticated user is required' using errcode = '42501';
  end if;
  if public.is_staff() or public.my_client_code() is null then
    raise exception 'payments: only the client reports a payment for its invoice' using errcode = '42501';
  end if;
  if p_method is null or p_method not in ('ACH', 'Check') then
    raise exception 'payments: the payment method must be ACH or Check' using errcode = '22023';
  end if;
  if char_length(v_ref) not between 1 and 64 or v_ref ~ '[[:cntrl:]]' then
    raise exception 'payments: the % must be 1 to 64 characters',
      case when p_method = 'ACH' then 'ACH trace / confirmation number' else 'check number' end using errcode = '22023';
  end if;
  select o.* into v_order from public.orders o
   where o.id = p_order_id and o.client_code = public.my_client_code()
     for update;
  if not found then
    raise exception 'payments: order not found' using errcode = 'P0002';
  end if;
  if v_order.status::text <> 'delivered' then
    raise exception 'payments: this order has not been invoiced yet' using errcode = '55000';
  end if;
  if p_method = 'Check' then
    if p_check_document_id is null then
      raise exception 'payments: a check payment needs the scan of the check — upload it first' using errcode = '22023';
    end if;
    select d.* into v_doc from public.order_documents d
     where d.id = p_check_document_id and d.order_id = v_order.id and d.kind = 'check' and d.status = 'stored';
    if not found then
      raise exception 'payments: the check scan is not stored on this order — upload it again' using errcode = '22023';
    end if;
  elsif p_check_document_id is not null then
    raise exception 'payments: an ACH payment has no check scan' using errcode = '22023';
  end if;

  v_prev := case when jsonb_typeof(v_order.workflow -> 'payment') = 'object' then v_order.workflow -> 'payment' end;
  v_status := coalesce(nullif(replace(v_prev ->> 'status', 'submitted', 'marked'), ''), 'unpaid');
  if v_status = 'marked' and v_prev ->> 'method' = p_method and v_prev ->> 'reference' = v_ref
     and (v_prev -> 'checkDoc' ->> 'documentId') is not distinct from p_check_document_id::text then
    return v_prev;                                         -- the same report, retried
  end if;
  if v_status = 'confirmed' then
    raise exception 'payments: this invoice is already paid' using errcode = '55000';
  end if;
  if v_status = 'marked' then
    raise exception 'payments: a payment is already reported for this invoice and is awaiting verification' using errcode = '55000';
  end if;

  v_pay := jsonb_build_object(
    'method', p_method, 'reference', v_ref,
    'checkDoc', case when v_doc.id is null then null else public.document_ref(v_doc) end,
    'statementId', null, 'status', 'marked', 'markedAt', to_char(current_date, 'YYYY-MM-DD'));
  insert into auth.order_payment_writes (txid, order_id) values (txid_current(), v_order.id) on conflict do nothing;
  update public.orders
     set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', v_pay, true)
   where id = v_order.id;
  delete from auth.order_payment_writes where txid = txid_current() and order_id = v_order.id;
  return v_pay;
end $fn$;

-- The billing owner's decision on a report awaiting verification.
create or replace function public.payment_verify(p_order_id text, p_decision text, p_baseline timestamptz, p_reason text default null)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_order  public.orders;
  v_me     public.profiles;
  v_prev   jsonb;
  v_status text;
  v_reason text := nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '');
  v_pay    jsonb;
begin
  if auth.uid() is null then
    raise exception 'payments: an authenticated user is required' using errcode = '42501';
  end if;
  select p.* into v_me from public.profiles p where p.id = auth.uid();
  if not (public.is_admin() and public.can_confirm_payments()) then
    raise exception 'only the billing owner may confirm or bounce a client payment' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('confirmed', 'bounced') then
    raise exception 'payments: the decision must be confirmed or bounced' using errcode = '22023';
  end if;
  if v_reason is not null and (p_decision <> 'bounced' or char_length(v_reason) > 300 or v_reason ~ '[[:cntrl:]]') then
    raise exception 'payments: a reason (up to 300 characters, one line) is given only when a payment bounced' using errcode = '22023';
  end if;
  select o.* into v_order from public.orders o where o.id = p_order_id for update;
  if not found then
    raise exception 'payments: order not found' using errcode = 'P0002';
  end if;
  if p_baseline is null or v_order.updated_at <> p_baseline then
    raise exception 'payments: this invoice changed since you opened it — review it again' using errcode = '40001';
  end if;
  v_prev := case when jsonb_typeof(v_order.workflow -> 'payment') = 'object' then v_order.workflow -> 'payment' end;
  v_status := coalesce(nullif(replace(v_prev ->> 'status', 'submitted', 'marked'), ''), 'unpaid');
  if v_status = 'confirmed' then
    raise exception 'payments: this payment is already confirmed' using errcode = '55000';
  end if;
  if v_status <> 'marked' or v_order.status::text <> 'delivered' then
    raise exception 'payments: there is no reported payment awaiting verification on this invoice' using errcode = '55000';
  end if;
  -- Confirming needs the report's evidence, still on file.
  if p_decision = 'confirmed' then
    if v_prev ->> 'method' not in ('ACH', 'Check') or char_length(btrim(coalesce(v_prev ->> 'reference', ''))) = 0 then
      raise exception 'payments: the report has no method and reference — it cannot be confirmed' using errcode = '55000';
    end if;
    if v_prev ->> 'method' = 'Check' and not exists (
         select 1 from public.order_documents d
          where d.id::text = v_prev -> 'checkDoc' ->> 'documentId' and d.order_id = v_order.id
            and d.kind = 'check' and d.status = 'stored') then
      raise exception 'payments: the check scan for this report is not on file — it cannot be confirmed' using errcode = '55000';
    end if;
  end if;

  v_pay := v_prev || jsonb_build_object('status', p_decision, 'confirmedBy', v_me.name)
         || case when p_decision = 'confirmed'
                 then jsonb_build_object('confirmedAt', to_char(current_date, 'YYYY-MM-DD'))
                 else jsonb_build_object('bouncedAt', to_char(current_date, 'YYYY-MM-DD'), 'bounceReason', v_reason) end;
  insert into auth.order_payment_writes (txid, order_id) values (txid_current(), v_order.id) on conflict do nothing;
  update public.orders
     set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', v_pay, true)
   where id = v_order.id;
  delete from auth.order_payment_writes where txid = txid_current() and order_id = v_order.id;
  return v_pay;
end $fn$;

-- 12.3 The trail and the notifications ----------------------------------------
create or replace function public.notify_billing_ids()
returns uuid[]
language sql
stable
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
  select coalesce(array_agg(p.id), '{}') from public.profiles p
   where p.role = 'admin' and p.status = 'active' and p.can_confirm_payments
$fn$;

create or replace function public.orders_payment_activity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare
  v_old    jsonb := case when jsonb_typeof(old.workflow -> 'payment') = 'object' then old.workflow -> 'payment' end;
  v_new    jsonb := case when jsonb_typeof(new.workflow -> 'payment') = 'object' then new.workflow -> 'payment' end;
  v_was    text := coalesce(nullif(replace(v_old ->> 'status', 'submitted', 'marked'), ''), 'unpaid');
  v_is     text := coalesce(nullif(replace(v_new ->> 'status', 'submitted', 'marked'), ''), 'unpaid');
  v_method text := coalesce(nullif(v_new ->> 'method', ''), 'payment');
  v_inv    text := 'INV-' || new.id;
  v_actor  text := public.activity_actor_name();
  v_reason text;
  v_event  bigint;
begin
  if v_is = 'marked' and (v_was <> 'marked' or v_old is distinct from v_new) then
    v_event := public.activity_record(new.id, 'payment.reported', 'billing',
      format('%s reported %s %s payment for %s — awaiting verification', v_actor,
             case when v_method = 'ACH' then 'an' else 'a' end, v_method, v_inv),
      jsonb_build_object('method', v_new ->> 'method', 'checkDocumentId', v_new -> 'checkDoc' ->> 'documentId'));
    perform public.notify_profiles(public.notify_billing_ids(), 'payment.reported', new.id, 'billing',
      format('Payment reported on %s', v_inv), format('%s payment — awaiting your verification', v_method),
      'evt:' || v_event, v_event);
  elsif v_is = 'confirmed' and v_was <> 'confirmed' then
    v_event := public.activity_record(new.id, 'payment.confirmed', 'billing',
      format('%s confirmed the %s payment for %s', v_actor, v_method, v_inv),
      jsonb_build_object('method', v_new ->> 'method'));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'payment.confirmed', new.id, 'billing',
      format('Payment confirmed for %s', v_inv), 'Resolute received your payment. The invoice is paid.',
      'evt:' || v_event, v_event);
  elsif v_is = 'bounced' and v_was <> 'bounced' then
    v_reason := left(nullif(btrim(v_new ->> 'bounceReason'), ''), 300);
    v_event := public.activity_record(new.id, 'payment.bounced', 'billing',
      format('%s rejected the %s payment for %s (bounced)', v_actor, v_method, v_inv) || coalesce(' — ' || v_reason, ''),
      jsonb_build_object('method', v_new ->> 'method'));
    perform public.notify_profiles(public.notify_client_ids(new.client_code), 'payment.bounced', new.id, 'billing',
      format('Payment for %s was not received', v_inv),
      coalesce(v_reason, 'Resolute could not confirm this payment. Report it again once it is resent.'),
      'evt:' || v_event, v_event);
  end if;
  return null;
end $fn$;

drop trigger if exists orders_payment_activity on public.orders;
create trigger orders_payment_activity after update of workflow on public.orders
  for each row when ((old.workflow -> 'payment') is distinct from (new.workflow -> 'payment'))
  execute function public.orders_payment_activity();

do $$
declare f text;
begin
  foreach f in array array[
    'public.guard_payment_writes()', 'public.payment_report(text,text,text,uuid)',
    'public.payment_verify(text,text,timestamptz,text)', 'public.notify_billing_ids()',
    'public.orders_payment_activity()', 'public.client_mark_payment(text,jsonb)'] loop
    execute format('revoke all on function %s from public, anon, authenticated, service_role', f);
  end loop;
end $$;
-- The API's entry points.
grant execute on function public.payment_report(text, text, text, uuid) to authenticated;
grant execute on function public.payment_verify(text, text, timestamptz, text) to authenticated;

commit;

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

-- ── 14. Company information and client contacts ──────────────────────────
-- The migrations' isolation stays (client_contacts / client_profiles: a client
-- its own company's rows, Admin every company's, production nothing -- keyed on
-- is_admin(), never is_staff()). On this stack, additionally:
--   * client_directory (codes, terms, activity) is read by Admin and by a client
--     for its own code only: production users no longer list every client.
--   * Contacts are never deleted: "remove" archives one (archived_at), so the
--     id an order's intake.placedBy snapshot names still resolves. An archived
--     contact is final. Its company, author and creation never change; the
--     author is set here from the caller's own profile, never from the request.
--     Text is trimmed and bounded, emails and phone numbers checked; the
--     company must exist.
--   * Company profiles: the same bounds; website and logo must be http(s) URLs;
--     who saved it and when are set here.
--   * Application roles may insert and update only the fields a person edits,
--     and delete nothing. Orders keep the snapshot taken when they were placed:
--     editing or archiving a contact never rewrites an order.
begin;

create or replace view public.client_directory as
  select code, payment_terms, activity, registered
    from public.clients c
   where public.is_admin() or code = public.my_client_code();

alter table public.client_contacts add column if not exists archived_at timestamptz;
create index if not exists client_contacts_live_idx on public.client_contacts (client_code, name) where archived_at is null;

revoke all on table public.client_contacts from public, anon, authenticated, service_role;
grant select on table public.client_contacts to authenticated;
grant insert (client_code, name, email, phone, title, marketing_opt_in) on table public.client_contacts to authenticated;
grant update (name, email, phone, title, marketing_opt_in, archived_at) on table public.client_contacts to authenticated;

revoke all on table public.client_profiles from public, anon, authenticated, service_role;
grant select on table public.client_profiles to authenticated;
grant insert (client_code, address, city, state, zip, phone, website, logo_url) on table public.client_profiles to authenticated;
grant update (address, city, state, zip, phone, website, logo_url) on table public.client_profiles to authenticated;

-- Bounded, single-line text: NULL when empty.
create or replace function public.contact_text(p_value text, p_max integer, p_what text)
returns text
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $fn$
declare v text := nullif(btrim(p_value), '');
begin
  if v is not null and (char_length(v) > p_max or v ~ '[[:cntrl:]]') then
    raise exception 'contacts: % must be up to % characters on one line', p_what, p_max using errcode = '22023';
  end if;
  return v;
end $fn$;

create or replace function public.guard_client_contact()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare v_me public.profiles;
begin
  if tg_op = 'UPDATE' then
    if old.archived_at is not null then
      raise exception 'contacts: this contact was removed' using errcode = '55000';
    end if;
    if new.id is distinct from old.id or new.client_code is distinct from old.client_code
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'contacts: a contact''s company and author do not change' using errcode = '42501';
    end if;
  end if;
  new.name := public.contact_text(new.name, 200, 'the name');
  if new.name is null then
    raise exception 'contacts: a name is required' using errcode = '22023';
  end if;
  new.email := lower(public.contact_text(new.email, 254, 'the email'));
  if new.email is not null and new.email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'contacts: the email is not valid' using errcode = '22023';
  end if;
  new.phone := public.contact_text(new.phone, 40, 'the phone number');
  if new.phone is not null and new.phone !~ '^[0-9+(). /-]+( *(x|ext\.?) *[0-9]{1,6})?$' then
    raise exception 'contacts: the phone number is not valid' using errcode = '22023';
  end if;
  new.title := public.contact_text(new.title, 120, 'the title');
  new.marketing_opt_in := coalesce(new.marketing_opt_in, false);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    if not exists (select 1 from public.clients c where c.code = new.client_code) then
      raise exception 'contacts: unknown client' using errcode = '22023';
    end if;
    select p.* into v_me from public.profiles p where p.id = auth.uid();
    new.created_by := case when v_me.role = 'client' then 'client' else coalesce(nullif(v_me.name, ''), 'Admin') end;
    new.created_at := now();
    new.archived_at := null;
  elsif new.archived_at is not null then
    new.archived_at := now();                                -- removal: the time is the server's
  end if;
  return new;
end $fn$;

drop trigger if exists client_contacts_guard on public.client_contacts;
create trigger client_contacts_guard before insert or update on public.client_contacts
  for each row execute function public.guard_client_contact();

create or replace function public.guard_client_profile()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $fn$
declare v_me public.profiles;
begin
  if tg_op = 'UPDATE' and new.client_code is distinct from old.client_code then
    raise exception 'company: a profile belongs to its company' using errcode = '42501';
  end if;
  new.address := public.contact_text(new.address, 200, 'the address');
  new.city := public.contact_text(new.city, 100, 'the city');
  new.state := upper(public.contact_text(new.state, 2, 'the state'));
  if new.state is not null and new.state !~ '^[A-Z]{2}$' then
    raise exception 'company: the state must be a two-letter code' using errcode = '22023';
  end if;
  new.zip := public.contact_text(new.zip, 10, 'the ZIP code');
  if new.zip is not null and new.zip !~ '^[0-9]{5}(-[0-9]{4})?$' then
    raise exception 'company: the ZIP code is not valid' using errcode = '22023';
  end if;
  new.phone := public.contact_text(new.phone, 40, 'the phone number');
  if new.phone is not null and new.phone !~ '^[0-9+(). /-]+( *(x|ext\.?) *[0-9]{1,6})?$' then
    raise exception 'company: the phone number is not valid' using errcode = '22023';
  end if;
  new.website := public.contact_text(new.website, 500, 'the website');
  new.logo_url := public.contact_text(new.logo_url, 500, 'the logo URL');
  if (new.website is not null and new.website !~* '^https?://[^[:space:]<>"]+$')
     or (new.logo_url is not null and new.logo_url !~* '^https?://[^[:space:]<>"]+$') then
    raise exception 'company: the website and logo must be http(s) addresses' using errcode = '22023';
  end if;
  select p.* into v_me from public.profiles p where p.id = auth.uid();
  new.updated_by := coalesce(nullif(v_me.name, ''), case when v_me.role = 'client' then 'Client' else 'Admin' end);
  new.updated_at := now();
  return new;
end $fn$;

drop trigger if exists client_profiles_guard on public.client_profiles;
create trigger client_profiles_guard before insert or update on public.client_profiles
  for each row execute function public.guard_client_profile();

revoke all on function public.contact_text(text, integer, text) from public, anon, authenticated, service_role;
revoke all on function public.guard_client_contact() from public, anon, authenticated, service_role;
revoke all on function public.guard_client_profile() from public, anon, authenticated, service_role;

commit;
