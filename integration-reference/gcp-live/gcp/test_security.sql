-- =====================================================================
-- GCP database security regression test -- DISPOSABLE TEST DATABASES ONLY
-- =====================================================================
-- Writes fixture rows (clients ZT01/ZT02, orders ZT-1/ZT-2, seven test
-- identities) into a freshly bootstrapped database, then checks:
--   * as the bootstrap admin: verify_bootstrap.sql, and the operator
--     session's historical NULL auth.uid();
--   * as the app login (\connect): no role switching or self-elevation, the
--     Firebase UID resolver, no UID enumeration, fail-closed missing claims
--     (fresh / reused / committed / rolled back / inside SECURITY DEFINER),
--     RLS isolation between clients, and the payment-confirmation,
--     payout / subscription, privilege-change and order-intake guards --
--     with normal claims and with a forged service_role claim role;
--   * account provisioning (auth.provision_app_user) through the app login:
--     who may provision what, forged claims, input validation, duplicates,
--     rollback, pending accounts and their client isolation;
--   * back as the bootstrap admin: what provisioning left behind, and that
--     02_post_migrate.sql re-applies cleanly with verify_bootstrap.sql green.
-- Every check raises 'FAIL ...' on a wrong outcome; under ON_ERROR_STOP the
-- first failure ends the run with a nonzero exit.
--
--   psql -v ON_ERROR_STOP=1 -v disposable_test_db=1 -v app_user=resolute_app \
--        -h <host> -U <bootstrap admin> -d <test db> -f gcp/test_security.sql
-- The \connect to the app login must authenticate without a prompt (a local
-- disposable database with trust auth, or PGPASSWORD for that one run).
-- =====================================================================
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

-- ── Operator (bootstrap admin) session ─────────────────────────────────────
do $$ begin
  if not exists (select 1 from pg_roles where rolname = session_user and (rolsuper or rolcreaterole)) then
    raise exception 'FAIL setup: run this as the bootstrap admin, not %', session_user;
  end if;
end $$;
\ir verify_bootstrap.sql
\echo 'ok  O1 verify_bootstrap.sql'

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
-- D-series (order documents, 02 section 10): ZT-3 is on ZT User's desk (single
-- seating, due at screening) and ZT-1 holds one stored examiner document, the
-- "another order's document". A test-only helper asserts an error's SQLSTATE
-- and message. All of it is removed again when the operator reconnects.
delete from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3');
insert into public.orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress,
                           completed_dates, completed_by, completed, workflow)
values ('ZT-3', 'ZT01', 'TX', 'Harris', 'Full Search', 'screening', 'user', '16161616-0000-4000-8000-000000000016', 15,
        '{}', '{}', null,
        '{"singleSeating": true, "stagePlan": {"screener": "16161616-0000-4000-8000-000000000016",
          "examiner": "16161616-0000-4000-8000-000000000016", "typer": "16161616-0000-4000-8000-000000000016",
          "delivery": "16161616-0000-4000-8000-000000000016"}}')
on conflict (id) do update set status = excluded.status, assigned_to = excluded.assigned_to,
  assigned_user_id = excluded.assigned_user_id, progress = excluded.progress, completed_dates = '{}',
  completed_by = '{}', completed = null, workflow = excluded.workflow;
insert into public.order_documents (id, order_id, kind, object_name, filename, content_type, size_bytes, sha256,
                                    status, stored_at, uploaded_by)
values ('dddddddd-0000-4000-8000-0000000000e1', 'ZT-1', 'examiner', 'orders/ZT-1/dddddddd-0000-4000-8000-0000000000e1',
        'other-order.pdf', 'application/pdf', 10, repeat('a', 64), 'stored', now(), 'c3c3c3c3-0000-4000-8000-000000000003');
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
-- C-series (messages, activity, notifications, 02 section 11): ZT-4 is a fresh
-- ZT01 order parked with Admin. Earlier runs' messages, events and
-- notifications of the ZT fixtures are cleared so the counts below are exact.
delete from public.notifications where recipient_id in (select id from public.profiles where email like 'zt-%@example.test');
delete from public.support_messages where client_code in ('ZT01', 'ZT02');
delete from public.order_events where order_id like 'ZT-%';
delete from public.orders where id = 'ZT-4';
insert into public.orders (id, client_code, state, county, type) values ('ZT-4', 'ZT01', 'TX', 'Travis', 'Full Search');

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

insert into public.vendors (code, name) values ('ZTV1', 'ZT Test Vendor') on conflict (code) do nothing;
insert into public.vendor_payouts (order_id, vendor_code, amount) values ('ZT-1', 'ZTV1', 10) on conflict (order_id) do nothing;
insert into public.subscriptions (id, name, amount) values ('ZT-SUB', 'ZT Test Subscription', 5) on conflict (id) do nothing;

-- O5: operator maintenance -- privilege columns and every paid/confirmed
-- action still work for the bootstrap admin (all rolled back).
do $$
declare stmt text; n int;
begin
  begin
    foreach stmt in array array[
      $s$update public.profiles set role = 'admin', can_confirm_payments = true where id = 'a1a1a1a1-0000-4000-8000-000000000001'$s$,
      $s$update public.orders set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', '{"status":"confirmed"}') where id = 'ZT-1'$s$,
      $s$update public.vendor_payouts set status = 'paid', paid_by = 'zt-operator', paid_at = current_date where order_id = 'ZT-1'$s$,
      $s$update public.subscriptions set last_paid_at = current_date, paid_by = 'zt-operator' where id = 'ZT-SUB'$s$] loop
      execute stmt;
      get diagnostics n = row_count;
      if n <> 1 then raise exception 'FAIL O5: operator maintenance affected % rows: %', n, stmt; end if;
    end loop;
    raise exception using errcode = 'ZT999';   -- discard
  exception when sqlstate 'ZT999' then null;
  end;
end $$;
\echo 'ok  O5 operator maintenance: privilege columns, payment confirmation, payout and subscription paid'

-- O6: why pg_temp must come last (operator session, which keeps TEMP; all
-- rolled back). A temporary table shadows a same-named public table inside a
-- definer function pinned to `search_path = public`, but not inside one pinned
-- to `pg_catalog, public, pg_temp` -- the path every definer function now has.
do $$
declare n_hardened bigint; n_legacy bigint;
begin
  begin
    create table public.zt_shadow_probe (x int);
    insert into public.zt_shadow_probe values (1);
    create temp table zt_shadow_probe (x int);
    insert into pg_temp.zt_shadow_probe values (1), (2), (3), (4), (5);
    create function public.zt_probe_hardened() returns bigint language sql security definer
      set search_path = pg_catalog, public, pg_temp as 'select count(*) from zt_shadow_probe';
    create function public.zt_probe_legacy() returns bigint language sql security definer
      set search_path = public as 'select count(*) from zt_shadow_probe';
    n_hardened := public.zt_probe_hardened();
    n_legacy := public.zt_probe_legacy();
    raise exception using errcode = 'ZT999';   -- discard every probe object
  exception when sqlstate 'ZT999' then null;
  end;
  if n_hardened is distinct from 1 or n_legacy is distinct from 5 then
    raise exception 'FAIL O6: hardened path read % rows, legacy path read % (expected 1 and 5)', n_hardened, n_legacy;
  end if;
end $$;
\echo 'ok  O6 pg_temp last: a temporary table shadows the legacy search_path but not the hardened one'

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

-- L4: missing / empty / malformed claims fail closed -- on this reused
-- connection (claims are now '' after L3 committed), as authenticated and
-- anon, and inside the migrations' SECURITY DEFINER functions.
do $$
declare c text; stmt text; rl text;
begin
  foreach rl in array array['authenticated', 'anon'] loop
    execute format('set local role %I', rl);
    foreach c in array array['', '{}', '{"sub":""}', '{"sub":null}', '[]', '"x"', '{"role":"authenticated"}'] loop
      perform set_config('request.jwt.claims', c, true);
      foreach stmt in array array[
        'select auth.uid()',
        'select count(*) from public.orders',
        'select count(*) from public.profiles'] loop
        begin
          execute stmt;
          raise exception 'FAIL L4: % with claims % ran: %', rl, quote_literal(c), stmt;
        exception when insufficient_privilege then
          -- either refusal is closed: the identity check, or no table grant at all
          if sqlerrm not like 'auth.uid(): no authenticated identity%'
             and sqlerrm not like 'permission denied%' then raise; end if;
        end;
      end loop;
    end loop;
  end loop;

  set local role authenticated;
  perform set_config('request.jwt.claims', '', true);
  foreach stmt in array array[
    'select public.can_confirm_payments()',
    'select public.my_role()',
    'select public.is_staff()',
    $s$update public.profiles set name = name where id = 'a1a1a1a1-0000-4000-8000-000000000001'$s$,
    $s$update public.orders set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', '{"status":"confirmed"}') where id = 'ZT-1'$s$] loop
    begin
      execute stmt;
      raise exception 'FAIL L4: no claims, but ran: %', stmt;
    exception when insufficient_privilege then
      if sqlerrm not like 'auth.uid(): no authenticated identity%' then raise; end if;
    end;
  end loop;

  foreach c in array array['{not json', '{"sub":"not-a-uuid"}', '{"sub":"zt-fb-client-a"}'] loop
    perform set_config('request.jwt.claims', c, true);
    begin
      perform auth.uid();
      raise exception 'FAIL L4: malformed claims % produced an identity', quote_literal(c);
    exception when invalid_text_representation then null;
    end;
  end loop;
end $$;
\echo 'ok  L4 missing/empty/malformed claims fail closed (authenticated, anon, inside SECURITY DEFINER guards)'

-- L5: a committed request, then a rolled-back one, leave nothing behind.
do $$ begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if auth.uid() <> 'a1a1a1a1-0000-4000-8000-000000000001' then
    raise exception 'FAIL L5: claims not honoured';
  end if;
end $$;
begin;
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true) is not null;
rollback;
do $$ begin
  if current_user <> session_user
     or coalesce(pg_catalog.current_setting('request.jwt.claims', true), '') <> '' then
    raise exception 'FAIL L5: state leaked: current_user=%, claims=%', current_user,
      pg_catalog.current_setting('request.jwt.claims', true);
  end if;
  set local role authenticated;
  begin
    perform auth.uid();
  exception when insufficient_privilege then return;
  end;
  raise exception 'FAIL L5: identity survived the end of its transaction';
end $$;
\echo 'ok  L5 after commit and after rollback: role and claims reset, auth.uid() fails closed'

-- L6: cross-client isolation (orders, profiles, clients; reads and writes).
do $$
declare
  ids   uuid[] := array['a1a1a1a1-0000-4000-8000-000000000001', 'b2b2b2b2-0000-4000-8000-000000000002'];
  own   text[] := array['ZT01', 'ZT02'];
  other text[] := array['ZT02', 'ZT01'];
  i int; n int; m int;
