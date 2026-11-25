-- =====================================================================
-- GCP account administration -- PostgreSQL authorization tests
-- DISPOSABLE TEST DATABASES ONLY
-- =====================================================================
-- Real SECURITY DEFINER functions (gcp/test/account_functions.sql), real RLS,
-- called through the restricted app login inside `set local role
-- authenticated` + request.jwt.claims transactions -- exactly how
-- services/api calls them. No mocks.
--
-- Everything up to the R1 block is extracted VERBATIM from the reference
-- security suite (integration-reference/gcp-live/gcp/test_security.sql @
-- 9d167690) -- only the account-management series and the fixtures they use;
-- each extract's sha256 is recorded. R1 at the end is added here (not in the
-- reference) to state outright what adminUsers.integration.mjs used to:
-- refused writes leave the stored row unchanged, demotion clears super admin
-- and billing, unknown ids are refused by every entry point.
--
-- Extracts, in run order (file, lines, what):
--   test_security.sql      27-38   psql settings; refuses without -v disposable_test_db=1 and -v app_user
--                        sha256 cd92042ab4a2e1ab16550c531cbde90b6e820fdfe9bb900b46c68d64402b4e3f
--   test_security.sql      40-45   must start as the bootstrap admin (operator)
--                        sha256 5a0fc94b06147ac8a8c0bfcedbdae8c7fc3d366575c119dfacac7222decdc0c0
--   test_security.sql      49-82   fixtures: ZT clients, client/admin/billing identities, ZT-1/ZT-2, provisioning callers
--                        sha256 bc01894d0046f7d3d2529eba5dc3bbda4f5208297e60b24bfddab809bc610144
--   test_security.sql     102-117  zt_expect_error helper (asserts SQLSTATE + message)
--                        sha256 4005b87fe522c0dd545d0f4bbb6a621b0d5f0c5e25b71eaa60d8b022c0f4ccee
--   test_security.sql     127-145  orphan mapping (A1), P9 failure trigger, operator name
--                        sha256 faecbdef8c1f7ff4f7d45932425b11a3777dc1617b584f70344f32e771bbfa05
--   test_security.sql     147-158  O2-O4 operator: NULL auth.uid(), maintenance semantics, resolver
--                        sha256 9655952ad3b72327a575bbfb6d83b9a6d4c28bc40f1b4894295b10912cde689b
--   test_security.sql    1881-1893 U-series fixtures (as operator)
--                        sha256 58485a09f181fa9e9980ebd958980b5dbae0b094d622bafaa6faebf05100afa2
--   test_security.sql     212-309  L0-L3 restricted app login: fail-closed claims, no SET ROLE/elevation, resolver boundaries
--                        sha256 81b0c1211351393576b4a080f1344f926ffee3d3f0944c39742f1699c10b0467
--   test_security.sql     649-787  A1-A3 profile write paths and role helpers
--                        sha256 6ba90b589cbc6d40837383753e7cf56055d9892bebad91aa17c2e3a834737b5a
--   test_security.sql     789-1309 P1-P14 provisioning and activation
--                        sha256 80e1ed9f97bc9c6205d14899146d1f9a0aa6e2d710c9a57e207929dab4fe45fc
--   test_security.sql    2128-2275 U1-U2 account edits, deactivate / reactivate
--                        sha256 2973057bad91df4a3a633381a8344daeb46a17c82032f287a5a3aa289076fa27
--
-- Run by gcp/test/run.sh:
--   psql -v ON_ERROR_STOP=1 -v disposable_test_db=1 -v app_user=<test login> \
--        -U <schema owner> -d <disposable db> -f gcp/test/account_security.sql
-- Every check raises 'FAIL ...'; the first failure ends the run nonzero.
-- =====================================================================
-- ┌── EXTRACT psql settings; refuses without -v disposable_test_db=1 and -v app_user
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 27-38 @ 9d167690, verbatim; sha256 cd92042ab4a2e1ab16550c531cbde90b6e820fdfe9bb900b46c68d64402b4e3f
-- └──────────────────────────────────────────────────────────────────────────
\set ON_ERROR_STOP 1
\set QUIET 1
\pset tuples_only on
\if :{?disposable_test_db}
\else
  \echo 'test_security.sql writes fixture rows: run it only against a disposable test database (-v disposable_test_db=1)'
  do $$ begin raise exception 'refusing to run without -v disposable_test_db=1'; end $$;
\endif
\if :{?app_user}
\else
  do $$ begin raise exception 'pass the app login name: -v app_user=<login>'; end $$;
\endif

-- ┌── EXTRACT must start as the bootstrap admin (operator)
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 40-45 @ 9d167690, verbatim; sha256 5a0fc94b06147ac8a8c0bfcedbdae8c7fc3d366575c119dfacac7222decdc0c0
-- └──────────────────────────────────────────────────────────────────────────
-- ── Operator (bootstrap admin) session ─────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolcreaterole)) then
    raise exception 'FAIL setup: run this as the bootstrap admin, not %', session_user;
  end if;
end $$;

-- ┌── EXTRACT fixtures: ZT clients, client/admin/billing identities, ZT-1/ZT-2, provisioning callers
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 49-82 @ 9d167690, verbatim; sha256 bc01894d0046f7d3d2529eba5dc3bbda4f5208297e60b24bfddab809bc610144
-- └──────────────────────────────────────────────────────────────────────────
insert into public.clients (code, name) values
  ('ZT01', 'ZT Test Client One'), ('ZT02', 'ZT Test Client Two')
on conflict (code) do nothing;
insert into auth.users (id, firebase_uid, email) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'zt-fb-client-a', 'zt-a@example.test'),
  ('b2b2b2b2-0000-4000-8000-000000000002', 'zt-fb-client-b', 'zt-b@example.test'),
  ('c3c3c3c3-0000-4000-8000-000000000003', 'zt-fb-admin',    'zt-s@example.test'),
  ('d4d4d4d4-0000-4000-8000-000000000004', 'zt-fb-billing',  'zt-d@example.test')
on conflict do nothing;
insert into public.profiles (id, name, email, role, client_code, super_admin, can_confirm_payments) values
  ('a1a1a1a1-0000-4000-8000-000000000001', 'ZT Client A',  'zt-a@example.test', 'client', 'ZT01', false, false),
  ('b2b2b2b2-0000-4000-8000-000000000002', 'ZT Client B',  'zt-b@example.test', 'client', 'ZT02', false, false),
  ('c3c3c3c3-0000-4000-8000-000000000003', 'ZT Admin',     'zt-s@example.test', 'admin',  null,   false, false),
  ('d4d4d4d4-0000-4000-8000-000000000004', 'ZT Billing',   'zt-d@example.test', 'admin',  null,   true,  true)
on conflict (id) do nothing;
insert into public.orders (id, client_code, state, county, type) values
  ('ZT-1', 'ZT01', 'TX', 'Harris', 'Full Search'),
  ('ZT-2', 'ZT02', 'TX', 'Harris', 'Full Search')
on conflict (id) do nothing;