begin
  set local role authenticated;
  for i in 1..2 loop
    perform set_config('request.jwt.claims', json_build_object('sub', ids[i])::text, true);
    select count(*), count(*) filter (where client_code is distinct from own[i]) into n, m from public.orders;
    if n = 0 or m <> 0 then
      raise exception 'FAIL L6: client % sees % orders, % of another client', own[i], n, m;
    end if;
    select count(*) into m from public.profiles where id <> ids[i];
    if m <> 0 then raise exception 'FAIL L6: client % sees % other profiles', own[i], m; end if;
    select count(*) into m from public.clients where code <> own[i];
    if m <> 0 then raise exception 'FAIL L6: client % sees % other clients', own[i], m; end if;
    with u as (update public.orders set priority = priority where client_code = other[i] returning 1)
      select count(*) into m from u;
    if m <> 0 then raise exception 'FAIL L6: client % updated % orders of %', own[i], m, other[i]; end if;
    with u as (update public.profiles set name = name where id <> ids[i] returning 1)
      select count(*) into m from u;
    if m <> 0 then raise exception 'FAIL L6: client % updated % other profiles', own[i], m; end if;
    begin
      insert into public.orders (id, client_code, state, county, type)
        values ('ZT-X' || i, other[i], 'TX', 'Harris', 'Full Search');
      raise exception 'FAIL L6: client % inserted an order for %', own[i], other[i];
    exception when insufficient_privilege then null;
    end;
  end loop;
  -- client PII: a non-super admin sees no client rows
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select count(*) from public.clients) <> 0 then
    raise exception 'FAIL L6: non-super admin sees client PII';
  end if;
end $$;
\echo 'ok  L6 RLS: each client sees/updates only its own orders and profile, cannot insert for the other; PII hidden'

-- L7: payment confirmation by editing the order -- the client's write is a
-- no-op, the non-billing admin is refused by the confirmation guard, and the
-- billing owner by the payment-write guard: a confirmation goes through
-- payment_verify() only (Y-series, the positive control).
do $$
declare
  confirm constant text := $q$update public.orders set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', '{"status":"confirmed"}') where id = 'ZT-1'$q$;
  n int; msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  n := null; msg := null;
  begin execute confirm; get diagnostics n = row_count;
  exception when others then msg := sqlerrm; end;
  if n > 0 then raise exception 'FAIL L7: client confirmed its own payment'; end if;

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  n := null; msg := null;
  begin execute confirm; get diagnostics n = row_count;
  exception when others then msg := sqlerrm; end;
  if msg is null or msg not like 'only the billing owner%' then
    raise exception 'FAIL L7: non-billing admin: rows=%, error=%', n, msg;
  end if;

  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  n := null; msg := null;
  begin execute confirm; get diagnostics n = row_count;
  exception when others then msg := sqlerrm; end;
  if n is not null or msg is null or msg not like 'payments: a payment is reported by the client%' then
    raise exception 'FAIL L7: billing owner edited a payment directly: rows=%, error=%', n, msg;
  end if;
end $$;
\echo 'ok  L7 payment confirmation by editing the order: client no-op, non-billing admin and billing owner refused by the guards'

-- L8: privilege columns -- nobody changes them through the app login. The
--     column privilege refuses first (section 8); O9 shows the guard behind it.
do $$
declare who uuid; n int; msg text;
begin
  set local role authenticated;
  foreach who in array array['a1a1a1a1-0000-4000-8000-000000000001'::uuid,   -- the account holder
                             'c3c3c3c3-0000-4000-8000-000000000003',         -- an admin
                             'd4d4d4d4-0000-4000-8000-000000000004'] loop    -- a super admin
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    n := 0; msg := null;
    begin
      update public.profiles set role = 'admin', super_admin = true
       where id = 'a1a1a1a1-0000-4000-8000-000000000001';
      get diagnostics n = row_count;
    exception when others then msg := sqlerrm;
    end;
    if n > 0 or (msg is not null and msg not like '%set by an administrator%'
                   and msg not like 'permission denied for table profiles%') then
      raise exception 'FAIL L8: % -> rows=%, error=%', who, n, msg;
    end if;
    raise notice 'L8 % refused by %', who, coalesce(left(msg, 45), 'RLS (0 rows)');
  end loop;
end $$;
\echo 'ok  L8 privilege columns: account holder, admin and super admin all refused'

-- L9: order intake is service_role-only -- not callable through this login.
do $$
declare rl text;
begin
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  foreach rl in array array['authenticated', 'anon', session_user::text] loop
    begin
      execute format('set local role %I', rl);
      perform public.intake_create_order('{}'::jsonb);
      raise exception 'FAIL L9: % could call intake_create_order', rl;
    exception when insufficient_privilege then null;
    end;
  end loop;
end $$;
\echo 'ok  L9 intake_create_order: denied to authenticated, anon and the app login'

-- L10: a forged claim role (request.jwt.claim.role = service_role) grants
-- nothing -- not payment confirmation, not paid payouts / subscriptions, not
-- privilege columns -- for a client, a non-billing admin or the billing owner.
do $$
declare
  who   record;
  stmt  text;
  n     int;
  msg   text;
begin
  set local role authenticated;
  for who in select * from (values
      ('a1a1a1a1-0000-4000-8000-000000000001'::uuid, false, 'client'),
      ('c3c3c3c3-0000-4000-8000-000000000003'::uuid, false, 'admin'),
      ('d4d4d4d4-0000-4000-8000-000000000004'::uuid, true,  'billing owner')) v(id, billing, label) loop
    perform set_config('request.jwt.claims', json_build_object('sub', who.id)::text, true);
    perform set_config('request.jwt.claim.role', 'service_role', true);

    if public.can_confirm_payments() is distinct from who.billing then
      raise exception 'FAIL L10: forged claim role changed can_confirm_payments() for %', who.label;
    end if;

    n := 0; msg := null;
    begin
      update public.profiles set role = 'admin', super_admin = true, can_confirm_payments = true
       where id = 'a1a1a1a1-0000-4000-8000-000000000001';
      get diagnostics n = row_count;
    exception when others then msg := sqlerrm;
    end;
    if n > 0 or (msg is not null and msg not like '%set by an administrator%'
                   and msg not like 'permission denied for table profiles%') then
      raise exception 'FAIL L10: % changed privilege columns with a forged claim (rows=%, error=%)', who.label, n, msg;
    end if;

    if not who.billing then
      foreach stmt in array array[
        $s$update public.orders set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{payment}', '{"status":"confirmed"}') where id = 'ZT-1'$s$,
        $s$update public.vendor_payouts set status = 'paid', paid_by = 'zt-forged', paid_at = current_date where order_id = 'ZT-1'$s$,
        $s$update public.subscriptions set last_paid_at = current_date, paid_by = 'zt-forged' where id = 'ZT-SUB'$s$] loop
        n := 0; msg := null;
        begin
          execute stmt;
          get diagnostics n = row_count;
        exception when others then msg := sqlerrm;
        end;
        if n > 0 then
          raise exception 'FAIL L10: % with a forged claim ran: %', who.label, stmt;
        end if;
        -- the admin passes RLS, so its refusal must come from the billing guard
        if (who.label = 'admin' and (msg is null or msg not like 'only the billing owner%'))
           or (msg is not null and msg not like 'only the billing owner%') then
          raise exception 'FAIL L10: % -> rows=%, error=%', who.label, n, msg;
        end if;
      end loop;
    end if;
  end loop;
end $$;
\echo 'ok  L10 forged service_role claim: no payment, payout, subscription or privilege-column bypass'

-- L11: payouts and subscriptions -- the non-billing admin is refused by the
-- guard; the billing owner may mark them paid (rolled back).
do $$
declare
  money constant text[] := array[
    $s$update public.vendor_payouts set status = 'paid', paid_by = 'zt-test', paid_at = current_date where order_id = 'ZT-1'$s$,
    $s$update public.subscriptions set last_paid_at = current_date, paid_by = 'zt-test' where id = 'ZT-SUB'$s$];
  stmt text; n int; msg text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  foreach stmt in array money loop
    n := 0; msg := null;
    begin
      execute stmt;
      get diagnostics n = row_count;
    exception when others then msg := sqlerrm;
    end;
    if msg is null or msg not like 'only the billing owner%' then
      raise exception 'FAIL L11: non-billing admin -> rows=%, error=% for %', n, msg, stmt;
    end if;
  end loop;

  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  foreach stmt in array money loop
    n := null; msg := null;
    begin
      execute stmt;
      get diagnostics n = row_count;
      raise exception using errcode = 'ZT999';   -- discard the positive control
    exception when sqlstate 'ZT999' then null;
              when others then msg := sqlerrm;
    end;
    if n is distinct from 1 then
      raise exception 'FAIL L11: billing owner could not run % (%)', stmt, msg;
    end if;
  end loop;
end $$;
\echo 'ok  L11 payouts/subscriptions: non-billing admin refused by guard, billing owner allowed'

-- L12: ordinary profile edits still work -- the account holder and an admin
-- may change a non-protected column (rolled back).
do $$
declare who uuid; n int;
begin
  set local role authenticated;
  foreach who in array array['a1a1a1a1-0000-4000-8000-000000000001'::uuid,
                             'c3c3c3c3-0000-4000-8000-000000000003'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    n := null;
    begin
      update public.profiles set name = 'ZT Client A (edited)' where id = 'a1a1a1a1-0000-4000-8000-000000000001';
      get diagnostics n = row_count;
      raise exception using errcode = 'ZT999';
    exception when sqlstate 'ZT999' then null;
    end;
    if n is distinct from 1 then
      raise exception 'FAIL L12: % could not make an ordinary profile edit', who;
    end if;
  end loop;
end $$;
\echo 'ok  L12 ordinary profile edits: account holder and admin still allowed'

-- L13: the app login cannot create temporary objects -- as itself, or after
-- SET ROLE authenticated / anon -- so it has nothing to plant in pg_temp.
do $$
declare rl text; stmt text;
begin
  foreach rl in array array[session_user::text, 'authenticated', 'anon'] loop
    foreach stmt in array array['create temp table zt_tmp (x int)',
                                'create table pg_temp.zt_tmp2 (x int)',
                                $s$create type pg_temp.user_role as enum ('admin')$s$] loop
      begin
        execute format('set local role %I', rl);
        execute stmt;
        raise exception 'FAIL L13: % could run: %', rl, stmt;
      exception when insufficient_privilege then null;
      end;
    end loop;
  end loop;
end $$;
\echo 'ok  L13 no temporary tables or types for the app login, authenticated or anon'

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

-- ── Order documents (02 section 10) ──────────────────────────────────────────
-- D1: nobody writes the table directly; who may start an upload, and of what.
do $$
declare
  who uuid;
  bad text;
begin
  set local role authenticated;
  foreach who in array array['a1a1a1a1-0000-4000-8000-000000000001', 'c3c3c3c3-0000-4000-8000-000000000003',
                             '16161616-0000-4000-8000-000000000016']::uuid[] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    perform public.zt_expect_error($s$insert into public.order_documents (order_id, kind, object_name, filename, content_type, uploaded_by)
      values ('ZT-3', 'client', 'orders/ZT-3/x', 'x.pdf', 'application/pdf', auth.uid())$s$, '42501');
    perform public.zt_expect_error($s$update public.order_documents set status = 'stored'$s$, '42501');
    perform public.zt_expect_error($s$delete from public.order_documents$s$, '42501');
  end loop;
  -- a client: its own attachments on its own open orders only
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'examiner', 'x.pdf', 'application/pdf')$s$, '42501');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-2', 'client', 'x.pdf', 'application/pdf')$s$, 'P0002');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-404', 'client', 'x.pdf', 'application/pdf')$s$, 'P0002');
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'client', 'x.pdf', 'application/pdf')$s$, 'P0002');
  -- a production user: the due stage's documents, on an order on their own desk
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'examiner', 'x.pdf', 'application/pdf')$s$, '42501');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'client', 'x.pdf', 'application/pdf')$s$, '42501');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-1', 'screener', 'x.pdf', 'application/pdf')$s$, '42501');
  -- names, kinds and types (an admin, who may otherwise add anything)
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  foreach bad in array array['../x.pdf', 'a/b.pdf', 'a\b.pdf', '.hidden.pdf', repeat('x', 201), e'x\n.pdf', ''] loop
    perform public.zt_expect_error(format('select * from public.document_begin_upload(%L, %L, %L, %L)', 'ZT-3', 'client', bad, 'application/pdf'),
                                   '22023', '%invalid file name%');
  end loop;
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'malware', 'x.pdf', 'application/pdf')$s$, '22023');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'commitment', 'x.doc', 'application/msword')$s$, '22023');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'screener', 'x.png', 'image/png')$s$, '22023');
  perform public.zt_expect_error($s$select * from public.document_begin_upload('ZT-3', 'client', 'x.html', 'text/html')$s$, '22023');
end $$;
\echo 'ok  D1 order documents: no direct writes; uploads only by role, own order and due stage; names, kinds and types validated'

-- D2: server-named objects; only the uploader finishes, with the declared type,
--     a real size and checksum; a client attachment is listed on the order from
--     the stored row; RLS shows stored documents to staff, a client only its own
--     attachments, and nothing to another client; an unfinished upload is failed
--     by its uploader only and stays invisible.
do $$
declare
  v_client uuid; o_client text; v_screen uuid; v_pend uuid; w jsonb; n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  select out_id, out_object_name into v_client, o_client
    from public.document_begin_upload('ZT-3', 'client', 'zt-client.pdf', 'application/pdf');
  if o_client is distinct from 'orders/ZT-3/' || v_client then
    raise exception 'FAIL D2: object name % is not server-generated', o_client;
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 10, %L, %L)', v_client, repeat('a', 64), 'application/pdf'), 'P0002');
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 10, %L, %L)', v_client, repeat('a', 64), 'application/msword'), '22023');
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 0, %L, %L)', v_client, repeat('a', 64), 'application/pdf'), '22023');
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 26214401, %L, %L)', v_client, repeat('a', 64), 'application/pdf'), '22023');
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 10, %L, %L)', v_client, 'not-a-checksum', 'application/pdf'), '22023');
  perform public.document_finish_upload(v_client, 1234, repeat('b', 64), 'application/pdf');
  perform public.zt_expect_error(format('select * from public.document_finish_upload(%L, 10, %L, %L)', v_client, repeat('a', 64), 'application/pdf'), '55000');
  select workflow into w from public.orders where id = 'ZT-3';
  if w -> 'clientDocs' is distinct from jsonb_build_array(jsonb_build_object('id', v_client, 'documentId', v_client,
       'name', 'zt-client.pdf', 'size', 1234, 'status', 'done', 'type', 'pdf')) then
    raise exception 'FAIL D2: client attachment listed as %', w -> 'clientDocs';
  end if;

  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  select out_id into v_screen from public.document_begin_upload('ZT-3', 'screener', 'zt-screen.pdf', 'application/pdf');
  perform public.document_finish_upload(v_screen, 2048, repeat('c', 64), 'application/pdf');
  select out_id into v_pend from public.document_begin_upload('ZT-3', 'screener', 'zt-pending.pdf', 'application/pdf');
  select count(*) into n from public.order_documents where order_id = 'ZT-3';
  if n <> 2 then raise exception 'FAIL D2: production user sees % ZT-3 documents (expected the 2 stored)', n; end if;

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select count(*) from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3')) <> 3 then
    raise exception 'FAIL D2: admin does not see exactly the 3 stored documents';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(filename, ',') from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3')) is distinct from 'zt-client.pdf' then
    raise exception 'FAIL D2: client sees %', (select string_agg(filename, ',') from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3'));
  end if;
  perform public.zt_expect_error(format('select public.document_fail_upload(%L)', v_pend), 'P0002');
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if (select count(*) from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3')) <> 0 then
    raise exception 'FAIL D2: another client sees ZT01 documents';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if public.document_fail_upload(v_pend) is distinct from 'orders/ZT-3/' || v_pend then
    raise exception 'FAIL D2: failing an upload did not return its object';
  end if;
  if exists (select 1 from public.order_documents where id = v_pend) then
    raise exception 'FAIL D2: a failed upload is visible';
  end if;
end $$;
\echo 'ok  D2 server-named objects; uploader-only finish with type, size and checksum; client attachment listed from the row; RLS per role; failed uploads invisible'

-- D3: a workflow refers only to a stored document of that order and stage,
--     rewritten from the table; the examiner stage needs its document; a
--     completed stage's document is frozen.
do $$
declare
  today  text := to_char(current_date, 'YYYY-MM-DD');
  v_screen uuid; v_pend uuid; bad jsonb; w jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  select id into v_screen from public.order_documents where order_id = 'ZT-3' and filename = 'zt-screen.pdf';
  foreach bad in array array['{"path": "orders/ZT-3/forged.pdf", "name": "x.pdf", "status": "done"}'::jsonb,
                             '{"documentId": "dddddddd-0000-4000-8000-0000000000e1"}'::jsonb,
                             jsonb_build_object('documentId', gen_random_uuid()), '"orders/ZT-3/x"'::jsonb] loop
    perform public.zt_expect_error(format($s$update public.orders set status = 'examining', completed_dates = jsonb_build_object('screener', %L),
      workflow = workflow || jsonb_build_object('screenerDoc', %L::jsonb) where id = 'ZT-3'$s$, today, bad), 'P0001', '%screenerDoc must reference%');
  end loop;
  update public.orders set status = 'examining', completed_dates = jsonb_build_object('screener', today),
         workflow = workflow || jsonb_build_object('screenerDoc', jsonb_build_object('documentId', v_screen,
           'name', 'evil.html', 'url', 'https://evil.example/x', 'path', '../../etc/passwd', 'size', 1))
   where id = 'ZT-3';
  select workflow into w from public.orders where id = 'ZT-3';
  if w -> 'screenerDoc' is distinct from jsonb_build_object('id', v_screen, 'documentId', v_screen, 'name', 'zt-screen.pdf',
       'size', 2048, 'status', 'done', 'type', 'pdf') then
    raise exception 'FAIL D3: screener reference not rewritten from the table: %', w -> 'screenerDoc';
  end if;

  perform public.zt_expect_error(format($s$update public.orders set status = 'typing', completed_dates = completed_dates || jsonb_build_object('examiner', %L)
    where id = 'ZT-3'$s$, today), 'P0001', '%requires its researched document%');
  foreach bad in array array[jsonb_build_object('documentId', v_screen), '{"documentId": "dddddddd-0000-4000-8000-0000000000e1"}'::jsonb] loop
    perform public.zt_expect_error(format($s$update public.orders set status = 'typing', completed_dates = completed_dates || jsonb_build_object('examiner', %L),
      workflow = workflow || jsonb_build_object('examinerDoc', %L::jsonb) where id = 'ZT-3'$s$, today, bad), 'P0001', '%examinerDoc must reference%');
  end loop;
  select out_id into v_pend from public.document_begin_upload('ZT-3', 'examiner', 'zt-exam.pdf', 'application/pdf');
  perform public.zt_expect_error(format($s$update public.orders set status = 'typing', completed_dates = completed_dates || jsonb_build_object('examiner', %L),
    workflow = workflow || jsonb_build_object('examinerDoc', jsonb_build_object('documentId', %L)) where id = 'ZT-3'$s$, today, v_pend),
    'P0001', '%examinerDoc must reference%');
  perform public.document_finish_upload(v_pend, 4096, repeat('d', 64), 'application/pdf');
  update public.orders set status = 'typing', completed_dates = completed_dates || jsonb_build_object('examiner', today),
         workflow = workflow || jsonb_build_object('examinerDoc', jsonb_build_object('documentId', v_pend))
   where id = 'ZT-3';
  perform public.zt_expect_error($s$update public.orders set workflow = workflow || '{"examinerDoc": null}' where id = 'ZT-3'$s$, 'P0001', '%stage is complete%');
  perform public.zt_expect_error($s$update public.orders set workflow = workflow - 'screenerDoc' where id = 'ZT-3'$s$, 'P0001', '%stage is complete%');
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format($s$update public.orders set workflow = workflow || jsonb_build_object('examinerDoc', jsonb_build_object('documentId', %L)) where id = 'ZT-3'$s$,
    'dddddddd-0000-4000-8000-0000000000e1'), 'P0001', '%stage is complete%');
  perform public.zt_expect_error($s$update public.orders set workflow = workflow || '{"clientDocs": [{"documentId": "dddddddd-0000-4000-8000-0000000000e1"}]}' where id = 'ZT-3'$s$,
    'P0001', '%clientDocs must be a list of stored client documents%');
  perform public.zt_expect_error($s$insert into public.orders (id, client_code, state, county, type, workflow)
    values ('ZT-X9', 'ZT01', 'TX', 'Harris', 'Full Search', '{"examinerDoc": {"documentId": "dddddddd-0000-4000-8000-0000000000e1"}}')$s$,
    'P0001', '%cannot carry documents%');
end $$;
\echo 'ok  D3 workflow documents: forged paths, other orders'' and unfinished documents refused; references rewritten from the table; examiner needs its document; completed stages frozen'

-- D4: typing needs the Title Search Document; removal rules; the client sees
--     its order's current title commitment and nothing internal.
do $$
declare
  today text := to_char(current_date, 'YYYY-MM-DD');
  v_title uuid; v_supp uuid; v_c1 uuid; v_c2 uuid; v_exam uuid; v_screen uuid; v_client uuid; v_adm uuid; o text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  select id into v_exam from public.order_documents where order_id = 'ZT-3' and kind = 'examiner';
  select id into v_screen from public.order_documents where order_id = 'ZT-3' and kind = 'screener';
  select id into v_client from public.order_documents where order_id = 'ZT-3' and kind = 'client';
  perform public.zt_expect_error(format($s$update public.orders set status = 'delivery', completed_dates = completed_dates || jsonb_build_object('typer', %L) where id = 'ZT-3'$s$, today),
    'P0001', '%Title Search Document%');
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_exam), '55000');
  select out_id into v_title from public.document_begin_upload('ZT-3', 'title_search', 'zt-title.docx',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  perform public.document_finish_upload(v_title, 5000, repeat('e', 64), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  select out_id into v_supp from public.document_begin_upload('ZT-3', 'supplementary', 'zt-supp.pdf', 'application/pdf');
  perform public.document_finish_upload(v_supp, 6000, repeat('f', 64), 'application/pdf');
  -- an unreferenced document of the current stage: its uploader may remove it
  o := public.document_begin_delete(v_supp);
  if o is distinct from 'orders/ZT-3/' || v_supp then raise exception 'FAIL D4: begin_delete returned %', o; end if;
  perform public.document_finish_delete(v_supp);
  if exists (select 1 from public.order_documents where id = v_supp) then raise exception 'FAIL D4: deleted document still visible'; end if;
  select out_id into v_c1 from public.document_begin_upload('ZT-3', 'commitment', 'zt-commitment.pdf', 'application/pdf');
  perform public.document_finish_upload(v_c1, 7000, repeat('1', 64), 'application/pdf');
  select out_id into v_c2 from public.document_begin_upload('ZT-3', 'commitment', 'zt-draft.pdf', 'application/pdf');
  perform public.document_finish_upload(v_c2, 7001, repeat('2', 64), 'application/pdf');
  update public.orders set status = 'delivery', completed_dates = completed_dates || jsonb_build_object('typer', today),
         workflow = workflow || jsonb_build_object('commitmentDoc', jsonb_build_object('documentId', v_c1))
   where id = 'ZT-3';
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_title), '55000');

  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(filename, ',' order by filename) from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3')) is distinct from 'zt-client.pdf,zt-commitment.pdf' then
    raise exception 'FAIL D4: client sees %', (select string_agg(filename, ',' order by filename) from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3'));
  end if;
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_screen), 'P0002');
  o := public.document_begin_delete(v_client);
  perform public.document_finish_delete(v_client);
  if (select workflow -> 'clientDocs' from public.orders where id = 'ZT-3') is distinct from '[]'::jsonb then
    raise exception 'FAIL D4: removed attachment still listed';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_c1), 'P0002');

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_screen), '55000');
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_c1), '55000');
  select out_id into v_adm from public.document_begin_upload('ZT-3', 'client', 'zt-admin-added.pdf', 'application/pdf');
  perform public.document_finish_upload(v_adm, 100, repeat('3', 64), 'application/pdf');
  perform public.document_begin_delete(v_adm);
  if exists (select 1 from public.order_documents where id = v_adm) then raise exception 'FAIL D4: a document being removed is visible'; end if;
  perform public.document_abort_delete(v_adm);
  if not exists (select 1 from public.order_documents where id = v_adm) then raise exception 'FAIL D4: aborted removal did not restore the document'; end if;
  perform public.zt_expect_error(format('select public.document_finish_delete(%L)', v_adm), 'P0002');