-- Provisioning (P-series) callers: a super admin WITHOUT billing, a production
-- user and an inactive super admin. Accounts a previous run provisioned are
-- removed (the mapping's delete cascades to the profile) so the suite re-runs.
insert into auth.users (id, firebase_uid, email) values
  ('15151515-0000-4000-8000-000000000015', 'zt-fb-super',     'zt-u@example.test'),
  ('16161616-0000-4000-8000-000000000016', 'zt-fb-user',      'zt-p@example.test'),
  ('17171717-0000-4000-8000-000000000017', 'zt-fb-admin-off', 'zt-o@example.test')
on conflict do nothing;
insert into public.profiles (id, name, email, role, client_code, super_admin, can_confirm_payments, status) values
  ('15151515-0000-4000-8000-000000000015', 'ZT Super', 'zt-u@example.test', 'admin', null, true,  false, 'active'),
  ('16161616-0000-4000-8000-000000000016', 'ZT User',  'zt-p@example.test', 'user',  null, false, false, 'active'),
  ('17171717-0000-4000-8000-000000000017', 'ZT Off',   'zt-o@example.test', 'admin', null, true,  true,  'inactive')
on conflict (id) do nothing;
delete from auth.users where firebase_uid like 'zt-prov-%';

-- ┌── EXTRACT zt_expect_error helper (asserts SQLSTATE + message)
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 102-117 @ 9d167690, verbatim; sha256 4005b87fe522c0dd545d0f4bbb6a621b0d5f0c5e25b71eaa60d8b022c0f4ccee
-- └──────────────────────────────────────────────────────────────────────────
create or replace function public.zt_expect_error(p_sql text, p_state text, p_like text default '%') returns void
language plpgsql as $fn$
declare st text; msg text;
begin
  begin
    execute p_sql;
  exception when others then st := sqlstate; msg := sqlerrm;
  end;
  if st is null then
    raise exception 'FAIL: ran without error: %', p_sql;
  end if;
  if st <> p_state or msg not like p_like then
    raise exception 'FAIL: % -> % % (expected % %)', p_sql, st, msg, p_state, p_like;
  end if;
end $fn$;
grant execute on function public.zt_expect_error(text, text, text) to authenticated;

-- ┌── EXTRACT orphan mapping (A1), P9 failure trigger, operator name
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 127-145 @ 9d167690, verbatim; sha256 faecbdef8c1f7ff4f7d45932425b11a3777dc1617b584f70344f32e771bbfa05
-- └──────────────────────────────────────────────────────────────────────────
-- A mapping with no profile: the target that would make a direct INSERT of a
-- profile otherwise valid (A1, O9).
insert into auth.users (id, firebase_uid, email) values
  ('18181818-0000-4000-8000-000000000018', 'zt-fb-orphan', 'zt-orphan@example.test')
on conflict do nothing;

-- P9 needs a profile insert that fails AFTER the mapping insert succeeded: a
-- test-only trigger scoped to one synthetic email, dropped again in O8.
create or replace function public.zt_fail_profile_insert() returns trigger language plpgsql as $$
begin
  if new.email = 'zt-prov-fail@example.test' then
    raise exception 'zt: simulated profile insert failure' using errcode = 'ZT998';
  end if;
  return new;
end $$;
drop trigger if exists zt_fail_profile_insert on public.profiles;
create trigger zt_fail_profile_insert before insert on public.profiles
  for each row execute function public.zt_fail_profile_insert();
select session_user as zt_operator \gset

-- ┌── EXTRACT O2-O4 operator: NULL auth.uid(), maintenance semantics, resolver
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 147-158 @ 9d167690, verbatim; sha256 9655952ad3b72327a575bbfb6d83b9a6d4c28bc40f1b4894295b10912cde689b
-- └──────────────────────────────────────────────────────────────────────────
do $$ begin
  if auth.uid() is not null then
    raise exception 'FAIL O2: operator session has an identity without claims';
  end if;
  if not public.can_confirm_payments() then
    raise exception 'FAIL O3: operator session lost its maintenance semantics';
  end if;
  if (select count(*) from auth.resolve_app_user('zt-fb-billing')) <> 1 then
    raise exception 'FAIL O4: resolver does not work for its owner';
  end if;
end $$;
\echo 'ok  O2-O4 operator: NULL auth.uid() without claims, maintenance semantics kept, resolver works'

-- ┌── EXTRACT U-series fixtures (as operator)
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 1881-1893 @ 9d167690, verbatim; sha256 58485a09f181fa9e9980ebd958980b5dbae0b094d622bafaa6faebf05100afa2
-- └──────────────────────────────────────────────────────────────────────────
-- U-series fixtures (account administration, 02 section 13): an active client,
-- production user and plain admin, and a pending client, each with its mapping.
delete from auth.users where firebase_uid like 'zt-fb-edit-%';
insert into auth.users (id, firebase_uid, email) values
  ('19191919-0000-4000-8000-000000000019', 'zt-fb-edit-client',  'zt-edit-client@example.test'),
  ('20202020-0000-4000-8000-000000000020', 'zt-fb-edit-user',    'zt-edit-user@example.test'),
  ('21212121-0000-4000-8000-000000000021', 'zt-fb-edit-admin',   'zt-edit-admin@example.test'),
  ('22222222-0000-4000-8000-000000000022', 'zt-fb-edit-pending', 'zt-edit-pending@example.test');
insert into public.profiles (id, name, email, role, client_code, super_admin, can_confirm_payments, status) values
  ('19191919-0000-4000-8000-000000000019', 'ZT Edit Client',  'zt-edit-client@example.test',  'client', 'ZT01', false, false, 'active'),
  ('20202020-0000-4000-8000-000000000020', 'ZT Edit User',    'zt-edit-user@example.test',    'user',   null,   false, false, 'active'),
  ('21212121-0000-4000-8000-000000000021', 'ZT Edit Admin',   'zt-edit-admin@example.test',   'admin',  null,   false, false, 'active'),
  ('22222222-0000-4000-8000-000000000022', 'ZT Edit Pending', 'zt-edit-pending@example.test', 'client', 'ZT02', false, false, 'pending');

-- ┌── EXTRACT L0-L3 restricted app login: fail-closed claims, no SET ROLE/elevation, resolver boundaries
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 212-309 @ 9d167690, verbatim; sha256 81b0c1211351393576b4a080f1344f926ffee3d3f0944c39742f1699c10b0467
-- └──────────────────────────────────────────────────────────────────────────
-- ── Restricted app login session ───────────────────────────────────────────
\connect - :app_user
\pset tuples_only on

-- L0 must run first: a fresh connection that has never carried claims.
do $$ begin
  if exists (select 1 from pg_roles where rolname = session_user
              and (rolsuper or rolcreaterole or rolbypassrls or rolinherit)) then
    raise exception 'FAIL setup: % is not the restricted app login', session_user;
  end if;
  if pg_catalog.current_setting('request.jwt.claims', true) is not null then
    raise exception 'FAIL setup: claims already set on a fresh connection';
  end if;
  set local role authenticated;
  begin
    perform auth.uid();
  exception when insufficient_privilege then
    if sqlerrm like 'auth.uid(): no authenticated identity%' then return; end if;
    raise;
  end;
  raise exception 'FAIL L0: fresh app connection without claims got an identity';
end $$;
\echo 'ok  L0 fresh connection, no claims: auth.uid() fails closed'

-- L1: no role switching, no self-elevation, no object creation, no UID reads.
do $$
declare
  owner text := (select pg_get_userbyid(relowner) from pg_class where oid = 'public.profiles'::regclass);
  stmt  text;
begin
  foreach stmt in array array[
    'set local role service_role',
    format('set local role %I', owner),
    format('grant service_role to %I', session_user),
    format('grant %I to %I', owner, session_user),
    format('alter role %I createrole', session_user),
    format('alter role %I bypassrls', session_user),
    'create role zt_probe',
    'create table public.zt_probe (x int)',
    'create table auth.zt_probe (x int)',
    'select 1 from auth.users limit 1',
    'select 1 from public.profiles limit 1'
  ] loop
    begin
      execute stmt;
      raise exception 'FAIL L1: app login was allowed: %', stmt;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
\echo 'ok  L1 app login: no SET ROLE service_role/owner, no self-grant/ALTER ROLE, no CREATE, no direct reads'

-- L2: resolver -- exact match, only the right identity, nothing for near misses.
do $$
declare r record; probe text;
begin
  if (select count(*) from auth.resolve_app_user('zt-fb-client-a')) <> 1 then
    raise exception 'FAIL L2: client A does not resolve to exactly one row';
  end if;
  select * into r from auth.resolve_app_user('zt-fb-client-a');
  if r.id <> 'a1a1a1a1-0000-4000-8000-000000000001' or r.role <> 'client' or r.status <> 'active' then
    raise exception 'FAIL L2: client A resolved to %', row_to_json(r);
  end if;
  select * into r from auth.resolve_app_user('zt-fb-billing');
  if r.id <> 'd4d4d4d4-0000-4000-8000-000000000004' or r.role <> 'admin' then
    raise exception 'FAIL L2: billing owner resolved to %', row_to_json(r);
  end if;
  foreach probe in array array['zt-fb-unknown', 'ZT-FB-CLIENT-A', 'zt-fb-client-a ', ' zt-fb-client-a',
                               'zt-fb-%', '%', '_t-fb-client-a', ''] loop
    if exists (select 1 from auth.resolve_app_user(probe)) then
      raise exception 'FAIL L2: % resolved to an identity', quote_literal(probe);
    end if;
  end loop;
  if exists (select 1 from auth.resolve_app_user(null)) then
    raise exception 'FAIL L2: NULL resolved to an identity';
  end if;
end $$;
\echo 'ok  L2 resolver: exact uid -> (id, role, status); unknown / case / space / wildcard / empty / NULL -> nothing'

-- L3: after switching to authenticated or anon -- even with valid claims --
-- neither the resolver nor auth.users is reachable.
do $$
declare rl text; stmt text;
begin
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  foreach rl in array array['authenticated', 'anon'] loop
    foreach stmt in array array['select * from auth.resolve_app_user(''zt-fb-client-b'')',
                                'select firebase_uid, email from auth.users'] loop
      begin
        execute format('set local role %I', rl);
        execute stmt;
        raise exception 'FAIL L3: % could run: %', rl, stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;
end $$;
\echo 'ok  L3 authenticated / anon: resolver and auth.users denied, even with valid claims'

-- ┌── EXTRACT A1-A3 profile write paths and role helpers
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 649-787 @ 9d167690, verbatim; sha256 6ba90b589cbc6d40837383753e7cf56055d9892bebad91aa17c2e3a834737b5a
-- └──────────────────────────────────────────────────────────────────────────
-- ── Profile write paths (02_post_migrate.sql sections 8-9) ──────────────────
-- A1: no caller -- client, production user, admin, the billing super admin,
--     an inactive super admin, a client with a forged service_role claim, or
--     anon -- can create, delete, replace or truncate a profile, rewrite an
--     identity or privilege column (own row or another's), truncate any public
--     table or attach a trigger. Every attempt is refused outright, and
--     nothing changes.
do $$
declare
  c record; stmt text; st text; msg text; before text;
  own uuid; other uuid;
  orphan constant uuid := '18181818-0000-4000-8000-000000000018';
  snap constant text := $q$select md5(string_agg(row_to_json(p)::text, '|' order by p.id)) || ':' || (select count(*) from public.orders)
                            from public.profiles p$q$;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  execute snap into before;
  for c in select * from (values
      ('client',                 'a1a1a1a1-0000-4000-8000-000000000001'::uuid, 'b2b2b2b2-0000-4000-8000-000000000002'::uuid, false, 'authenticated'),
      ('production user',        '16161616-0000-4000-8000-000000000016', 'a1a1a1a1-0000-4000-8000-000000000001', false, 'authenticated'),
      ('admin',                  'c3c3c3c3-0000-4000-8000-000000000003', 'b2b2b2b2-0000-4000-8000-000000000002', false, 'authenticated'),
      ('billing super admin',    'd4d4d4d4-0000-4000-8000-000000000004', 'c3c3c3c3-0000-4000-8000-000000000003', false, 'authenticated'),
      ('inactive super admin',   '17171717-0000-4000-8000-000000000017', 'a1a1a1a1-0000-4000-8000-000000000001', false, 'authenticated'),
      ('client, forged claims',  'a1a1a1a1-0000-4000-8000-000000000001', 'c3c3c3c3-0000-4000-8000-000000000003', true,  'authenticated'),
      ('anon',                   'a1a1a1a1-0000-4000-8000-000000000001', 'b2b2b2b2-0000-4000-8000-000000000002', false, 'anon')
    ) v(label, me, other, forged, rl) loop
    execute format('set local role %I', c.rl);
    perform set_config('request.jwt.claims',
      case when c.forged then json_build_object('sub', c.me, 'role', 'service_role', 'super_admin', true, 'superAdmin', true)::text
           else json_build_object('sub', c.me)::text end, true);
    perform set_config('request.jwt.claim.role', case when c.forged then 'service_role' else '' end, true);
    own := c.me; other := c.other;
    foreach stmt in array array[
      $s$insert into public.profiles (id, name, email, role, super_admin, can_confirm_payments, status) values (%3$L, 'x', 'zt-orphan@example.test', 'admin', true, true, 'active')$s$,
      $s$insert into public.profiles (id, name, email, role) values (%1$L, 'x', 'x@example.test', 'client') on conflict (id) do update set role = 'admin', super_admin = true, can_confirm_payments = true, status = 'active'$s$,
      $s$insert into public.profiles (id, name, email, role) values (%2$L, 'x', 'x@example.test', 'client') on conflict (id) do update set role = 'admin', super_admin = true, can_confirm_payments = true, status = 'active'$s$,
      $s$delete from public.profiles where id = %1$L$s$,
      $s$delete from public.profiles where id = %2$L$s$,
      $s$with d as (delete from public.profiles where id = %1$L returning id, name, email, created_at) insert into public.profiles (id, name, email, role, super_admin, can_confirm_payments, status, created_at) select id, name, email, 'admin', true, true, 'active', created_at from d$s$,
      $s$with d as (delete from public.profiles where id = %2$L returning id, name, email, created_at) insert into public.profiles (id, name, email, role, super_admin, can_confirm_payments, status, created_at) select id, name, email, 'admin', true, true, 'active', created_at from d$s$,
      $s$truncate public.profiles$s$,
      $s$truncate public.orders cascade$s$,
      $s$create trigger zt_probe before update on public.profiles for each row execute function public.touch_updated_at()$s$,
      $s$update public.profiles set role = 'admin', super_admin = true, can_confirm_payments = true where id = %1$L$s$,
      $s$update public.profiles set role = 'admin', super_admin = true, can_confirm_payments = true where id = %2$L$s$,
      $s$update public.profiles set status = 'active' where id = %1$L$s$,
      $s$update public.profiles set permissions = '[{"capability":"payments.confirm","effect":"grant"}]' where id = %1$L$s$,
      $s$update public.profiles set client_code = 'ZT02' where id = %1$L$s$,
      $s$update public.profiles set id = %3$L where id = %1$L$s$,
      $s$update public.profiles set id = %3$L where id = %2$L$s$,
      $s$update public.profiles set email = 'zt-taken-over@example.test' where id = %1$L$s$,
      $s$update public.profiles set email = 'zt-taken-over@example.test' where id = %2$L$s$,
      $s$update public.profiles set created_at = now() where id = %1$L$s$] loop
      st := null; msg := null;
      begin
        execute format(stmt, own, other, orphan);
      exception when others then st := sqlstate; msg := sqlerrm;
      end;
      if st is distinct from '42501' then
        raise exception 'FAIL A1: % was not refused (% %): %', c.label, st, msg, format(stmt, own, other, orphan);
      end if;
    end loop;
    -- TRUNCATE ignores RLS: refused outright on every public table (a granted
    -- privilege would show as success, or as a foreign-key refusal instead)
    foreach stmt in array array(select format('truncate %s', x.oid::regclass)
                                  from pg_class x join pg_namespace n on n.oid = x.relnamespace
                                 where n.nspname = 'public' and x.relkind in ('r', 'p')) loop
      st := null; msg := null;
      begin
        execute stmt;
      exception when others then st := sqlstate; msg := sqlerrm;
      end;
      if st is distinct from '42501' then
        raise exception 'FAIL A1: % was not refused (% %): %', c.label, st, msg, stmt;
      end if;
    end loop;
  end loop;
  set local role authenticated;
  perform set_config('request.jwt.claim.role', '', true);
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  execute snap into msg;
  if msg is distinct from before then
    raise exception 'FAIL A1: profiles or orders changed';
  end if;
end $$;
\echo 'ok  A1 no direct INSERT / UPSERT / DELETE / DELETE+INSERT / TRUNCATE / CREATE TRIGGER, no identity or privilege column update -- own row or another, any caller, forged claims, anon'

-- A2: the legitimate edit still works: an account renames itself, an admin
--     renames another account (positive controls, rolled back).
do $$
declare who record; n int;
begin
  set local role authenticated;
  for who in select * from (values
      ('a1a1a1a1-0000-4000-8000-000000000001'::uuid, 'a1a1a1a1-0000-4000-8000-000000000001'::uuid),
      ('c3c3c3c3-0000-4000-8000-000000000003', 'b2b2b2b2-0000-4000-8000-000000000002')) v(caller, target) loop
    perform set_config('request.jwt.claims', json_build_object('sub', who.caller)::text, true);
    n := null;
    begin
      update public.profiles set name = 'ZT renamed' where id = who.target;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZT999';
    exception when sqlstate 'ZT999' then null;
    end;
    if n is distinct from 1 then
      raise exception 'FAIL A2: % could not rename %', who.caller, who.target;
    end if;
  end loop;
end $$;
\echo 'ok  A2 name edits still work: own name, and an admin renaming another account'

-- A3: the role helpers answer only for an active account: the inactive super
--     admin holds no role at all; active accounts are unchanged.
do $$
declare r record;
begin
  set local role authenticated;
  for r in select * from (values
      ('17171717-0000-4000-8000-000000000017'::uuid, false, false, false, null::text, null::text, false, false, 1::bigint),
      ('c3c3c3c3-0000-4000-8000-000000000003',       true,  true,  false, 'admin',    null,       false, false, -1),
      ('d4d4d4d4-0000-4000-8000-000000000004',       true,  true,  true,  'admin',    null,       true,  false, -1),
      ('16161616-0000-4000-8000-000000000016',       false, true,  false, 'user',     null,       false, true,  -1),
      ('a1a1a1a1-0000-4000-8000-000000000001',       false, false, false, 'client',   'ZT01',     false, false, 1)
    ) v(id, admin, staff, super, role, code, billing, production, profiles_seen) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.id)::text, true);
    if (public.is_admin(), public.is_staff(), public.is_super_admin(), public.my_role()::text, public.my_client_code(),
        public.can_confirm_payments(), public.can_work_production())
       is distinct from (r.admin, r.staff, r.super, r.role, r.code, r.billing, r.production) then
      raise exception 'FAIL A3: helpers for % -> %', r.id,
        row(public.is_admin(), public.is_staff(), public.is_super_admin(), public.my_role(), public.my_client_code(),
            public.can_confirm_payments(), public.can_work_production());
    end if;
    if r.profiles_seen > 0 and (select count(*) from public.profiles) <> r.profiles_seen then
      raise exception 'FAIL A3: % sees % profiles', r.id, (select count(*) from public.profiles);
    end if;
  end loop;
end $$;
\echo 'ok  A3 role helpers: an inactive super admin is no admin, staff, super admin or billing owner and sees only itself; active accounts unchanged'

-- ┌── EXTRACT P1-P14 provisioning and activation
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 789-1309 @ 9d167690, verbatim; sha256 80e1ed9f97bc9c6205d14899146d1f9a0aa6e2d710c9a57e207929dab4fe45fc
-- └──────────────────────────────────────────────────────────────────────────
-- ── Account provisioning (02_post_migrate.sql section 7) ───────────────────
-- P1: an active, non-super admin provisions a client and a production user
--     (with a stage-scoped trainee grant). Each gets a new internal UUID and a
--     'pending' profile holding exactly what was asked (email and name tidied).
do $$
declare v_client uuid; v_user uuid; r record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  v_client := auth.provision_app_user('zt-prov-client', ' ZT-Prov-Client@Example.TEST ', 'client', '  ZT Prov Client ', 'ZT02');
  v_user := auth.provision_app_user('zt-prov-user', 'zt-prov-user@example.test', 'user', 'ZT Prov User', null, false, false,
    '[{"capability":"orders.work","effect":"revoke"},{"capability":"orders.work","effect":"grant","scope":{"stages":["screener"]}}]');
  if v_client is null or v_user is null or v_client = v_user then
    raise exception 'FAIL P1: returned ids % and %', v_client, v_user;
  end if;
  select * into r from public.profiles where id = v_client;
  if not found or (r.role::text, r.status, r.client_code, r.super_admin, r.can_confirm_payments, r.permissions, r.name, r.email)
       is distinct from ('client', 'pending', 'ZT02', false, false, '[]'::jsonb, 'ZT Prov Client', 'zt-prov-client@example.test') then
    raise exception 'FAIL P1: client stored as %', row_to_json(r);
  end if;
  select * into r from public.profiles where id = v_user;
  if not found or (r.role::text, r.status, r.client_code, r.super_admin, r.can_confirm_payments, r.permissions)
       is distinct from ('user', 'pending', null::text, false, false,
         '[{"capability":"orders.work","effect":"revoke"},{"capability":"orders.work","effect":"grant","scope":{"stages":["screener"]}}]'::jsonb) then
    raise exception 'FAIL P1: production user stored as %', row_to_json(r);
  end if;