end $$;
\echo 'ok  D4 typing needs the Title Search Document; completed-stage and referenced documents cannot be removed; removal is uploader/admin-only and abortable; the client sees its attachments and the current commitment only'

-- ── Messages, activity trail, notifications (02 section 11) ─────────────────
-- C1: no application role writes the trail or notifications, reads the actor's
--     id or email, rewrites or deletes a message, names a message's author,
--     sends an attachment, or calls the internal helpers.
do $$
declare who uuid;
begin
  set local role authenticated;
  foreach who in array array['a1a1a1a1-0000-4000-8000-000000000001', 'c3c3c3c3-0000-4000-8000-000000000003',
                             '16161616-0000-4000-8000-000000000016']::uuid[] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    perform public.zt_expect_error($s$insert into public.order_events (order_id, kind, action, audience) values ('ZT-4', 'order.placed', 'forged', 'all')$s$, '42501');
    perform public.zt_expect_error($s$update public.order_events set action = 'rewritten'$s$, '42501');
    perform public.zt_expect_error($s$delete from public.order_events$s$, '42501');
    perform public.zt_expect_error($s$select actor_email from public.order_events$s$, '42501');
    perform public.zt_expect_error($s$select actor_id from public.order_events$s$, '42501');
    perform public.zt_expect_error($s$insert into public.notifications (recipient_id, kind, title, dedupe_key) values (auth.uid(), 'order.new', 'x', 'x')$s$, '42501');
    perform public.zt_expect_error($s$update public.notifications set read_at = now()$s$, '42501');
    perform public.zt_expect_error($s$delete from public.notifications$s$, '42501');
    perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body, author) values ('ZT-4', 'support', 'x', 'ZT Admin')$s$, '42501');
    perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body, author_id) values ('ZT-4', 'support', 'x', 'c3c3c3c3-0000-4000-8000-000000000003')$s$, '42501');
    perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body, attachment) values ('ZT-4', 'client', 'x', '{"name": "x.pdf"}')$s$, '42501');
    perform public.zt_expect_error($s$update public.support_messages set body = 'rewritten'$s$, '42501');
    perform public.zt_expect_error($s$delete from public.support_messages$s$, '42501');
    perform public.zt_expect_error($s$select public.activity_record('ZT-4', 'order.placed', 'all', 'forged')$s$, '42501');
    perform public.zt_expect_error($s$select public.notify_profiles(array[auth.uid()], 'order.new', 'ZT-4', 'order', 'x', null, 'x')$s$, '42501');
  end loop;
end $$;
\echo 'ok  C1 activity, notifications and messages: no direct writes, no actor ids or emails, no authored or attached messages, no helper calls'

-- C2: messages -- sender, author, client code and time come from the caller's
--     own profile and the order; RLS decides who may write what; a retried
--     request id adds nothing; reads follow the client / internal split.
do $$
declare
  m   public.support_messages;
  n   int;
  rid uuid := gen_random_uuid();
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  insert into public.support_messages (order_id, client_code, sender, visibility, body, request_id)
  values ('ZT-4', 'ZT02', 'support', 'client', E'  <b>Hello</b> from A\n  ', rid) returning * into m;
  if m.sender <> 'client' or m.client_code <> 'ZT01' or m.author <> 'ZT Client A' or m.author_id <> auth.uid()
     or m.body <> '<b>Hello</b> from A' or m.created_at is null then
    raise exception 'FAIL C2: client message stored as %', row_to_json(m);
  end if;
  insert into public.support_messages (order_id, sender, body, request_id) values ('ZT-4', 'client', 'again', rid)
  on conflict (author_id, request_id) where request_id is not null do nothing;
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'FAIL C2: a retried request id stored a second message'; end if;
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body) values ('ZT-2', 'client', 'x')$s$, 'P0002');
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body) values ('ZT-404', 'client', 'x')$s$, 'P0002');
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-4', 'client', 'internal', 'x')$s$, '42501');
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, body) values ('ZT-4', 'client', '   ')$s$, '22023', '%1 to 4000%');
  perform public.zt_expect_error(format('insert into public.support_messages (order_id, sender, body) values (%L, %L, %L)', 'ZT-4', 'client', repeat('x', 4001)), '22023', '%1 to 4000%');
  perform public.zt_expect_error(format('insert into public.support_messages (order_id, sender, body) values (%L, %L, %L)', 'ZT-4', 'client', E'bell\x07'), '22023', '%control%');
  insert into public.support_messages (client_code, sender, body) values ('ZT02', 'client', 'A general question') returning * into m;
  if m.client_code <> 'ZT01' or m.order_id is not null then raise exception 'FAIL C2: general message stored for %', m.client_code; end if;

  -- production: notes only, and only on their own work (ZT-3 is on ZT User's
  -- desk; ZT-4 is not, yet; a general conversation never is)
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-3', 'support', 'client', 'a production reply')$s$, '42501');
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-4', 'client', 'internal', 'not my order')$s$, '42501');
  perform public.zt_expect_error($s$insert into public.support_messages (client_code, sender, visibility, body) values ('ZT01', 'support', 'internal', 'general')$s$, 'P0002');   -- invisible to them: not found
  insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-3', 'client', 'internal', 'Checking the chain of title') returning * into m;
  if m.sender <> 'support' or m.author <> 'ZT User' then raise exception 'FAIL C2: production note stored as %', row_to_json(m); end if;
  perform public.zt_expect_error($s$insert into public.support_messages (client_code, sender, visibility, body) values ('ZT02', 'support', 'internal', 'x')$s$, 'P0002');

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-4', 'client', 'client', 'Reply from Admin') returning * into m;
  if m.sender <> 'support' or m.author <> 'ZT Admin' or m.client_code <> 'ZT01' then raise exception 'FAIL C2: admin reply stored as %', row_to_json(m); end if;
  insert into public.support_messages (client_code, sender, visibility, body) values ('ZT01', 'support', 'client', 'A general answer');
  perform public.zt_expect_error($s$insert into public.support_messages (client_code, sender, visibility, body) values ('ZT02', 'support', 'client', 'unsolicited')$s$, 'P0002');
  perform set_config('request.jwt.claims', '{"sub":"17171717-0000-4000-8000-000000000017"}', true);
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, sender, visibility, body) values ('ZT-4', 'support', 'internal', 'x')$s$, '42501');

  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select count(*) from public.support_messages where client_code in ('ZT01', 'ZT02')) <> 4
     or exists (select 1 from public.support_messages where visibility = 'internal') then
    raise exception 'FAIL C2: client A reads % messages (expected its 4 client-visible ones)', (select count(*) from public.support_messages);
  end if;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if (select count(*) from public.support_messages where client_code in ('ZT01', 'ZT02')) <> 0 then
    raise exception 'FAIL C2: client B reads ZT01 messages';
  end if;
  -- production reads its own work's thread only: ZT-3's note, not ZT-4's
  -- conversation (not its order) and not the general conversation
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if (select string_agg(coalesce(order_id, 'general') || ':' || visibility, ',') from public.support_messages where client_code = 'ZT01')
     is distinct from 'ZT-3:internal' then
    raise exception 'FAIL C2: production user reads %', (select string_agg(coalesce(order_id, 'general') || ':' || visibility, ',') from public.support_messages where client_code = 'ZT01');
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select count(*) from public.support_messages where client_code = 'ZT01') <> 5 then
    raise exception 'FAIL C2: admin reads % ZT01 messages (expected 5, the note included)', (select count(*) from public.support_messages where client_code = 'ZT01');
  end if;
end $$;
\echo 'ok  C2 messages: server-set sender, author and client code; only Admin answers a client; production reads and notes only its own work; retries idempotent; length, control characters and other clients refused'

-- C3: notifications -- each recipient told once, never the author, never an
--     inactive account or another client; read state belongs to the recipient.
do $$
declare v_id bigint; n int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select string_agg(kind || '/' || target, ',' order by id) from public.notifications where kind like 'message.%')
     is distinct from 'message.client/messages,message.client/support,message.note/messages' then
    raise exception 'FAIL C3: admin message notifications %', (select string_agg(kind || '/' || target, ',' order by id) from public.notifications where kind like 'message.%');
  end if;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  if (select count(*) from public.notifications where kind like 'message.%') <> 3 then
    raise exception 'FAIL C3: the second admin was not told about the client messages and the note';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"17171717-0000-4000-8000-000000000017"}', true);
  if exists (select 1 from public.notifications) then raise exception 'FAIL C3: an inactive admin was notified'; end if;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if exists (select 1 from public.notifications where order_id like 'ZT-%' or kind like 'message.%') then
    raise exception 'FAIL C3: client B was notified about ZT01';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(kind || '/' || title, ',' order by id) from public.notifications where kind like 'message.%')
     is distinct from 'message.reply/New message from Resolute on ZT-4,message.reply/New reply from Resolute Support' then
    raise exception 'FAIL C3: client A message notifications %', (select string_agg(kind || '/' || title, ',' order by id) from public.notifications where kind like 'message.%');
  end if;
  select min(id) into v_id from public.notifications where kind = 'message.reply';

  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if public.notifications_mark_read(array[v_id]) <> 0 then raise exception 'FAIL C3: client B marked client A''s notification read'; end if;
  perform public.notifications_mark_all_read();
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select read_at from public.notifications where id = v_id) is not null then raise exception 'FAIL C3: another user changed the read state'; end if;
  if public.notifications_mark_read(array[v_id]) <> 1 or public.notifications_mark_read(array[v_id]) <> 0 then
    raise exception 'FAIL C3: marking read is not exactly once';
  end if;
  n := public.notifications_mark_all_read();
  if n < 1 or exists (select 1 from public.notifications where read_at is null) then
    raise exception 'FAIL C3: mark all read left unread notifications';
  end if;
  perform public.zt_expect_error('select public.notifications_mark_read(null)', '22023');