end $$;
\echo 'ok  P1 active admin provisions a client and a production user: new UUID, pending profile, exact attributes'

-- P2: a super admin provisions an admin; the billing owner provisions a super
--     admin with billing; a super admin without billing provisions a super
--     admin with an elevated grant (no billing).
do $$
declare v uuid; r record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  v := auth.provision_app_user('zt-prov-admin', 'zt-prov-admin@example.test', 'admin', 'ZT Prov Admin');
  select * into r from public.profiles where id = v;
  if (r.role::text, r.status, r.super_admin, r.can_confirm_payments) is distinct from ('admin', 'pending', false, false) then
    raise exception 'FAIL P2: admin stored as %', row_to_json(r);
  end if;
  v := auth.provision_app_user('zt-prov-billing', 'zt-prov-billing@example.test', 'admin', 'ZT Prov Billing', null, true, true,
         '[{"capability":"payments.confirm","effect":"grant"}]');
  select * into r from public.profiles where id = v;
  if (r.role::text, r.status, r.super_admin, r.can_confirm_payments) is distinct from ('admin', 'pending', true, true) then
    raise exception 'FAIL P2: billing super admin stored as %', row_to_json(r);
  end if;
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  v := auth.provision_app_user('zt-prov-super', 'zt-prov-super@example.test', 'admin', 'ZT Prov Super', null, true, false,
         '[{"capability":"payouts.view","effect":"grant"}]');
  select * into r from public.profiles where id = v;
  if (r.role::text, r.status, r.super_admin, r.can_confirm_payments) is distinct from ('admin', 'pending', true, false) then
    raise exception 'FAIL P2: super admin stored as %', row_to_json(r);
  end if;
end $$;
\echo 'ok  P2 super admin provisions admin accounts; billing owner grants billing; super admin grants elevated capabilities'

-- P3-P6: who may NOT provision what. Each refusal carries the expected reason
--     and creates nothing (O7 re-checks every mapping). Forged claims -- a
--     claim role, super-admin / billing flags in the JWT, the session-settable
--     request.jwt.claim.* -- change nothing: only `sub` is read, and the
--     caller's profile decides.
do $$
declare t record; st text; msg text;
begin
  set local role authenticated;
  for t in select * from (values
    ('P3 client -> client',                 '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P3 client -> admin',                  '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P4 production user -> client',        '{"sub":"16161616-0000-4000-8000-000000000016"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P4 inactive super admin -> client',   '{"sub":"17171717-0000-4000-8000-000000000017"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P4 no such profile -> client',        '{"sub":"99999999-0000-4000-8000-000000000099"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P5 admin -> admin',                   '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied')$c$,
       '42501', 'provision_app_user: only a super admin may provision an admin account'),
    ('P5 admin -> super admin',             '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, true, false)$c$,
       '42501', 'provision_app_user: only a super admin may provision an admin account'),
    ('P5 admin -> user + payouts.view',     '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'user', 'ZT Denied', null, false, false, '[{"capability":"payouts.view","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only a super admin may grant'),
    ('P5 admin -> user + users.manage',     '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'user', 'ZT Denied', null, false, false, '[{"capability":"users.manage","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only a super admin may grant'),
    ('P5 admin -> user + orders.assign',    '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'user', 'ZT Denied', null, false, false, '[{"capability":"orders.assign","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only a super admin may grant'),
    ('P5 admin -> client + support.reply_client', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01', false, false, '[{"capability":"support.reply_client","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only a super admin may grant'),
    ('P5 admin -> client + payments.confirm', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01', false, false, '[{"capability":"payments.confirm","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only a super admin may grant'),
    ('P5 super admin (no billing) -> admin + billing', '{"sub":"15151515-0000-4000-8000-000000000015"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, false, true)$c$,
       '42501', 'provision_app_user: only the billing owner may grant payment confirmation'),
    ('P5 super admin (no billing) -> admin + payments.confirm', '{"sub":"15151515-0000-4000-8000-000000000015"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, false, false, '[{"capability":"payments.confirm","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only the billing owner may grant payment confirmation'),
    ('P5 super admin (no billing) -> user + payments.confirm', '{"sub":"15151515-0000-4000-8000-000000000015"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'user', 'ZT Denied', null, false, false, '[{"capability":"payments.confirm","effect":"grant"}]')$c$,
       '42501', 'provision_app_user: only the billing owner may grant payment confirmation'),
    ('P6 client with forged admin/service_role claims -> admin',
       '{"sub":"a1a1a1a1-0000-4000-8000-000000000001","role":"service_role","super_admin":true,"superAdmin":true,"can_confirm_payments":true,"app_metadata":{"role":"admin"}}', true,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, true, true)$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P6 admin with forged super-admin claims -> super admin',
       '{"sub":"c3c3c3c3-0000-4000-8000-000000000003","role":"service_role","super_admin":true,"superAdmin":true}', true,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, true, false)$c$,
       '42501', 'provision_app_user: only a super admin may provision an admin account'),
    ('P6 super admin with forged billing claims -> billing',
       '{"sub":"15151515-0000-4000-8000-000000000015","role":"service_role","can_confirm_payments":true}', true,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'admin', 'ZT Denied', null, false, true)$c$,
       '42501', 'provision_app_user: only the billing owner may grant payment confirmation'),
    ('P6 inactive super admin with forged claims -> client',
       '{"sub":"17171717-0000-4000-8000-000000000017","role":"service_role","super_admin":true}', true,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'provision_app_user: the caller is not an active administrator'),
    ('P6 no claims -> client',              '', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '42501', 'auth.uid(): no authenticated identity'),
    ('P6 Firebase UID as sub -> client',    '{"sub":"zt-fb-billing"}', false,
       $c$select auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01')$c$,
       '22P02', 'invalid input syntax for type uuid')
  ) v(label, claims, forged, call, state, reason) loop
    perform set_config('request.jwt.claims', t.claims, true);
    perform set_config('request.jwt.claim.role', case when t.forged then 'service_role' else '' end, true);
    perform set_config('request.jwt.claim.super_admin', case when t.forged then 'true' else '' end, true);
    st := null; msg := null;
    begin
      execute t.call;
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if st is distinct from t.state or msg is null or left(msg, length(t.reason)) <> t.reason then
      raise exception 'FAIL %: expected % "%...", got % "%"', t.label, t.state, t.reason, st, msg;
    end if;
  end loop;
end $$;

-- ...and outside `authenticated` the function cannot be called at all: not as
-- anon, not as the app login itself (NOINHERIT), and service_role is unreachable.
do $$
declare rl text;
begin
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  foreach rl in array array['anon', session_user::text] loop
    begin
      execute format('set local role %I', rl);
      perform auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01');
      raise exception 'FAIL P6: % could call auth.provision_app_user', rl;
    exception when insufficient_privilege then
      if sqlerrm not like 'permission denied for function provision_app_user%' then raise; end if;
    end;
  end loop;
  begin
    set local role service_role;
    raise exception 'FAIL P6: the app login reached service_role';
  exception when insufficient_privilege then null;
  end;
end $$;
\echo 'ok  P3-P6 refused: client, production user, inactive or unknown caller; admin -> admin / super / elevated / cross-role grants; billing without being the billing owner; forged claims; anon, the app login itself'

-- P7: malformed input is refused before anything is looked up or written --
--     as the billing owner, so authorization is never the reason.
do $$
declare t record; st text; msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  for t in select * from (values
    ($c$select auth.provision_app_user('', 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user('zt prov bad', 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user('zt-prov-%', 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user('zt-prov-ünicode', 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user(repeat('a', 129), 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user(null, 'zt-prov-bad@example.test', 'client', 'x', 'ZT01')$c$, 'invalid firebase uid'),
    ($c$select auth.provision_app_user('zt-prov-bad', null, 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'no-at-sign.example.test', 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'a@b', 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'two@@example.test', 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', E'tab\there@example.test', 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', repeat('e', 250) || '@example.test', 'client', 'x', 'ZT01')$c$, 'invalid email'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', repeat('n', 201), 'ZT01')$c$, 'invalid name'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', E'line\nbreak', 'ZT01')$c$, 'invalid name'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'superuser', 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'operator', 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'screener', 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'Admin', 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', '', 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', null, 'x')$c$, 'unsupported role'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'admin', 'x', null, null, false)$c$, 'super_admin and can_confirm_payments must be'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, true, false)$c$, 'super admin and billing apply only to admin'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', 'x', 'ZT01', false, true)$c$, 'super admin and billing apply only to admin'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', 'x')$c$, 'a client account needs a client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', 'ZT01')$c$, 'only client accounts carry a client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'admin', 'x', 'ZT01')$c$, 'only client accounts carry a client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', 'x', 'ZT99')$c$, 'unknown client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', 'x', ' ZT01')$c$, 'unknown client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'client', 'x', 'zt01')$c$, 'unknown client code'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '{}')$c$, 'permissions must be an array'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '"orders.read"')$c$, 'permissions must be an array'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, 'null')$c$, 'permissions must be an array'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, null)$c$, 'permissions must be an array'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false,
         (select jsonb_agg('{"capability":"orders.read","effect":"grant"}'::jsonb) from generate_series(1, 33)))$c$, 'permissions must be an array'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[1]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '["orders.read"]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.read"}]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.read","effect":"allow"}]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"root","effect":"grant"}]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":7,"effect":"grant"}]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.read","effect":"grant","admin":true}]')$c$, 'invalid permission entry'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.read","effect":"grant","scope":{"stages":["screener"]}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":"all"}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":"screener"}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":[]}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":["boss"]}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":[1]}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":["screener","screener"]}}]')$c$, 'invalid permission scope'),
    ($c$select auth.provision_app_user('zt-prov-bad', 'zt-prov-bad@example.test', 'user', 'x', null, false, false, '[{"capability":"orders.work","effect":"grant","scope":{"stages":["screener"],"orders":["ZT-1"]}}]')$c$, 'invalid permission scope')
  ) v(call, reason) loop
    st := null; msg := null;
    begin
      execute t.call;
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if st is distinct from '22023' or msg is null or left(msg, length('provision_app_user: ' || t.reason)) <> 'provision_app_user: ' || t.reason then
      raise exception 'FAIL P7: % -> expected 22023 "%", got % "%"', t.call, t.reason, st, msg;
    end if;
  end loop;
end $$;
\echo 'ok  P7 refused as invalid: firebase uid, email, name, role, flags, client code, permissions and scopes'

-- P8: a Firebase UID or email that is already mapped is refused -- even with
--     elevated attributes from the billing owner -- and the existing profile is
--     left exactly as it was. Submitting the same request twice: the second fails.
do $$
declare
  before_a text; before_p text; t record; st text; msg text; v uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select row_to_json(p)::text into before_a from public.profiles p where id = 'a1a1a1a1-0000-4000-8000-000000000001';
  select row_to_json(p)::text into before_p from public.profiles p where email = 'zt-prov-client@example.test';
  for t in select * from (values
    ($c$select auth.provision_app_user('zt-fb-client-a', 'zt-prov-dup@example.test', 'admin', 'ZT Dup', null, true, true)$c$, 'the firebase uid is already mapped'),
    ($c$select auth.provision_app_user('zt-prov-client', 'zt-prov-dup@example.test', 'client', 'ZT Dup', 'ZT01')$c$, 'the firebase uid is already mapped'),
    ($c$select auth.provision_app_user('zt-prov-client', 'zt-prov-client@example.test', 'client', 'ZT Prov Client', 'ZT02')$c$, 'the firebase uid is already mapped'),
    ($c$select auth.provision_app_user('zt-prov-dup-email', 'ZT-A@Example.test', 'client', 'ZT Dup', 'ZT01')$c$, 'the email already belongs to an account'),
    ($c$select auth.provision_app_user('zt-prov-dup-email', 'zt-prov-client@example.test', 'client', 'ZT Dup', 'ZT02')$c$, 'the email already belongs to an account')
  ) v(call, reason) loop
    st := null; msg := null;
    begin
      execute t.call;
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if st is distinct from '23505' or msg is distinct from 'provision_app_user: ' || t.reason then
      raise exception 'FAIL P8: % -> expected 23505 "%", got % "%"', t.call, t.reason, st, msg;
    end if;
  end loop;
  if (select row_to_json(p)::text from public.profiles p where id = 'a1a1a1a1-0000-4000-8000-000000000001') is distinct from before_a
     or (select row_to_json(p)::text from public.profiles p where email = 'zt-prov-client@example.test') is distinct from before_p then
    raise exception 'FAIL P8: a duplicate request modified an existing profile';
  end if;
  begin
    v := auth.provision_app_user('zt-prov-retry', 'zt-prov-retry@example.test', 'client', 'ZT Retry', 'ZT01');
    begin
      perform auth.provision_app_user('zt-prov-retry', 'zt-prov-retry@example.test', 'client', 'ZT Retry', 'ZT01');
      raise exception 'FAIL P8: the same submission was accepted twice';
    exception when unique_violation then null;
    end;
    raise exception using errcode = 'ZT999';   -- discard
  exception when sqlstate 'ZT999' then null;
  end;
end $$;
\echo 'ok  P8 duplicate firebase uid or email refused, existing profiles untouched; a repeated submission fails'

-- P9: a profile insert that fails after the mapping insert leaves neither row,
--     and so does a successful call whose transaction rolls back (O7 confirms
--     in auth.users, which this login cannot read).
do $$
declare st text; msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  begin
    perform auth.provision_app_user('zt-prov-fail', 'zt-prov-fail@example.test', 'client', 'ZT Fail', 'ZT01');
  exception when others then st := sqlstate; msg := sqlerrm;
  end;
  if st is distinct from 'ZT998' then
    raise exception 'FAIL P9: expected the simulated profile insert failure, got % "%"', st, msg;
  end if;
  begin
    perform auth.provision_app_user('zt-prov-rolledback', 'zt-prov-rolledback@example.test', 'client', 'ZT Rolled Back', 'ZT01');
    raise exception using errcode = 'ZT999';   -- the request's transaction fails later
  exception when sqlstate 'ZT999' then null;
  end;
  if exists (select 1 from public.profiles
              where email in ('zt-prov-fail@example.test', 'zt-prov-rolledback@example.test')) then
    raise exception 'FAIL P9: a failed or rolled-back provisioning left a profile';
  end if;
end $$;
\echo 'ok  P9 profile insert failure and transaction rollback: no profile (mapping checked in O7)'

-- P10: a provisioned account is 'pending' to the gate's resolver -- the API
--      admits only 'active' -- and nobody activates it through the app login:
--      not the account itself, not an admin, not the billing super admin.
--      Pending admins cannot provision either.
do $$
declare r record; v uuid; who uuid; n int; st text; msg text;
begin
  for r in select u.uid, x.* from unnest(array['zt-prov-client', 'zt-prov-user', 'zt-prov-admin', 'zt-prov-billing', 'zt-prov-super']) u(uid)
                                left join lateral auth.resolve_app_user(u.uid) x on true loop
    if r.id is null or r.status is distinct from 'pending' then
      raise exception 'FAIL P10: % resolves to %', r.uid, row_to_json(r);
    end if;
  end loop;

  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select id into v from public.profiles where email = 'zt-prov-client@example.test';
  foreach who in array array[v, 'c3c3c3c3-0000-4000-8000-000000000003', 'd4d4d4d4-0000-4000-8000-000000000004'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    n := 0; msg := null;
    begin
      update public.profiles set status = 'active' where id = v;
      get diagnostics n = row_count;
    exception when others then msg := sqlerrm;
    end;
    if n > 0 or msg is null or (msg not like '%set by an administrator%'
                                and msg not like 'permission denied for table profiles%') then
      raise exception 'FAIL P10: % activated a pending account (rows=%, error=%)', who, n, msg;
    end if;
  end loop;

  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  foreach v in array array(select id from public.profiles
                            where email in ('zt-prov-admin@example.test', 'zt-prov-billing@example.test')) loop
    perform set_config('request.jwt.claims', json_build_object('sub', v)::text, true);
    st := null; msg := null;
    begin
      perform auth.provision_app_user('zt-prov-denied', 'zt-prov-denied@example.test', 'client', 'ZT Denied', 'ZT01');
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if st is distinct from '42501' or msg not like '%the caller is not an active administrator' then
      raise exception 'FAIL P10: pending admin % -> % "%"', v, st, msg;
    end if;
    perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  end loop;
end $$;
\echo 'ok  P10 provisioned accounts resolve as pending (gate refuses), cannot be activated through the app login, pending admins cannot provision'

-- P11: an unauthorized caller learns nothing: an existing UID and a fresh one
--      get the identical refusal, and nothing is created or changed (O7).
do $$
declare a text; b text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  begin
    perform auth.provision_app_user('zt-fb-billing', 'zt-d@example.test', 'admin', 'x', null, true, true);
  exception when others then a := sqlstate || ' ' || sqlerrm;
  end;
  begin
    perform auth.provision_app_user('zt-prov-enum', 'zt-prov-enum@example.test', 'admin', 'x', null, true, true);
  exception when others then b := sqlstate || ' ' || sqlerrm;
  end;
  if a is null or a is distinct from b then
    raise exception 'FAIL P11: an existing and a new account were answered differently: % / %', a, b;
  end if;
end $$;
\echo 'ok  P11 unauthorized caller: existing and unknown accounts answered identically; nothing enumerated or changed'

-- P12: a pending client -- claims as the API would set them once it is
--      active -- sees nothing but its own profile row: the role helpers answer
--      only for active accounts (section 9). P14 repeats this after activation.
do $$
declare v uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  select id into v from public.profiles where email = 'zt-prov-client@example.test';
  perform set_config('request.jwt.claims', json_build_object('sub', v)::text, true);
  if (select count(*) from public.orders) <> 0 or (select count(*) from public.clients) <> 0
     or (select count(*) from public.profiles) <> 1 or (select id from public.profiles) <> v then
    raise exception 'FAIL P12: a pending client sees orders, clients or other profiles';
  end if;
end $$;
\echo 'ok  P12 pending client sees only its own profile: no orders, no client record'

-- P13: activation (auth.activate_app_user) -- who may activate what, from the
--      caller's current profile against the account's stored privileges; the
--      pending admin holds no role before it; activation is idempotent; the
--      guard's authorization table cannot be written by any application role.
do $$
declare
  t record; st text; msg text; r record;
  v_client uuid; v_admin uuid; v_billing uuid; v_super uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select id into v_client  from public.profiles where email = 'zt-prov-client@example.test';
  select id into v_admin   from public.profiles where email = 'zt-prov-admin@example.test';
  select id into v_billing from public.profiles where email = 'zt-prov-billing@example.test';
  select id into v_super   from public.profiles where email = 'zt-prov-super@example.test';

  -- a pending admin holds no role until activated
  perform set_config('request.jwt.claims', json_build_object('sub', v_admin)::text, true);
  if public.is_admin() or public.is_staff() or public.my_role() is not null then
    raise exception 'FAIL P13: a pending admin already holds a role';
  end if;

  for t in select * from (values
    ('client',                     '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', 'client',  '42501', 'activate_app_user: the caller is not an active administrator'),
    ('production user',            '{"sub":"16161616-0000-4000-8000-000000000016"}', 'client',  '42501', 'activate_app_user: the caller is not an active administrator'),
    ('inactive super admin',       '{"sub":"17171717-0000-4000-8000-000000000017"}', 'client',  '42501', 'activate_app_user: the caller is not an active administrator'),
    ('pending admin',              'pending-admin',                                  'client',  '42501', 'activate_app_user: the caller is not an active administrator'),
    ('client, forged claims',      '{"sub":"a1a1a1a1-0000-4000-8000-000000000001","role":"service_role","super_admin":true}', 'client', '42501', 'activate_app_user: the caller is not an active administrator'),
    ('no claims',                  '',                                               'client',  '42501', 'auth.uid(): no authenticated identity'),
    ('admin -> admin account',     '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', 'admin',   '42501', 'activate_app_user: only a super admin may activate this account'),
    ('admin -> super admin',       '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', 'super',   '42501', 'activate_app_user: only a super admin may activate this account'),
    ('admin -> billing account',   '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', 'billing', '42501', 'activate_app_user: only a super admin may activate this account'),
    ('super (no billing) -> billing', '{"sub":"15151515-0000-4000-8000-000000000015"}', 'billing', '42501', 'activate_app_user: only the billing owner may activate a billing account'),
    ('unknown account',            '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', 'unknown', 'P0002', 'activate_app_user: no such account'),
    ('no account id',              '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', 'null',    '22023', 'activate_app_user: invalid account id'),
    ('inactive account',           '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', 'inactive','55000', 'activate_app_user: the account is not pending')
  ) v(label, claims, target, state, reason) loop
    perform set_config('request.jwt.claims',
      case when t.claims = 'pending-admin' then json_build_object('sub', v_admin)::text else t.claims end, true);
    st := null; msg := null;
    begin
      perform auth.activate_app_user(case t.target
        when 'client' then v_client when 'admin' then v_admin when 'billing' then v_billing when 'super' then v_super
        when 'unknown' then '99999999-0000-4000-8000-000000000099'::uuid
        when 'inactive' then '17171717-0000-4000-8000-000000000017'::uuid end);
    exception when others then st := sqlstate; msg := sqlerrm;
    end;
    if st is distinct from t.state or msg is null or left(msg, length(t.reason)) <> t.reason then
      raise exception 'FAIL P13 %: expected % "%...", got % "%"', t.label, t.state, t.reason, st, msg;
    end if;
  end loop;

  -- no application role can mint the guard's authorization row, as
  -- authenticated, anon or the app login itself
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  foreach st in array array['authenticated', 'anon', session_user::text] loop
    begin
      execute format('set local role %I', st);
      insert into auth.profile_privileged_changes (txid, profile_id) values (txid_current(), v_client);
      raise exception 'FAIL P13: % wrote auth.profile_privileged_changes', st;
    exception when insufficient_privilege then null;
    end;
  end loop;
  set local role authenticated;

  -- an active admin activates the pending client: once, then idempotently
  select * into r from auth.activate_app_user(v_client);
  if (r.firebase_uid, r.email, r.activated) is distinct from ('zt-prov-client', 'zt-prov-client@example.test', true) then
    raise exception 'FAIL P13: activation returned %', row_to_json(r);
  end if;
  select * into r from auth.activate_app_user(v_client);
  if r.activated is distinct from false then
    raise exception 'FAIL P13: a repeated activation was not idempotent: %', row_to_json(r);
  end if;
  -- the billing owner activates the billing account
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select * into r from auth.activate_app_user(v_billing);
  if r.activated is distinct from true then
    raise exception 'FAIL P13: billing owner could not activate the billing account';
  end if;
  if (select string_agg(email || '=' || status, ' ' order by email) from public.profiles where email like 'zt-prov-%')
     is distinct from 'zt-prov-admin@example.test=pending zt-prov-billing@example.test=active zt-prov-client@example.test=active zt-prov-super@example.test=pending zt-prov-user@example.test=pending' then
    raise exception 'FAIL P13: statuses after activation: %', (select string_agg(email || '=' || status, ' ') from public.profiles where email like 'zt-prov-%');
  end if;
  -- still no other privileged change on the activated account
  begin
    update public.profiles set super_admin = true where id = v_client;
    raise exception 'FAIL P13: privileged update after activation';
  exception when insufficient_privilege then null;
  end;
end $$;
do $$
declare r record;
begin
  select * into r from auth.resolve_app_user('zt-prov-client');
  if not found or r.status <> 'active' then
    raise exception 'FAIL P13: the activated client resolves as %', row_to_json(r);
  end if;
end $$;
\echo 'ok  P13 activation: only an active admin with the account''s required authority; pending admin holds no role; idempotent; guard token unforgeable'

-- P14: once activated, the provisioned client is scoped to its own client code
--      by RLS like any other client.
do $$
declare v uuid; n int; m int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  select id into v from public.profiles where email = 'zt-prov-client@example.test';
  perform set_config('request.jwt.claims', json_build_object('sub', v)::text, true);
  select count(*), count(*) filter (where client_code is distinct from 'ZT02') into n, m from public.orders;
  if n = 0 or m <> 0 then
    raise exception 'FAIL P14: activated ZT02 client sees % orders, % of another client', n, m;
  end if;
  if (select count(*) from public.profiles where id <> v) <> 0
     or (select string_agg(code, ',') from public.clients) is distinct from 'ZT02' then
    raise exception 'FAIL P14: activated client sees other profiles or clients';
  end if;
end $$;
\echo 'ok  P14 activated client sees only its own client''s orders, profile and client record'

-- ┌── EXTRACT U1-U2 account edits, deactivate / reactivate
-- │ integration-reference/gcp-live/gcp/test_security.sql lines 2128-2275 @ 9d167690, verbatim; sha256 2973057bad91df4a3a633381a8344daeb46a17c82032f287a5a3aa289076fa27
-- └──────────────────────────────────────────────────────────────────────────

-- U1: editing accounts (auth.update_app_user). Authority follows provisioning
--     (section 7) for the account as stored AND as edited; one's own account
--     only by name; the version read must be current; identity never changes.
do $$
declare
  c uuid := '19191919-0000-4000-8000-000000000019'; u uuid := '20202020-0000-4000-8000-000000000020';
  a uuid := '21212121-0000-4000-8000-000000000021'; v timestamptz; v2 timestamptz; r record;
begin
  set local role authenticated;
  -- a plain admin: client and production accounts, within their role bundles
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  select updated_at into v from public.profiles where id = c;
  v2 := auth.update_app_user(c, v, '  ZT Edited Client ', 'user', null, false, false, '[]');
  if v2 <= v or (select row(name, role::text, client_code)::text from public.profiles where id = c) <> '("ZT Edited Client",user,)' then
    raise exception 'FAIL U1: plain admin edit of a client account';
  end if;
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, v, 'x', 'user', null, '[]'), '40001');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, null, 'x', 'user', null, '[]'), '40001');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, v2, 'x', 'client', 'ZT99', '[]'), '22023', '%unknown client code');
  v := auth.update_app_user(c, v2, 'ZT Edit Client', 'client', 'ZT02', false, false, '[]');
  if (select client_code from public.profiles where id = c) <> 'ZT02' then raise exception 'FAIL U1: client code not moved'; end if;
  -- an unchanged edit changes nothing, not even the version
  if auth.update_app_user(c, v, 'ZT Edit Client', 'client', 'ZT02', false, false, '[]') <> v then raise exception 'FAIL U1: a no-op edit bumped the version'; end if;
  select updated_at into v from public.profiles where id = u;
  v := auth.update_app_user(u, v, 'ZT Edit User', 'user', null, false, false,
         '[{"capability":"orders.work","effect":"revoke"},{"capability":"orders.work","effect":"grant","scope":{"stages":["screener"]}}]');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'ZT Edit User', 'user', null,
    '[{"capability":"support.reply_client","effect":"grant"}]'), '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'ZT Edit User', 'admin', null, '[]'), '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, false, %L)', a,
    (select updated_at from public.profiles where id = a), 'ZT Edit Admin', 'admin', null, '[]'), '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', a,
    (select updated_at from public.profiles where id = a), 'Renamed', 'admin', null, '[]'), '42501');             -- an admin account at all
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'x', 'superuser', null, '[]'), '22023');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, false, %L)', u, v, 'x', 'user', null, '[]'), '22023');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, E'bad\u0007name', 'user', null, '[]'), '22023');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'x', 'user', null, '[{"capability":"root","effect":"grant"}]'), '22023');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'x', 'client', null, '[]'), '22023');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', gen_random_uuid(), v, 'x', 'user', null, '[]'), 'P0002');
  -- one's own account: the name only
  select updated_at into v from public.profiles where id = 'c3c3c3c3-0000-4000-8000-000000000003';
  v := auth.update_app_user('c3c3c3c3-0000-4000-8000-000000000003', v, 'ZT Admin Renamed', 'admin', null, false, false, '[]');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, false, %L)', 'c3c3c3c3-0000-4000-8000-000000000003', v,
    'ZT Admin Renamed', 'admin', null, '[]'), '42501', 'update_app_user: you cannot change your own%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', 'c3c3c3c3-0000-4000-8000-000000000003', v,
    'ZT Admin Renamed', 'admin', null, '[{"capability":"users.grant_super","effect":"grant"}]'), '42501', 'update_app_user: you cannot change your own%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', 'c3c3c3c3-0000-4000-8000-000000000003', v,
    'ZT Admin Renamed', 'client', 'ZT01', '[]'), '42501', 'update_app_user: you cannot change your own%');
  v := auth.update_app_user('c3c3c3c3-0000-4000-8000-000000000003', v, 'ZT Admin', 'admin', null, false, false, '[]');
  -- a forged claim role grants nothing
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, false, %L)', a,
    (select updated_at from public.profiles where id = a), 'ZT Edit Admin', 'admin', null, '[]'), '42501');
  perform set_config('request.jwt.claim.role', '', true);

  -- a super admin without billing: admin accounts and elevated access, not billing
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  select updated_at into v from public.profiles where id = a;
  v := auth.update_app_user(a, v, 'ZT Edit Admin', 'admin', null, true, false, '[{"capability":"clients.view_pii","effect":"grant"}]');
  if (select row(super_admin, can_confirm_payments)::text from public.profiles where id = a) <> '(t,f)' then raise exception 'FAIL U1: super admin grant'; end if;
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, true, %L)', a, v, 'ZT Edit Admin', 'admin', null, '[]'),
    '42501', 'update_app_user: only the billing owner%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, true, %L)', 'd4d4d4d4-0000-4000-8000-000000000004',
    (select updated_at from public.profiles where id = 'd4d4d4d4-0000-4000-8000-000000000004'), 'Renamed', 'admin', null, '[]'), '42501', 'update_app_user: only the billing owner%');
  -- the billing owner may grant and withdraw billing
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  v := auth.update_app_user(a, v, 'ZT Edit Admin', 'admin', null, true, true, '[]');
  v := auth.update_app_user(a, v, 'ZT Edit Admin', 'admin', null, false, false, '[]');
  -- not an active admin: refused
  for r in select * from (values ('a1a1a1a1-0000-4000-8000-000000000001'), ('16161616-0000-4000-8000-000000000016'),
                                     ('17171717-0000-4000-8000-000000000017')) x(sub) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.sub)::text, true);
    perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, v, 'x', 'user', null, '[]'), '42501');
    perform public.zt_expect_error('select count(*) from auth.admin_account_uids()', '42501');
  end loop;
  -- identity: ids, emails and the Firebase mapping are untouched
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select string_agg(m.firebase_uid || '=' || p.email, ',' order by m.firebase_uid)
        from auth.admin_account_uids() m join public.profiles p on p.id = m.id where m.firebase_uid like 'zt-fb-edit-%')
     is distinct from 'zt-fb-edit-admin=zt-edit-admin@example.test,zt-fb-edit-client=zt-edit-client@example.test,'
                      'zt-fb-edit-pending=zt-edit-pending@example.test,zt-fb-edit-user=zt-edit-user@example.test' then
    raise exception 'FAIL U1: an identity or mapping changed';
  end if;