end $$;
\echo 'ok  C3 notifications: recipients by role and order, never the author, an inactive account or another client; read state is the recipient''s alone'

-- C4: the activity trail comes from the committed change: actor and audience
--     set by the database, nothing from a rolled-back write, client actions by
--     the client RPCs recorded once, structurally; clients see their order's
--     client-facing events only.
do $$
declare n_ev int;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  update public.orders set workflow = workflow || '{"onHold": true, "holdReason": "Waiting for the county"}' where id = 'ZT-4';
  select count(*) into n_ev from public.order_events where order_id = 'ZT-4';
  begin
    update public.orders set clarification = 'pending', workflow = workflow || '{"clarificationNote": "never sent"}' where id = 'ZT-4';
    raise exception using errcode = 'ZT999';
  exception when sqlstate 'ZT999' then null;
  end;
  if (select count(*) from public.order_events where order_id = 'ZT-4') <> n_ev then
    raise exception 'FAIL C4: a rolled-back change left an event';
  end if;
  update public.orders set assigned_to = 'user', assigned_user_id = '16161616-0000-4000-8000-000000000016', status = 'screening'
   where id = 'ZT-4';
  update public.orders set workflow = workflow || '{"onHold": false}' where id = 'ZT-4';
  update public.orders set clarification = 'pending', workflow = workflow || '{"clarificationNote": "Please confirm the parcel number"}' where id = 'ZT-4';
end $$;
-- ...the client's actions, each its own transaction as through the API...
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if exists (select 1 from public.notifications where body like '%never sent%') then
    raise exception 'FAIL C4: a rolled-back change notified the client';
  end if;
  perform public.client_respond_clarification('ZT-4');
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if public.client_cancel_order('ZT-4') <> 'requested' then raise exception 'FAIL C4: cancel was not a request'; end if;
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  insert into public.support_messages (order_id, sender, body) values ('ZT-4', 'client', 'Following up on the parcel');
end $$;
-- ...and what everyone reads afterwards.
do $$
declare v text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  select string_agg(kind || '@' || audience, ',' order by id) into v from public.order_events where order_id = 'ZT-4';
  if v is distinct from 'order.placed@all,order.hold@all,order.resumed@all,order.clarification_requested@all,order.clarification_answered@all,order.cancel_requested@all' then
    raise exception 'FAIL C4: the client reads %', v;
  end if;
  if (select actor from public.order_events where order_id = 'ZT-4' and kind = 'order.clarification_answered') <> 'Client'
     or (select actor from public.order_events where order_id = 'ZT-4' and kind = 'order.hold') <> 'ZT Admin'
     or (select action from public.order_events where order_id = 'ZT-4' and kind = 'order.hold') <> 'ZT Admin put ZT-4 on hold — Waiting for the county' then
    raise exception 'FAIL C4: actors or actions are not the server''s';
  end if;
  if (select string_agg(kind, ',' order by id) from public.notifications where order_id = 'ZT-4' and kind like 'order.%')
     is distinct from 'order.hold,order.hold,order.clarification' then
    raise exception 'FAIL C4: client notifications %', (select string_agg(kind, ',' order by id) from public.notifications where order_id = 'ZT-4');
  end if;

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if exists (select 1 from public.order_events where order_id like 'ZT-%' and kind is null) then
    raise exception 'FAIL C4: a free-text event was stored';
  end if;
  if (select string_agg(kind, ',' order by id) from public.order_events where order_id = 'ZT-4') is distinct from
     'order.placed,order.hold,order.assigned,order.resumed,order.clarification_requested,order.clarification_answered,order.cancel_requested' then
    raise exception 'FAIL C4: admin reads %', (select string_agg(kind, ',' order by id) from public.order_events where order_id = 'ZT-4');
  end if;
  if (select action from public.order_events where order_id = 'ZT-4' and kind = 'order.assigned') <> 'ZT Admin assigned ZT-4 to ZT User (Screening)' then
    raise exception 'FAIL C4: assignment recorded as %', (select action from public.order_events where order_id = 'ZT-4' and kind = 'order.assigned');
  end if;
  if (select string_agg(kind, ',' order by id) from public.notifications where order_id = 'ZT-4' and kind like 'order.%')
     is distinct from 'order.new,order.clarification,order.cancel' then
    raise exception 'FAIL C4: admin notifications %', (select string_agg(kind, ',' order by id) from public.notifications where order_id = 'ZT-4' and kind like 'order.%');
  end if;
  update public.orders set workflow = workflow || '{"cancelRequested": null}' where id = 'ZT-4';

  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if (select string_agg(kind || '/' || title, ',' order by id) from public.notifications where order_id = 'ZT-4')
     is distinct from 'order.assigned/ZT-4 is on your desk,message.client/Client message on ZT-4' then
    raise exception 'FAIL C4: production notifications %', (select string_agg(kind || '/' || title, ',' order by id) from public.notifications where order_id = 'ZT-4');
  end if;
  -- ZT-4 is now ZT User's work: its conversation is readable (and only it)
  if (select count(*) from public.support_messages where order_id = 'ZT-4') <> 3 then
    raise exception 'FAIL C4: the new owner reads % ZT-4 messages (expected 3)', (select count(*) from public.support_messages where order_id = 'ZT-4');
  end if;
  -- ZT-3's documents and stage completions (D-series) are in its trail: staff
  -- see every one, the client only its own attachments.
  if not exists (select 1 from public.order_events where order_id = 'ZT-3' and kind = 'stage.completed' and actor = 'ZT User' and audience = 'staff')
     or not exists (select 1 from public.order_events where order_id = 'ZT-3' and kind = 'document.added' and meta ->> 'documentKind' = 'examiner')
     or not exists (select 1 from public.notifications where order_id = 'ZT-3' and kind = 'document.client') then
    raise exception 'FAIL C4: ZT-3 stage and document activity missing';
  end if;

  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(kind, ',' order by id) from public.notifications where order_id = 'ZT-4' and kind = 'order.cancel') <> 'order.cancel' then
    raise exception 'FAIL C4: the declined cancellation was not notified';
  end if;
  if exists (select 1 from public.order_events where order_id = 'ZT-3' and (audience = 'staff' or meta ->> 'documentKind' <> 'client'))
     or not exists (select 1 from public.order_events where order_id = 'ZT-3' and kind = 'document.added' and meta ->> 'filename' = 'zt-client.pdf') then
    raise exception 'FAIL C4: client reads ZT-3 events %', (select string_agg(kind || ':' || coalesce(meta ->> 'documentKind', ''), ',') from public.order_events where order_id = 'ZT-3');
  end if;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if exists (select 1 from public.order_events where order_id in ('ZT-3', 'ZT-4')) then
    raise exception 'FAIL C4: client B reads ZT01 activity';
  end if;
end $$;
\echo 'ok  C4 activity: recorded by the database from committed changes only, actor and audience server-set, client RPCs recorded once; clients read their client-facing events; notifications follow'

-- C5: one action, one notification. Admin's hold and its message to the client
--     in one transaction tell the client once (the hold); the client's
--     clarification answer and its reply tell Admin once (the answer) -- while
--     the production owner, whom the answer does not concern, still hears of
--     the reply. A message on its own still notifies (C3).
do $$
declare v_msg uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  update public.orders set workflow = workflow || '{"onHold": true, "holdReason": "Title plant offline"}' where id = 'ZT-4';
  insert into public.support_messages (order_id, visibility, body) values ('ZT-4', 'client', 'Your order was placed on hold: Title plant offline.')
  returning id into v_msg;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select count(*) from public.notifications where order_id = 'ZT-4' and kind = 'order.hold' and body = 'Title plant offline') <> 1
     or exists (select 1 from public.notifications where message_id = v_msg) then
    raise exception 'FAIL C5: the client was told % times about the hold', (select count(*) from public.notifications where order_id = 'ZT-4' and (body = 'Title plant offline' or message_id = v_msg));
  end if;
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  update public.orders set clarification = 'pending', workflow = workflow || '{"onHold": false, "clarificationNote": "Which parcel?"}' where id = 'ZT-4';
end $$;
do $$
declare v_msg uuid;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  perform public.client_respond_clarification('ZT-4');
  insert into public.support_messages (order_id, body) values ('ZT-4', 'Parcel 14-25-376-012') returning id into v_msg;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if exists (select 1 from public.notifications where message_id = v_msg)
     or (select count(*) from public.notifications where order_id = 'ZT-4' and title = 'ZT-4: the client responded to the clarification') <> 2 then
    raise exception 'FAIL C5: Admin was told about the answer and its reply separately';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if not exists (select 1 from public.notifications where message_id = v_msg and kind = 'message.client') then
    raise exception 'FAIL C5: the production owner did not hear of the client''s reply';
  end if;
end $$;
\echo 'ok  C5 one action, one notification: an order change and its message (or an answer and its reply) notify each recipient once; others still hear of the message'

-- C6: production access follows the work: once ZT-4 leaves ZT User's desk
--     (and names them nowhere), its conversation is closed to them -- reads,
--     notes and replies alike -- while Admin and the client keep it.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  update public.orders set assigned_to = 'admin', assigned_user_id = null where id = 'ZT-4';
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if exists (select 1 from public.support_messages where order_id = 'ZT-4') then
    raise exception 'FAIL C6: a production user still reads the conversation of an order that is no longer theirs';
  end if;
  perform public.zt_expect_error($s$insert into public.support_messages (order_id, visibility, body) values ('ZT-4', 'internal', 'still here?')$s$, '42501');
  if public.order_is_my_work('ZT-4') or not public.order_is_my_work('ZT-3') or public.order_is_my_work('ZT-404') then
    raise exception 'FAIL C6: order_is_my_work answers wrongly';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if public.order_is_my_work('ZT-3') then raise exception 'FAIL C6: an admin is "production work"'; end if;
  if (select count(*) from public.support_messages where order_id = 'ZT-4') < 5 then raise exception 'FAIL C6: Admin lost the conversation'; end if;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select count(*) from public.support_messages where order_id = 'ZT-4') < 5 or exists (select 1 from public.support_messages where visibility = 'internal') then
    raise exception 'FAIL C6: the client''s view of its conversation changed';
  end if;
end $$;
\echo 'ok  C6 production access follows the work: an order off the desk closes its conversation to them; Admin and the client keep theirs'