end $$;
\echo 'ok  U1 account edits: plain admin within bundles; admin accounts and elevated access need a super admin; billing the billing owner; own account by name only; stale, invalid and forged requests refused; identity kept'

-- U2: deactivation and reactivation (auth.set_app_user_status): portal access
--     is the database's -- an inactive account holds no role at once; the
--     same authority as activation; never one's own account or a pending one;
--     repeated changes are no-ops; the version read must be current.
do $$
declare
  c uuid := '19191919-0000-4000-8000-000000000019'; a uuid := '21212121-0000-4000-8000-000000000021';
  v timestamptz; r record;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  select updated_at into v from public.profiles where id = c;
  select * into r from auth.set_app_user_status(c, false, v);
  if r.firebase_uid <> 'zt-fb-edit-client' or r.email <> 'zt-edit-client@example.test' or r.status <> 'inactive' or not r.changed then
    raise exception 'FAIL U2: deactivation returned %', row_to_json(r);
  end if;
  -- repeated (even on an old version): finishes, changes nothing
  select * into r from auth.set_app_user_status(c, false, v);
  if r.changed or r.status <> 'inactive' then raise exception 'FAIL U2: a repeated deactivation changed the account'; end if;
  -- the deactivated account holds nothing, whatever its claims say
  perform set_config('request.jwt.claims', json_build_object('sub', c)::text, true);
  if public.my_client_code() is not null or public.is_staff() or exists (select 1 from public.orders) then
    raise exception 'FAIL U2: a deactivated client still reads its orders';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, true, %L)', c, v), '40001');
  select * into r from auth.set_app_user_status(c, true, (select updated_at from public.profiles where id = c));
  if r.status <> 'active' or not r.changed then raise exception 'FAIL U2: reactivation'; end if;
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', 'c3c3c3c3-0000-4000-8000-000000000003',
    (select updated_at from public.profiles where id = 'c3c3c3c3-0000-4000-8000-000000000003')), '42501', 'set_app_user_status: you cannot%');
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', a, (select updated_at from public.profiles where id = a)),
    '42501', 'set_app_user_status: only a super admin%');
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', '22222222-0000-4000-8000-000000000022',
    (select updated_at from public.profiles where id = '22222222-0000-4000-8000-000000000022')), '55000');
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, true, %L)', '22222222-0000-4000-8000-000000000022',
    (select updated_at from public.profiles where id = '22222222-0000-4000-8000-000000000022')), '55000');
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, null, %L)', c, v), '22023');
  -- a super admin deactivates an admin, not the billing owner; the billing owner may
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  perform auth.set_app_user_status(a, false, (select updated_at from public.profiles where id = a));
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', 'd4d4d4d4-0000-4000-8000-000000000004',
    (select updated_at from public.profiles where id = 'd4d4d4d4-0000-4000-8000-000000000004')), '42501', 'set_app_user_status: only the billing owner%');
  -- the deactivated admin can no longer administer anything
  perform set_config('request.jwt.claims', json_build_object('sub', a)::text, true);
  if public.is_admin() then raise exception 'FAIL U2: a deactivated admin is still an admin'; end if;
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', c, (select updated_at from public.profiles where id = c)), '42501');
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  perform auth.set_app_user_status(a, true, (select updated_at from public.profiles where id = a));
  -- clients, production and inactive admins: refused
  for r in select * from (values ('a1a1a1a1-0000-4000-8000-000000000001'), ('16161616-0000-4000-8000-000000000016'),
                                     ('17171717-0000-4000-8000-000000000017')) x(sub) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.sub)::text, true);
    perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', c, v), '42501');
  end loop;
  -- the UIDs for the sign-in states: active admins only, every mapped account
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select count(*) from auth.admin_account_uids() where firebase_uid like 'zt-fb-edit-%') <> 4 then
    raise exception 'FAIL U2: admin_account_uids';
  end if;
end $$;
\echo 'ok  U2 deactivate / reactivate: the database ends portal access at once; same authority as activation; not one''s own or a pending account; repeats are no-ops; stale versions refused'

-- ┌── R1 -- ADDED for PR #157 (not in the reference suite)
-- │ What adminUsers.integration.mjs asserted against the retired action API,
-- │ restated against the production functions and their rules:
-- │  * a client, a production user and an inactive super admin are refused
-- │    every account write; a plain admin cannot elevate, touch an admin
-- │    account (not even to demote it), use an unknown or missing client code
-- │    or a stale version; a super admin without billing cannot grant billing;
-- │    nobody writes protected columns directly -- and after ALL of those the
-- │    three accounts are byte-for-byte what they were;
-- │  * the billing owner can make an account admin + super admin + billing;
-- │    demoting it is refused while either flag is kept, and clears both;
-- │  * unknown account ids are refused by every entry point (P0002).
-- │ Runs after U2, as the restricted app login, through `authenticated` +
-- │ claims; uses only the reference fixtures and zt_expect_error.
-- └──────────────────────────────────────────────────────────────────────────
do $$
declare
  c uuid := '19191919-0000-4000-8000-000000000019'; u uuid := '20202020-0000-4000-8000-000000000020';
  a uuid := '21212121-0000-4000-8000-000000000021';
  snap text; after text; vc timestamptz; vu timestamptz; va timestamptz; r record;
  q constant text := $q$select string_agg(row_to_json(p)::text, '|' order by p.id) from public.profiles p
                        where p.id in ('19191919-0000-4000-8000-000000000019', '20202020-0000-4000-8000-000000000020',
                                       '21212121-0000-4000-8000-000000000021')$q$;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  execute q into snap;
  if snap is null or snap not like '%"role":"client"%' or snap not like '%"role":"admin"%' then
    raise exception 'FAIL R1 setup: fixture accounts not visible to a super admin: %', snap;
  end if;
  select updated_at into vc from public.profiles where id = c;
  select updated_at into vu from public.profiles where id = u;
  select updated_at into va from public.profiles where id = a;

  -- not an active admin: every write refused, through the functions and directly
  for r in select * from (values ('a1a1a1a1-0000-4000-8000-000000000001'), ('16161616-0000-4000-8000-000000000016'),
                                 ('17171717-0000-4000-8000-000000000017')) x(sub) loop
    perform set_config('request.jwt.claims', json_build_object('sub', r.sub)::text, true);
    perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, true, %L)', c, vc, 'Hacked', 'admin', null, '[]'), '42501');
    perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, vu, 'Renamed', 'user', null, '[]'), '42501');
    perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', a, va), '42501');
    perform public.zt_expect_error(format('update public.profiles set role = %L, super_admin = true where id = %L', 'admin', c), '42501');
  end loop;

  -- a plain admin
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', u, vu, 'ZT Edit User', 'admin', null, '[]'),
    '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, false, %L)', a, va, 'ZT Edit Admin', 'admin', null, '[]'),
    '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', a, va, 'ZT Edit Admin', 'user', null, '[]'),
    '42501', 'update_app_user: only a super admin%');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, vc, 'ZT Edit Client', 'client', 'ZT99', '[]'),
    '22023', '%unknown client code');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, vc, 'ZT Edit Client', 'client', null, '[]'),
    '22023', '%a client account needs a client code');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', c, vc - interval '1 second', 'Renamed', 'client', 'ZT02', '[]'),
    '40001', '%changed since it was read');
  perform public.zt_expect_error(format('update public.profiles set super_admin = true, can_confirm_payments = true where id = %L', u), '42501');

  -- a super admin without billing
  perform set_config('request.jwt.claims', '{"sub":"15151515-0000-4000-8000-000000000015"}', true);
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, true, %L)', a, va, 'ZT Edit Admin', 'admin', null, '[]'),
    '42501', 'update_app_user: only the billing owner%');

  execute q into after;
  if after is distinct from snap then
    raise exception 'FAIL R1: a refused write changed an account: before % after %', snap, after;
  end if;

  -- the billing owner: admin + super admin + billing, then demotion
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  va := auth.update_app_user(a, va, 'ZT Edit Admin', 'admin', null, true, true, '[]');
  if (select row(role::text, super_admin, can_confirm_payments)::text from public.profiles where id = a) <> '(admin,t,t)' then
    raise exception 'FAIL R1: billing owner grant';
  end if;
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, true, true, %L)', a, va, 'ZT Edit Admin', 'user', null, '[]'),
    '22023', 'update_app_user: super admin and billing apply only to admin accounts');
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, true, %L)', a, va, 'ZT Edit Admin', 'user', null, '[]'),
    '22023', 'update_app_user: super admin and billing apply only to admin accounts');
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', a, va, 'ZT Edit Admin', 'user', null, '[]'),
    '42501');
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  va := auth.update_app_user(a, va, 'ZT Edit Admin', 'user', null, false, false, '[]');
  if (select row(role::text, super_admin, can_confirm_payments, client_code)::text from public.profiles where id = a) <> '(user,f,f,)' then
    raise exception 'FAIL R1: demotion did not clear super admin and billing';
  end if;

  -- unknown account ids, every entry point
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select auth.update_app_user(%L, %L, %L, %L, %L, false, false, %L)', gen_random_uuid(), now(), 'x', 'user', null, '[]'),
    'P0002', 'update_app_user: no such account');
  perform public.zt_expect_error(format('select auth.set_app_user_status(%L, false, %L)', gen_random_uuid(), now()),
    'P0002', 'set_app_user_status: no such account');
  perform public.zt_expect_error(format('select * from auth.activate_app_user(%L)', gen_random_uuid()),
    'P0002', 'activate_app_user: no such account');
end $$;
\echo 'ok  R1 refused writes (client, production, inactive super admin, plain admin, super admin without billing, direct) leave accounts unchanged; billing owner grants, demotion clears; unknown ids refused'