-- ── Client payments (02 section 12) ─────────────────────────────────────────
-- Y-series fixtures, as the operator: ZT-5 and ZT-6 are delivered ZT01
-- invoices, ZT-7 a delivered ZT02 one, ZT-8 a ZT01 order still in typing.
-- ZT-6 carries a legacy report whose "check scan" is another order's document
-- (ZT-1's examiner file), and ZT-5 a stored client attachment -- neither is
-- evidence of a check. Removed again with the other fixtures.
\connect - :zt_operator
\pset tuples_only on
delete from public.orders where id in ('ZT-5', 'ZT-6', 'ZT-7', 'ZT-8');
insert into public.orders (id, client_code, state, county, type, status, assigned_to, completed, workflow) values
  ('ZT-5', 'ZT01', 'TX', 'Harris', 'Full Search', 'delivered', 'admin', current_date, '{}'),
  ('ZT-6', 'ZT01', 'TX', 'Harris', 'Full Search', 'delivered', 'admin', current_date,
   '{"payment": {"method": "Check", "reference": "77", "status": "marked", "markedAt": "2026-10-01",
                 "checkDoc": {"documentId": "dddddddd-0000-4000-8000-0000000000e1", "name": "other-order.pdf"}}}'),
  ('ZT-7', 'ZT02', 'TX', 'Harris', 'Full Search', 'delivered', 'admin', current_date, '{}'),
  ('ZT-8', 'ZT01', 'TX', 'Harris', 'Full Search', 'typing', 'admin', null, '{}');
insert into public.order_documents (id, order_id, kind, object_name, filename, content_type, size_bytes, sha256,
                                    status, stored_at, uploaded_by)
values ('dddddddd-0000-4000-8000-0000000000f1', 'ZT-5', 'client', 'orders/ZT-5/dddddddd-0000-4000-8000-0000000000f1',
        'attachment.pdf', 'application/pdf', 10, repeat('b', 64), 'stored', now(), 'a1a1a1a1-0000-4000-8000-000000000001');
-- K-series (company information and contacts, 02 section 14): no contacts or
-- profiles of the ZT companies left from an earlier run.
delete from public.client_contacts where client_code in ('ZT01', 'ZT02');
delete from public.client_profiles where client_code in ('ZT01', 'ZT02');
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
\connect - :app_user
\pset tuples_only on

-- Y1: no one writes workflow.payment except through the payment functions --
--     not a client, an admin, the billing owner, production or an insert; the
--     Supabase-era client_mark_payment() is not callable; an order save that
--     leaves the payment out keeps it.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  update public.orders set workflow = jsonb_set(workflow, '{payment}', '{"status": "marked"}') where id = 'ZT-5';
  perform public.zt_expect_error($s$select public.client_mark_payment('ZT-5', '{"status": "marked", "method": "ACH", "reference": "1"}')$s$, '42501', 'permission denied%');
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error($s$update public.orders set workflow = jsonb_set(workflow, '{payment}', '{"status": "marked", "method": "ACH", "reference": "1"}') where id = 'ZT-5'$s$,
    '42501', 'payments: a payment is reported by the client%');
  perform public.zt_expect_error($s$update public.orders set workflow = jsonb_set(workflow, '{payment,status}', '"unpaid"') where id = 'ZT-6'$s$,
    '42501', 'payments: %');
  perform public.zt_expect_error($s$insert into public.orders (id, client_code, state, county, type, workflow) values ('ZT-X5', 'ZT01', 'TX', 'Harris', 'Full Search', '{"payment": {"status": "confirmed"}}')$s$,
    '42501', 'payments: %');
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  perform public.zt_expect_error($s$update public.orders set workflow = jsonb_set(workflow, '{payment,status}', '"confirmed"') where id = 'ZT-6'$s$,
    '42501', 'payments: %');
  perform public.zt_expect_error($s$update public.orders set workflow = workflow - 'payment' || '{"payment": null}' where id = 'ZT-6'$s$,
    '42501', 'payments: %');
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  perform public.zt_expect_error($s$update public.orders set workflow = jsonb_set(workflow, '{payment}', '{"status": "marked"}') where id = 'ZT-3'$s$,
    '42501', 'payments: %');
  -- a whole-workflow save without the payment (production never reads it) keeps it
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  update public.orders set workflow = (workflow - 'payment') || '{"note": "zt"}' where id = 'ZT-6';
  if (select workflow -> 'payment' ->> 'reference' from public.orders where id = 'ZT-6') is distinct from '77'
     or (select workflow ->> 'note' from public.orders where id = 'ZT-6') is distinct from 'zt' then
    raise exception 'FAIL Y1: a save without the payment lost it, or lost the save';
  end if;
  if (select workflow -> 'payment' from public.orders where id = 'ZT-5') is not null then
    raise exception 'FAIL Y1: a direct write changed ZT-5''s payment';
  end if;
end $$;
\echo 'ok  Y1 workflow.payment: no direct write by client, admin, billing owner, production or insert; client_mark_payment closed; a save without it keeps it'

-- Y2: the client's report -- its own delivered invoice only; a Check only with
--     the stored scan of a check on THAT order; malformed, other clients',
--     staff, unfinished, failed, attachment and other orders' documents refused;
--     an identical retry adds nothing; a scan in a report stays on file; the
--     scan and the trail are hidden from production, other clients and admins
--     without billing; the billing owner is told.
do $$
declare v_doc uuid; v_pending uuid; v_failed uuid; v_pay jsonb; v_again jsonb;
begin
  set local role authenticated;
  -- who may add a check scan
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-5', 'check', 'cheque.png', 'image/png')$s$, '42501');
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-5', 'check', 'cheque.png', 'image/png')$s$, '42501');
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-5', 'check', 'cheque.png', 'image/png')$s$, 'P0002');
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-8', 'check', 'cheque.png', 'image/png')$s$, '42501');
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-5', 'check', 'cheque.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')$s$, '22023');
  select out_id into v_pending from public.document_begin_upload('ZT-5', 'check', 'unfinished.png', 'image/png');
  select out_id into v_failed from public.document_begin_upload('ZT-5', 'check', 'failed.png', 'image/png');
  perform public.document_fail_upload(v_failed);
  select out_id into v_doc from public.document_begin_upload('ZT-5', 'check', 'cheque-1042.png', 'image/png');
  perform public.document_finish_upload(v_doc, 2048, repeat('c', 64), 'image/png');

  -- refused reports
  perform public.zt_expect_error($s$select public.payment_report('ZT-8', 'ACH', 'T-1', null)$s$, '55000', 'payments: this order has not been invoiced yet');
  perform public.zt_expect_error($s$select public.payment_report('ZT-7', 'ACH', 'T-1', null)$s$, 'P0002');
  perform public.zt_expect_error($s$select public.payment_report('ZT-404', 'ACH', 'T-1', null)$s$, 'P0002');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'Cash', 'T-1', null)$s$, '22023');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'PayPal', 'T-1', null)$s$, '22023');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'ACH', '   ', null)$s$, '22023');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'ACH', repeat('9', 65), null)$s$, '22023');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'ACH', E'12\u000734', null)$s$, '22023');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'Check', '1042', null)$s$, '22023', 'payments: a check payment needs the scan%');
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'ACH', 'T-1', v_doc), '22023', 'payments: an ACH payment has no check scan');
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'Check', '1042', v_pending), '22023', 'payments: the check scan is not stored%');
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'Check', '1042', v_failed), '22023', 'payments: the check scan is not stored%');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'Check', '1042', 'dddddddd-0000-4000-8000-0000000000f1')$s$, '22023', 'payments: the check scan is not stored%');
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'Check', '1042', 'dddddddd-0000-4000-8000-0000000000e1')$s$, '22023', 'payments: the check scan is not stored%');
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'Check', '1042', gen_random_uuid()), '22023');
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'Check', '1042', v_doc), 'P0002');
  perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-7', 'Check', '1042', v_doc), '22023', 'payments: the check scan is not stored%');
  foreach v_again in array array['"c3c3c3c3-0000-4000-8000-000000000003"', '"d4d4d4d4-0000-4000-8000-000000000004"', '"16161616-0000-4000-8000-000000000016"']::jsonb[] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_again #>> '{}')::text, true);
    perform public.zt_expect_error(format('select public.payment_report(%L, %L, %L, %L)', 'ZT-5', 'Check', '1042', v_doc), '42501', 'payments: only the client reports%');
  end loop;
  if exists (select 1 from public.order_events where kind = 'payment.reported') then
    raise exception 'FAIL Y2: a refused report left an event';
  end if;

  -- the report, and its retry
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  v_pay := public.payment_report('ZT-5', 'Check', '  1042 ', v_doc);
  if v_pay ->> 'status' <> 'marked' or v_pay ->> 'reference' <> '1042' or v_pay ->> 'method' <> 'Check'
     or v_pay -> 'checkDoc' ->> 'documentId' <> v_doc::text or v_pay -> 'checkDoc' ->> 'name' <> 'cheque-1042.png'
     or v_pay ->> 'markedAt' is null or v_pay ? 'confirmedAt' then
    raise exception 'FAIL Y2: report stored as %', v_pay;
  end if;
  v_again := public.payment_report('ZT-5', 'Check', '1042', v_doc);
  if v_again is distinct from v_pay then raise exception 'FAIL Y2: the retried report changed the payment'; end if;
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'ACH', 'T-9', null)$s$, '55000', 'payments: a payment is already reported%');
  if (select count(*) from public.order_events where order_id = 'ZT-5' and kind = 'payment.reported') <> 1 then
    raise exception 'FAIL Y2: the client does not see exactly one report event';
  end if;
  if (select count(*) from public.order_documents where order_id = 'ZT-5' and kind = 'check') <> 1 then
    raise exception 'FAIL Y2: the client does not see its stored check scan';
  end if;
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_doc), '55000', 'documents: the check scan belongs to a reported payment%');

  -- who sees the scan, the trail and the notification
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  if (select count(*) from public.order_documents where id = v_doc) <> 1
     or (select count(*) from public.order_events where order_id = 'ZT-5' and kind in ('payment.reported', 'document.added')) <> 2
     or (select string_agg(kind || '/' || target || '/' || title || '/' || coalesce(body, ''), ',') from public.notifications where order_id = 'ZT-5' and kind like 'payment.%')
        is distinct from 'payment.reported/billing/Payment reported on INV-ZT-5/Check payment — awaiting your verification' then
    raise exception 'FAIL Y2: the billing owner does not see the scan, the trail or one notification';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if exists (select 1 from public.order_documents where id = v_doc)
     or (select count(*) from public.order_events where order_id = 'ZT-5' and kind = 'payment.reported') <> 1
     or exists (select 1 from public.notifications where order_id = 'ZT-5' and kind like 'payment.%') then
    raise exception 'FAIL Y2: an admin without billing reads the scan, misses the trail, or was notified';
  end if;
  perform public.zt_expect_error(format('select public.document_begin_delete(%L)', v_doc), 'P0002');
  foreach v_again in array array['"16161616-0000-4000-8000-000000000016"', '"b2b2b2b2-0000-4000-8000-000000000002"']::jsonb[] loop
    perform set_config('request.jwt.claims', json_build_object('sub', v_again #>> '{}')::text, true);
    if exists (select 1 from public.order_documents where order_id = 'ZT-5' and kind = 'check')
       or exists (select 1 from public.order_events where order_id = 'ZT-5' and audience = 'billing')
       or exists (select 1 from public.notifications where kind like 'payment.%') then
      raise exception 'FAIL Y2: % reads the check scan, the billing trail or a payment notification', v_again;
    end if;
  end loop;
end $$;
\echo 'ok  Y2 client report: own delivered invoice; a Check needs a stored scan of that order (missing, unfinished, failed, attachment, other order refused); retry idempotent; scan kept; billing-only visibility; billing owner told'

-- Y3: the billing owner's decision -- nobody else decides; a stale decision,
--     a second one or one without evidence is refused; a bounce is recorded
--     with its reason and the client may report again; a confirmation is
--     final; the client is told of each decision; a rolled-back decision
--     leaves nothing.
do $$
declare v_base timestamptz; v_old timestamptz; v_pay jsonb; who text;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select updated_at into v_base from public.orders where id = 'ZT-5';
  foreach who in array array['a1a1a1a1-0000-4000-8000-000000000001', 'c3c3c3c3-0000-4000-8000-000000000003',
                             '16161616-0000-4000-8000-000000000016', 'b2b2b2b2-0000-4000-8000-000000000002'] loop
    perform set_config('request.jwt.claims', json_build_object('sub', who)::text, true);
    perform set_config('request.jwt.claim.role', 'service_role', true);   -- a forged claim role grants nothing
    perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'confirmed', v_base), '42501', 'only the billing owner%');
    perform set_config('request.jwt.claim.role', '', true);
  end loop;
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'paid', v_base), '22023');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L, %L)', 'ZT-5', 'confirmed', v_base, 'looks fine'), '22023');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L, %L)', 'ZT-5', 'bounced', v_base, repeat('r', 301)), '22023');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'confirmed', v_base - interval '1 second'), '40001');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'confirmed', null), '40001');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-8', 'confirmed', (select updated_at from public.orders where id = 'ZT-8')), '55000');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-404', 'confirmed', v_base), 'P0002');
  -- ZT-6's "evidence" is another order's document: never confirmed, may be bounced
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-6', 'confirmed', (select updated_at from public.orders where id = 'ZT-6')),
    '55000', 'payments: the check scan for this report is not on file%');
  v_pay := public.payment_verify('ZT-6', 'bounced', (select updated_at from public.orders where id = 'ZT-6'), '  Check returned unpaid ');
  if v_pay ->> 'status' <> 'bounced' or v_pay ->> 'bounceReason' <> 'Check returned unpaid' or v_pay ->> 'bouncedAt' is null
     or v_pay ->> 'confirmedBy' <> 'ZT Billing' or v_pay ->> 'reference' <> '77' then
    raise exception 'FAIL Y3: bounce stored as %', v_pay;
  end if;
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-6', 'bounced', (select updated_at from public.orders where id = 'ZT-6')), '55000');

  -- the confirmation: once, on the version reviewed
  v_pay := public.payment_verify('ZT-5', 'confirmed', v_base);
  if v_pay ->> 'status' <> 'confirmed' or v_pay ->> 'confirmedBy' <> 'ZT Billing' or v_pay ->> 'confirmedAt' is null
     or v_pay ->> 'reference' <> '1042' or v_pay -> 'checkDoc' ->> 'name' <> 'cheque-1042.png' then
    raise exception 'FAIL Y3: confirmation stored as %', v_pay;
  end if;
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'confirmed', v_base), '40001');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'confirmed', (select updated_at from public.orders where id = 'ZT-5')),
    '55000', 'payments: this payment is already confirmed');
  perform public.zt_expect_error(format('select public.payment_verify(%L, %L, %L)', 'ZT-5', 'bounced', (select updated_at from public.orders where id = 'ZT-5')), '55000');
  if (select count(*) from public.order_events where order_id = 'ZT-5' and kind = 'payment.confirmed') <> 1
     or (select count(*) from public.order_events where order_id = 'ZT-6' and kind = 'payment.bounced'
           and action like '%rejected the Check payment for INV-ZT-6 (bounced) — Check returned unpaid') <> 1 then
    raise exception 'FAIL Y3: the decisions are not each recorded once';
  end if;

  -- the client: told of both decisions, may report ZT-6 again, ZT-5 is final
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(kind || '/' || order_id || '/' || target, ',' order by id) from public.notifications where kind like 'payment.%')
     is distinct from 'payment.bounced/ZT-6/billing,payment.confirmed/ZT-5/billing' then
    raise exception 'FAIL Y3: client payment notifications %',
      (select string_agg(kind || '/' || order_id || '/' || target, ',' order by id) from public.notifications where kind like 'payment.%');
  end if;
  if (select workflow -> 'payment' ->> 'status' from public.orders where id = 'ZT-5') <> 'confirmed'
     or (select count(*) from public.order_events where order_id in ('ZT-5', 'ZT-6') and kind like 'payment.%') <> 3 then
    raise exception 'FAIL Y3: the client does not read its decided payments and their trail';
  end if;
  perform public.zt_expect_error($s$select public.payment_report('ZT-5', 'ACH', 'T-2', null)$s$, '55000', 'payments: this invoice is already paid');
  perform public.zt_expect_error($s$select public.document_begin_upload('ZT-5', 'check', 'again.png', 'image/png')$s$, '42501');
  v_pay := public.payment_report('ZT-6', 'ACH', 'TRACE-21', null);
  if v_pay ->> 'status' <> 'marked' or v_pay ? 'bounceReason' or v_pay -> 'checkDoc' <> 'null'::jsonb then
    raise exception 'FAIL Y3: the report after a bounce is %', v_pay;
  end if;
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if exists (select 1 from public.notifications where kind like 'payment.%') then raise exception 'FAIL Y3: client B was told'; end if;

  -- a decision whose transaction rolls back leaves no payment, event or notification
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  select updated_at into v_old from public.orders where id = 'ZT-6';
  begin
    perform public.payment_verify('ZT-6', 'confirmed', v_old);
    raise exception using errcode = 'ZT999';
  exception when sqlstate 'ZT999' then null;
  end;
  if (select workflow -> 'payment' ->> 'status' from public.orders where id = 'ZT-6') <> 'marked'
     or (select updated_at from public.orders where id = 'ZT-6') <> v_old
     or exists (select 1 from public.order_events where order_id = 'ZT-6' and kind = 'payment.confirmed') then
    raise exception 'FAIL Y3: a rolled-back confirmation left a trace';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if exists (select 1 from public.notifications where order_id = 'ZT-6' and kind = 'payment.confirmed') then
    raise exception 'FAIL Y3: a rolled-back confirmation notified the client';
  end if;
  -- ACH: the reference is its evidence
  perform set_config('request.jwt.claims', '{"sub":"d4d4d4d4-0000-4000-8000-000000000004"}', true);
  v_pay := public.payment_verify('ZT-6', 'confirmed', v_old);
  if v_pay ->> 'status' <> 'confirmed' or v_pay ->> 'reference' <> 'TRACE-21' then raise exception 'FAIL Y3: ACH confirmation %', v_pay; end if;
end $$;
\echo 'ok  Y3 billing decision: billing owner only (forged claim role too); stale, duplicate, evidence-less decisions refused; bounce auditable, re-reportable; confirmation final; client told; rollback leaves nothing'

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

-- K1: the client directory and company information: Admin every company, a
--     client its own, production nothing. Contacts are written only through
--     the fields a person edits, validated, authored by the database, archived
--     rather than deleted; company profiles likewise.
do $$
declare v_id uuid; v_b uuid; v_at timestamptz;
begin
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"sub":"16161616-0000-4000-8000-000000000016"}', true);
  if exists (select 1 from public.client_directory) or exists (select 1 from public.client_contacts) or exists (select 1 from public.client_profiles) then
    raise exception 'FAIL K1: a production user reads the client directory, contacts or profiles';
  end if;
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name) values ('ZT01', 'x')$s$, '42501');
  perform public.zt_expect_error($s$insert into public.client_profiles (client_code, city) values ('ZT01', 'x')$s$, '42501');

  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select count(*) from public.client_directory where code in ('ZT01', 'ZT02')) <> 2 then raise exception 'FAIL K1: Admin directory'; end if;
  insert into public.client_contacts (client_code, name, email) values ('ZT02', '  B Person ', 'B.Person@Example.TEST') returning id into v_b;
  if (select row(name, email, created_by)::text from public.client_contacts where id = v_b) <> '("B Person",b.person@example.test,"ZT Admin")' then
    raise exception 'FAIL K1: an admin''s contact was not normalised or authored by the database';
  end if;
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name) values ('ZT99', 'x')$s$, '22023', 'contacts: unknown client');

  perform set_config('request.jwt.claims', '{"sub":"a1a1a1a1-0000-4000-8000-000000000001"}', true);
  if (select string_agg(code, ',') from public.client_directory) <> 'ZT01' then raise exception 'FAIL K1: client directory'; end if;
  insert into public.client_contacts (client_code, name, email, phone, title, marketing_opt_in)
    values ('ZT01', 'Ann Placer', 'ann@example.test', '(555) 010-2000 x12', 'Processor', true) returning id, updated_at into v_id, v_at;
  if (select created_by from public.client_contacts where id = v_id) <> 'client' then raise exception 'FAIL K1: client contact author'; end if;
  if exists (select 1 from public.client_contacts where client_code <> 'ZT01') then raise exception 'FAIL K1: client A reads another company''s contacts'; end if;
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name) values ('ZT02', 'x')$s$, '42501');
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name, created_by) values ('ZT01', 'x', 'ZT Admin')$s$, '42501');
  perform public.zt_expect_error(format('update public.client_contacts set client_code = %L where id = %L', 'ZT02', v_id), '42501');
  perform public.zt_expect_error(format('delete from public.client_contacts where id = %L', v_id), '42501');
  update public.client_contacts set name = 'B Renamed' where id = v_b;                          -- not visible: no row matches
  update public.client_contacts set archived_at = now() where client_code = 'ZT02';
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name, email) values ('ZT01', 'x', 'not-an-email')$s$, '22023');
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name, phone) values ('ZT01', 'x', 'call me')$s$, '22023');
  perform public.zt_expect_error($s$insert into public.client_contacts (client_code, name) values ('ZT01', '   ')$s$, '22023');
  perform public.zt_expect_error(format('insert into public.client_contacts (client_code, name) values (%L, %L)', 'ZT01', E'line\nbreak'), '22023');
  update public.client_contacts set name = 'Ann Placer-Smith' where id = v_id;
  if (select row(name, updated_at >= v_at)::text from public.client_contacts where id = v_id) <> '("Ann Placer-Smith",t)' then
    raise exception 'FAIL K1: contact edit';
  end if;
  update public.client_contacts set archived_at = '2000-01-01' where id = v_id;
  if (select archived_at from public.client_contacts where id = v_id) < now() - interval '1 minute' then raise exception 'FAIL K1: archive time not the server''s'; end if;
  perform public.zt_expect_error(format('update public.client_contacts set name = %L where id = %L', 'Back', v_id), '55000');

  -- company profile: the client's own, validated, authored by the database
  insert into public.client_profiles (client_code, address, city, state, zip, phone, website, logo_url)
    values ('ZT01', ' 1 Test Way ', 'Austin', 'tx', '78701', '512-555-0100', 'https://zt01.example.test', 'https://zt01.example.test/logo.png');
  if (select row(address, state, updated_by)::text from public.client_profiles where client_code = 'ZT01') <> '("1 Test Way",TX,"ZT Client A")' then
    raise exception 'FAIL K1: profile normalisation or author';
  end if;
  perform public.zt_expect_error($s$update public.client_profiles set website = 'javascript:alert(1)' where client_code = 'ZT01'$s$, '22023');
  perform public.zt_expect_error($s$update public.client_profiles set logo_url = 'data:image/png;base64,AAAA' where client_code = 'ZT01'$s$, '22023');
  perform public.zt_expect_error($s$update public.client_profiles set state = 'Texas' where client_code = 'ZT01'$s$, '22023');
  perform public.zt_expect_error($s$update public.client_profiles set zip = '7870' where client_code = 'ZT01'$s$, '22023');
  perform public.zt_expect_error($s$update public.client_profiles set updated_by = 'Someone' where client_code = 'ZT01'$s$, '42501');
  perform public.zt_expect_error($s$insert into public.client_profiles (client_code, city) values ('ZT02', 'x')$s$, '42501');
  perform public.zt_expect_error($s$delete from public.client_profiles where client_code = 'ZT01'$s$, '42501');
  perform set_config('request.jwt.claims', '{"sub":"b2b2b2b2-0000-4000-8000-000000000002"}', true);
  if exists (select 1 from public.client_profiles) or exists (select 1 from public.client_contacts where client_code = 'ZT01') then
    raise exception 'FAIL K1: client B reads client A''s profile or contacts';
  end if;
  perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
  if (select row(name, archived_at is null)::text from public.client_contacts where id = v_b) <> '("B Person",t)' then
    raise exception 'FAIL K1: client A changed or archived client B''s contact';
  end if;
  update public.client_profiles set city = 'Dallas' where client_code = 'ZT01';
  if (select row(city, updated_by)::text from public.client_profiles where client_code = 'ZT01') <> '(Dallas,"ZT Admin")' then
    raise exception 'FAIL K1: admin profile edit';
  end if;
end $$;
\echo 'ok  K1 company information: directory per Admin / own client / none for production; contacts and profiles isolated, validated, authored by the database, archived not deleted'

-- ── Back as the bootstrap admin ─────────────────────────────────────────────
\connect - :zt_operator
\pset tuples_only on
-- D-series fixtures out again: ZT-3 (its documents cascade), ZT-1's document, the helper.
delete from public.order_documents where order_id in ('ZT-1', 'ZT-2', 'ZT-3');
delete from public.orders where id = 'ZT-3';
-- C-series: ZT-4, and the fixtures' messages, notifications and events.
-- Y-series: ZT-5 to ZT-8 (their documents cascade). U-series: the edit fixtures.
delete from public.orders where id in ('ZT-4', 'ZT-5', 'ZT-6', 'ZT-7', 'ZT-8');
delete from auth.users where firebase_uid like 'zt-fb-edit-%';
delete from public.notifications where recipient_id in (select id from public.profiles where email like 'zt-%@example.test');
delete from public.support_messages where client_code in ('ZT01', 'ZT02');
delete from public.order_events where order_id like 'ZT-%';
-- K-series: the ZT companies' contacts and profiles.
delete from public.client_contacts where client_code in ('ZT01', 'ZT02');
delete from public.client_profiles where client_code in ('ZT01', 'ZT02');
drop function if exists public.zt_expect_error(text, text, text);

-- O7: provisioning left exactly the five accounts it accepted -- each one
--     mapping plus one pending profile under the same generated id (never the
--     Firebase UID) -- and nothing from any refused, failed or rolled-back
--     request. The accounts the refused requests named are unchanged.
do $$
declare r record; got text;
begin
  select string_agg(firebase_uid, ',' order by firebase_uid) into got from auth.users where firebase_uid like 'zt-prov-%';
  if got is distinct from 'zt-prov-admin,zt-prov-billing,zt-prov-client,zt-prov-super,zt-prov-user' then
    raise exception 'FAIL O7: zt-prov mappings are %', got;
  end if;
  for r in select u.firebase_uid, u.id, u.email, p.id as pid, p.email as pemail, p.status
             from auth.users u left join public.profiles p on p.id = u.id
            where u.firebase_uid like 'zt-prov-%' loop
    if r.pid is null or r.id::text = r.firebase_uid or r.email is distinct from r.pemail
       or r.status is distinct from (case when r.firebase_uid in ('zt-prov-client', 'zt-prov-billing') then 'active' else 'pending' end) then
      raise exception 'FAIL O7: % -> %', r.firebase_uid, row_to_json(r);
    end if;
  end loop;
  if exists (select 1 from public.profiles p where not exists (select 1 from auth.users u where u.id = p.id))
     or (select count(*) from public.profiles where email like 'zt-prov-%') <> 5 then
    raise exception 'FAIL O7: stray provisioned profiles';
  end if;
  select string_agg(u.firebase_uid || '=' || row(p.role::text, p.super_admin, p.can_confirm_payments, p.client_code, p.status)::text, ' ' order by u.firebase_uid)
    into got
    from auth.users u join public.profiles p on p.id = u.id
   where u.firebase_uid in ('zt-fb-client-a', 'zt-fb-billing');
  if got is distinct from 'zt-fb-billing=(admin,t,t,,active) zt-fb-client-a=(client,f,f,ZT01,active)' then
    raise exception 'FAIL O7: existing accounts changed: %', got;
  end if;
end $$;
\echo 'ok  O7 operator view: five accepted accounts (mapping + profile, generated id; two activated); nothing from refused, failed or rolled-back requests'

-- O8: re-applying 02_post_migrate.sql (as every bootstrap re-run does) keeps
--     the function as it is -- same oid, body and grants -- and the
--     verification stays green.
drop trigger zt_fail_profile_insert on public.profiles;
drop function public.zt_fail_profile_insert();
select p.oid::int as zt_fn_oid, coalesce(p.proacl::text, '') as zt_fn_acl, md5(p.prosrc) as zt_fn_src
  from pg_proc p
 where p.oid = to_regprocedure('auth.provision_app_user(text, text, text, text, text, boolean, boolean, jsonb)') \gset
\ir 02_post_migrate.sql
select coalesce((select p.oid::int = :zt_fn_oid and coalesce(p.proacl::text, '') = :'zt_fn_acl' and md5(p.prosrc) = :'zt_fn_src'
                   from pg_proc p
                  where p.oid = to_regprocedure('auth.provision_app_user(text, text, text, text, text, boolean, boolean, jsonb)')),
                false) as zt_same \gset
\if :zt_same
\else
  do $$ begin raise exception 'FAIL O8: re-applying 02_post_migrate.sql changed auth.provision_app_user'; end $$;
\endif
\ir verify_bootstrap.sql
\echo 'ok  O8 02_post_migrate.sql re-applied: provisioning function unchanged (oid, body, grants); verify_bootstrap.sql green'

-- O9: the layers behind the privileges. Even after a (simulated) future
--     blanket GRANT ALL on every public table to authenticated, an admin acting through
--     the API role still cannot create, delete, truncate or rewrite profiles:
--     no policy admits INSERT/DELETE, the lifecycle trigger refuses non-owners,
--     and the identity and privilege guards refuse the rest. Operator
--     maintenance keeps working. Everything is rolled back.
do $$
declare stmt text; n int; msg text; st text;
begin
  begin
    grant all on all tables in schema public to authenticated;   -- the historical 20260722000000 statement
    set local role authenticated;
    perform set_config('request.jwt.claims', '{"sub":"c3c3c3c3-0000-4000-8000-000000000003"}', true);
    foreach stmt in array array[
      $s$insert into public.profiles (id, name, email, role, super_admin, can_confirm_payments, status) values ('18181818-0000-4000-8000-000000000018', 'x', 'zt-orphan@example.test', 'admin', true, true, 'active')$s$,
      $s$insert into public.profiles (id, name, email, role) values ('c3c3c3c3-0000-4000-8000-000000000003', 'x', 'x@example.test', 'client') on conflict (id) do update set super_admin = true, can_confirm_payments = true$s$,
      $s$delete from public.profiles where id = 'b2b2b2b2-0000-4000-8000-000000000002'$s$,
      $s$delete from public.profiles where id = 'c3c3c3c3-0000-4000-8000-000000000003'$s$,
      $s$with d as (delete from public.profiles where id = 'c3c3c3c3-0000-4000-8000-000000000003' returning id, name, email, created_at) insert into public.profiles (id, name, email, role, super_admin, can_confirm_payments, status, created_at) select id, name, email, 'admin', true, true, 'active', created_at from d$s$,
      $s$truncate public.profiles cascade$s$,
      $s$update public.profiles set id = '18181818-0000-4000-8000-000000000018' where id = 'a1a1a1a1-0000-4000-8000-000000000001'$s$,
      $s$update public.profiles set email = 'zt-taken-over@example.test' where id = 'a1a1a1a1-0000-4000-8000-000000000001'$s$,
      $s$update public.profiles set role = 'admin', super_admin = true, can_confirm_payments = true where id = 'c3c3c3c3-0000-4000-8000-000000000003'$s$,
      $s$update public.profiles set status = 'active' where id = '17171717-0000-4000-8000-000000000017'$s$] loop
      n := null; msg := null; st := null;
      begin
        execute stmt;
        get diagnostics n = row_count;
      exception when others then msg := sqlerrm; st := sqlstate;
      end;
      -- refused by a layer (an exception), or no row reachable (RLS: no DELETE policy)
      if not (st is not null or n = 0) then
        raise exception 'FAIL O9: with a blanket grant, % ran (% rows)', stmt, n;
      end if;
      if st is not null and st <> '42501' and msg not like '%set by an administrator%' then
        raise exception 'FAIL O9: % refused for the wrong reason: % %', stmt, st, msg;
      end if;
    end loop;
    update public.profiles set name = name where id = 'a1a1a1a1-0000-4000-8000-000000000001';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL O9: the legitimate name edit stopped working'; end if;
    raise exception using errcode = 'ZT999';
  exception when sqlstate 'ZT999' then null;
  end;

  -- operator maintenance (no claims, the table owner): create and remove a
  -- profile, change privilege columns -- all rolled back
  begin
    insert into public.profiles (id, name, email, role, status) values
      ('18181818-0000-4000-8000-000000000018', 'ZT Orphan', 'zt-orphan@example.test', 'client', 'active');
    update public.profiles set role = 'admin', super_admin = true, email = 'zt-orphan2@example.test'
     where id = '18181818-0000-4000-8000-000000000018';
    delete from public.profiles where id = '18181818-0000-4000-8000-000000000018';
    get diagnostics n = row_count;
    if n <> 1 then raise exception 'FAIL O9: operator could not remove a profile'; end if;
    raise exception using errcode = 'ZT999';
  exception when sqlstate 'ZT999' then null;
  end;
end $$;
\echo 'ok  O9 with a blanket re-grant the policy and triggers still refuse create / delete / replace / truncate / identity and privilege rewrites; operator maintenance works'

\echo 'test_security: all checks passed'
