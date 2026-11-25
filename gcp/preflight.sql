-- =====================================================================
-- Read-only schema preflight for the GCP database (resolute_live et al.)
-- =====================================================================
-- Run through gcp/preflight.sh, which also forces
-- default_transaction_read_only=on for the whole session. Everything here is
-- one READ ONLY transaction that is rolled back: catalog reads plus aggregate
-- counts (never a row, never a name or email), so it is safe to point at
-- production and it cannot change anything -- a write would be refused by the
-- server.
--
-- Phases (-v phase=...):
--   pre   (default) is the database ready for gcp/migrations/20261124000000?
--   post  did that migration land exactly as reviewed?
--
-- Every line is OK / INFO / WARN / FAIL. Any FAIL ends the script with an
-- error, so psql exits nonzero (preflight.sh maps it to exit 2).
--
-- Two traps this avoids, both of which would make a check pass while
-- verifying nothing:
--   * information_schema hides columns of tables the connecting role has no
--     privilege on, so a reviewer account would see "missing" columns. This
--     reads pg_catalog, which every role can read.
--   * count(*) under RLS counts only the rows the role may see -- for a role
--     with no claims that is usually ZERO. Exact counts are reported only when
--     the role really bypasses RLS on that table; otherwise the statistics
--     estimate is shown and labelled as such. An empty orders table is a WARN:
--     data-level checks against it would be vacuous.
-- =====================================================================

\set ON_ERROR_STOP on
\if :{?phase}
\else
  \set phase pre
\endif
\if :{?app_user}
\else
  \set app_user resolute_app
\endif

begin transaction isolation level repeatable read, read only;
set local statement_timeout = '30s';
set local lock_timeout = '2s';
set local search_path = pg_catalog, pg_temp;

select set_config('resolute_pf.phase', :'phase', true) as pf_set_phase,
       set_config('resolute_pf.app_user', :'app_user', true) as pf_set_app \gset

with
me as (select * from pg_roles where rolname = current_user),
-- Every lookup goes through the catalog by name. to_regclass/to_regprocedure
-- RAISE "permission denied for schema" (instead of returning NULL) for a role
-- without USAGE on the schema -- e.g. a reviewer account and schema auth.
-- With search_path = pg_catalog, regprocedure text is fully qualified.
fns as (
  select p.oid, p.oid::regprocedure::text as sig
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'auth')
),
rels as (
  select c.oid, c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind in ('r', 'p')
),
cfg as (
  select current_setting('resolute_pf.phase') as phase,
         current_setting('resolute_pf.app_user') as app_user,
         (select c.relowner from pg_class c where c.oid = (select oid from rels where name = 'orders')) as owner_oid
),
-- Columns the guarded migration's functions read or write.
req_cols(sch, tbl, col, typ) as (values
  ('public','orders','id','text'), ('public','orders','client_code','text'),
  ('public','orders','workflow','jsonb'), ('public','orders','type','text'),
  ('public','orders','state','text'), ('public','orders','county','text'),
  ('public','orders','priority','order_priority'), ('public','orders','status','order_status'),
  ('public','orders','assigned_to','user_role'), ('public','orders','eta','date'),
  ('public','orders','client_file_no','text'),
  ('public','clients','code','text'), ('public','clients','name','text'),
  ('public','clients','contact','text'), ('public','clients','email','text'),
  ('public','clients','registered','date'),
  ('public','profiles','id','uuid'), ('public','profiles','name','text'),
  ('public','profiles','email','text'), ('public','profiles','role','user_role'),
  ('public','profiles','status','text'), ('public','profiles','client_code','text'),
  ('public','order_events','id','int8'), ('public','order_events','order_id','text'),
  ('public','order_events','action','text'), ('public','order_events','type','text'),
  ('public','order_events','actor','text'), ('public','order_events','actor_email','text'),
  ('public','order_events','audience','text'), ('public','order_events','created_at','timestamptz'),
  ('public','notification_types','key','text'), ('public','notification_types','label','text'),
  ('public','notification_types','description','text'),
  ('public','notification_types','default_roles','_user_role'),
  ('public','notification_types','default_mode','text'),
  ('public','notification_types','sort_order','int4'),
  ('public','notification_outbox','dedupe_key','text'),
  ('auth','users','id','uuid'), ('auth','users','firebase_uid','text')
),
col_state as (
  select rc.*, t.typname::text as got
    from req_cols rc
    left join pg_namespace n on n.nspname = rc.sch
    left join pg_class c on c.relnamespace = n.oid and c.relname = rc.tbl and c.relkind in ('r', 'p')
    left join pg_attribute a on a.attrelid = c.oid and a.attname = rc.col and a.attnum > 0 and not a.attisdropped
    left join pg_type t on t.oid = a.atttypid
),
-- Functions the migration's functions call.
req_fns(sig) as (values
  ('auth.uid()'), ('public.my_client_code()'), ('public.is_admin()'), ('public.is_staff()'),
  ('public.client_name_key(text)'), ('public.next_client_code()'),
  ('public.intake_resolve_client(text,text,text)'),
  ('public.enqueue_notification(text,text,jsonb,text,text,public.user_role[])')
),
-- Functions the 18 Nov integration review reported present on resolute_live.
known(name) as (values
  ('activity_record'), ('client_name_key'), ('intake_resolve_client'),
  ('next_client_code'), ('document_referenced'), ('guard_order_documents')
),
known_state as (
  select k.name, string_agg(p.oid::regprocedure::text, ', ') as sigs
    from known k
    left join pg_proc p on p.proname = k.name and p.pronamespace = 'public'::regnamespace
   group by k.name
),
targets(sig, want_def) as (values
  ('resolve_order_charge(text,text,text)', true),
  ('admin_create_client(text,text,text)', true),
  ('gcp_raise_order_charge(text,text,numeric)', false),
  ('gcp_resolve_order_charge(text,text,text)', true)
),
tgt_state as (
  select t.sig, t.want_def, p.oid, p.prosecdef, p.proconfig, p.proowner,
         coalesce(obj_description(p.oid, 'pg_proc'), '') like 'resolute gcp migration 20261124000000%' as marked,
         (select array_agg(distinct pg_get_userbyid(a.grantee)::text order by pg_get_userbyid(a.grantee)::text)
            from aclexplode(p.proacl) a where a.grantee <> p.proowner) as grantees,
         p.proacl is null as default_acl
    from targets t
    left join pg_proc p on p.oid = (select f.oid from fns f where f.sig = 'public.' || t.sig)
),
overloads as (
  select p.oid::regprocedure::text as sig
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and p.proname in ('resolve_order_charge', 'admin_create_client', 'gcp_raise_order_charge', 'gcp_resolve_order_charge')
     and not exists (select 1 from targets t where 'public.' || t.sig = p.oid::regprocedure::text)
),
rel(name) as (values ('orders'), ('clients'), ('profiles'), ('order_events'),
                     ('notification_types'), ('notification_outbox'), ('notification_preferences')),
rel_state as (
  select r.name, c.oid, c.relowner, c.relrowsecurity as rls, c.relforcerowsecurity as forced,
         s.n_live_tup,
         -- Can THIS role see every row? Only then is count(*) the real count.
         (c.oid is not null
          and has_table_privilege(me.oid, c.oid, 'SELECT')
          and (me.rolsuper or me.rolbypassrls or not c.relrowsecurity
               or (c.relowner = me.oid and not c.relforcerowsecurity))) as exact
    from rel r
    cross join me
    left join pg_class c on c.oid = (select x.oid from rels x where x.name = r.name)
    left join pg_stat_all_tables s on s.relid = c.oid
),
owner_role as (select r.* from pg_roles r, cfg where r.oid = cfg.owner_oid),
app as (select r.* from pg_roles r, cfg where r.rolname = cfg.app_user),
svc as (select * from pg_roles where rolname = 'service_role'),
authn as (select oid from pg_roles where rolname = 'authenticated'),
-- Exact aggregates, evaluated only where exact (dynamic SQL, so a table the
-- role cannot read is never even planned).
counts as (
  select
    case when (select exact from rel_state where name = 'orders')
      then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.orders', false, true, '')))[1]::text::bigint end as orders,
    case when (select exact from rel_state where name = 'orders')
      then (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.orders
             where jsonb_typeof(workflow->'pendingCharges') = 'array' and jsonb_array_length(workflow->'pendingCharges') > 0$q$, false, true, '')))[1]::text::bigint end as orders_with_charges,
    case when (select exact from rel_state where name = 'orders')
      then (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.orders o,
             jsonb_array_elements(case when jsonb_typeof(o.workflow->'pendingCharges') = 'array' then o.workflow->'pendingCharges' else '[]'::jsonb end) c
             where coalesce(c->>'status', 'pending') = 'pending'$q$, false, true, '')))[1]::text::bigint end as pending_charges,
    case when (select exact from rel_state where name = 'clients')
      then (xpath('/row/n/text()', query_to_xml('select count(*) as n from public.clients', false, true, '')))[1]::text::bigint end as clients,
    case when (select exact from rel_state where name = 'profiles')
      then (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.profiles
             where role = 'admin' and status = 'active' and coalesce(email, '') <> ''$q$, false, true, '')))[1]::text::bigint end as active_admins,
    case when (select exact from rel_state where name = 'profiles') and (select exact from rel_state where name = 'clients')
      then (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.profiles p
             where p.client_code is not null and not exists (select 1 from public.clients c where c.code = p.client_code)$q$, false, true, '')))[1]::text::bigint end as dangling_profile_codes,
    case when (select exact from rel_state where name = 'notification_types')
      then (xpath('/row/n/text()', query_to_xml($q$select count(*) as n from public.notification_types
             where key in ('charge.approved', 'charge.declined')$q$, false, true, '')))[1]::text::bigint end as charge_types
),
notify_trg as (
  select t.tgname, t.tgenabled, p.prosrc ilike '%additional fee%' as knows_charges
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = (select oid from rels where name = 'order_events') and not t.tgisinternal
     and p.proname = 'notify_on_order_event'
),
fn_defacl as (
  select string_agg(distinct format('%s -> %s', pg_get_userbyid(d.defaclrole),
                    case when a.grantee = 0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end), ', ') as grants
    from pg_default_acl d cross join aclexplode(d.defaclacl) a
   where d.defaclobjtype = 'f' and a.privilege_type = 'EXECUTE'
     and (d.defaclnamespace = 0 or d.defaclnamespace = 'public'::regnamespace)
),
checks(ord, status, area, item, detail) as (
  -- ── session ──
  select 10, case when current_setting('transaction_read_only') = 'on' then 'OK' else 'FAIL' end,
         'session', 'read-only transaction', current_setting('transaction_read_only')
  union all
  select 11, case when current_setting('server_version_num')::int >= 150000 then 'OK' else 'FAIL' end,
         'session', 'PostgreSQL 15+', current_setting('server_version')
  union all
  select 12, 'INFO', 'session', 'connected as',
         format('db=%s user=%s superuser=%s bypassrls=%s phase=%s', current_database(), me.rolname,
                me.rolsuper, me.rolbypassrls, (select phase from cfg))
    from me
  union all
  select 13, case when (select phase from cfg) in ('pre', 'post') then 'OK' else 'FAIL' end,
         'session', 'phase', (select phase from cfg)

  -- ── schema prerequisites ──
  union all
  select 100, case when count(*) filter (where got is distinct from typ) = 0 then 'OK' else 'FAIL' end,
         'schema', 'required columns + types',
         format('%s of %s as expected', count(*) filter (where got = typ), count(*))
    from col_state
  union all
  select 101, 'FAIL', 'schema', format('%s.%s.%s', sch, tbl, col),
         coalesce('is ' || got || ', expected ' || typ, 'missing')
    from col_state where got is distinct from typ
  union all
  select 110, case when not exists (select 1 from fns f where f.sig = r.sig) then 'FAIL' else 'OK' end,
         'schema', 'function ' || r.sig,
         case when not exists (select 1 from fns f where f.sig = r.sig) then 'missing' else 'present' end
    from req_fns r
  union all
  select 120, case when sigs is null then 'WARN' else 'OK' end, 'schema',
         'reported on resolute_live: ' || name, coalesce(sigs, 'missing -- the 18 Nov review listed it as present')
    from known_state

  -- ── target functions ──
  union all
  select 200,
         case (select phase from cfg)
           when 'pre' then case when ts.oid is null then 'INFO' when ts.marked then 'INFO' else 'WARN' end
           else case
             when ts.oid is null then 'FAIL'
             when not ts.marked then 'FAIL'
             when ts.prosecdef <> ts.want_def then 'FAIL'
             when ts.proconfig is distinct from array['search_path=public'] then 'FAIL'
             when ts.proowner <> (select owner_oid from cfg) then 'FAIL'
             when ts.default_acl or ts.grantees is distinct from array['authenticated']::text[] then 'FAIL'
             else 'OK' end
         end,
         'target', 'public.' || ts.sig,
         case
           when ts.oid is null then case (select phase from cfg) when 'pre' then 'missing -- the migration creates it' else 'missing' end
           else format('present%s; definer=%s (want %s); config=%s; owner=%s; execute=%s',
                       case when ts.marked then ' (migration 20261124000000)'
                            else ' WITHOUT the migration marker -- the migration compares definitions and aborts on any drift' end,
                       ts.prosecdef, ts.want_def, coalesce(array_to_string(ts.proconfig, ','), '-'),
                       pg_get_userbyid(ts.proowner),
                       case when ts.default_acl then 'PUBLIC (default ACL)' else coalesce(array_to_string(ts.grantees, ','), 'owner only') end)
         end
    from tgt_state ts
  union all
  select 210, 'FAIL', 'target', 'conflicting overload', 'public.' || sig || ' -- the migration refuses to add a second signature'
    from overloads

  -- ── ownership + RLS (definer functions run as the owner of public.orders) ──
  union all
  select 300, case when (select owner_oid from cfg) is null then 'FAIL' else 'INFO' end,
         'owner', 'owner of public.orders',
         coalesce(format('%s (superuser=%s bypassrls=%s)', o.rolname, o.rolsuper, o.rolbypassrls), 'missing')
    from (select 1) x left join owner_role o on true
  union all
  select 301,
         case when rs.oid is null then 'FAIL'
              when rs.relowner <> (select owner_oid from cfg) and not coalesce((select rolbypassrls from owner_role), false) then 'FAIL'
              when rs.forced and not coalesce((select rolbypassrls from owner_role), false) then 'FAIL'
              else 'OK' end,
         'owner', 'table public.' || rs.name,
         case when rs.oid is null then 'missing'
              else format('owner=%s rls=%s force_rls=%s', pg_get_userbyid(rs.relowner), rs.rls, rs.forced) end
    from rel_state rs
  union all
  select 302,
         case when fo.oid is null or (select owner_oid from cfg) is null then 'FAIL'
              when has_function_privilege((select owner_oid from cfg), fo.oid, 'EXECUTE') then 'OK'
              else 'FAIL' end,
         'owner', 'owner can EXECUTE ' || f, ''
    from unnest(array['public.my_client_code()', 'public.is_admin()', 'public.client_name_key(text)',
                      'public.intake_resolve_client(text,text,text)',
                      'public.enqueue_notification(text,text,jsonb,text,text,public.user_role[])']) f
    left join fns fo on fo.sig = f
  union all
  select 303, case when (select owner_oid from cfg) is not null and has_schema_privilege((select owner_oid from cfg), 'public', 'CREATE') then 'OK' else 'FAIL' end,
         'owner', 'owner has CREATE on schema public', ''
  union all
  select 310,
         case when (select owner_oid from cfg) is not null and pg_has_role(me.oid, (select owner_oid from cfg), 'MEMBER')
                   and has_database_privilege(me.oid, current_database(), 'CREATE')
                   and has_schema_privilege(me.oid, 'public', 'CREATE') then 'OK' else 'WARN' end,
         'owner', 'this role can run the migration',
         format('member of owner=%s, CREATE on database=%s, CREATE on public=%s',
                coalesce(pg_has_role(me.oid, (select owner_oid from cfg), 'MEMBER'), false),
                has_database_privilege(me.oid, current_database(), 'CREATE'),
                has_schema_privilege(me.oid, 'public', 'CREATE'))
    from me
  union all
  select 320, case when bad is null then 'OK' else 'WARN' end, 'owner', 'RLS on every table with policies',
         coalesce('POLICIES BUT RLS OFF: ' || bad, 'yes')
    from (select string_agg(c.relname, ', ' order by c.relname) as bad
            from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
             and exists (select 1 from pg_policy p where p.polrelid = c.oid)
             and not c.relrowsecurity) x
  union all
  select 321, case when bad is null then 'OK' else 'WARN' end, 'owner', 'no SECURITY DEFINER function executable by PUBLIC',
         coalesce(bad, 'none')
    from (select string_agg(p.oid::regprocedure::text, ', ') as bad
            from pg_proc p
           where p.pronamespace = 'public'::regnamespace and p.prosecdef
             and has_function_privilege('public', p.oid, 'EXECUTE')) x
  union all
  select 322, 'INFO', 'owner', 'default EXECUTE grants on new functions',
         coalesce(grants || ' (the migration revokes these on its own functions)', 'none')
    from fn_defacl

  -- ── roles the API uses (services/api/src/db.js) ──
  union all
  select 400, case when exists (select 1 from authn) then 'OK' else 'FAIL' end, 'roles', 'role authenticated', ''
  union all
  select 401, case when exists (select 1 from pg_roles where rolname = 'anon') then 'OK' else 'FAIL' end, 'roles', 'role anon', ''
  union all
  select 402, case when not exists (select 1 from svc) then 'WARN'
                   when (select rolbypassrls from svc) and not (select rolcanlogin from svc) then 'OK' else 'WARN' end,
         'roles', 'role service_role (NOLOGIN BYPASSRLS)',
         coalesce((select format('login=%s bypassrls=%s', rolcanlogin, rolbypassrls) from svc), 'missing -- withServiceRole() identity lookup cannot work')
  union all
  select 410, case when not exists (select 1 from app) then 'WARN'
                   when (select rolsuper or rolbypassrls from app) then 'FAIL' else 'OK' end,
         'roles', 'app role ' || (select app_user from cfg),
         coalesce((select format('login=%s superuser=%s bypassrls=%s inherit=%s', rolcanlogin, rolsuper, rolbypassrls, rolinherit) from app),
                  'missing (pass --app-user if production uses another name)')
  union all
  select 411, case when (select rolinherit from app) then 'WARN' else 'OK' end, 'roles', 'app role is NOINHERIT',
         coalesce((select case when rolinherit then 'INHERIT: holds its roles'' rights without SET ROLE' else 'yes' end from app), 'n/a')
    where exists (select 1 from app)
  union all
  select 412, case when pg_has_role((select oid from app), (select oid from authn), 'MEMBER') then 'OK' else 'WARN' end,
         'roles', 'app role can SET ROLE authenticated', 'withUserClaims() needs it for every request'
    where exists (select 1 from app) and exists (select 1 from authn)
  union all
  select 413, case when pg_has_role((select oid from app), (select oid from svc), 'MEMBER') then 'OK' else 'WARN' end,
         'roles', 'app role can SET ROLE service_role', 'withServiceRole() needs it for every sign-in'
    where exists (select 1 from app) and exists (select 1 from svc)

  -- ── notifications ──
  union all
  select 500,
         case when c.charge_types is null then 'WARN'
              when c.charge_types = 2 then (case (select phase from cfg) when 'post' then 'OK' else 'INFO' end)
              else (case (select phase from cfg) when 'post' then 'FAIL' else 'INFO' end) end,
         'notify', 'notification_types charge.approved/declined',
         coalesce(c.charge_types || ' of 2 present', 'UNVERIFIED: this role cannot read every row of notification_types')
    from counts c
  union all
  select 501, 'INFO', 'notify', 'trigger notify_on_order_event on order_events',
         coalesce((select format('%s enabled=%s classifier knows charge events=%s (dedupe keeps one row per recipient either way)',
                                 tgname, tgenabled, knows_charges) from notify_trg limit 1),
                  'absent -- only gcp_resolve_order_charge notifies on a resolution')
  union all
  select 502, case when c.active_admins is null then 'WARN' when c.active_admins = 0 then 'WARN' else 'OK' end,
         'notify', 'active admins with an email (charge.* recipients)',
         coalesce(c.active_admins::text, 'UNVERIFIED: RLS hides profiles from this role')
    from counts c

  -- ── data volume (aggregates only) ──
  union all
  select 600, case when c.orders is null then 'WARN' when c.orders = 0 then 'WARN' else 'OK' end,
         'data', 'orders',
         case when c.orders is null
              then format('UNVERIFIED: RLS filters orders for this role (statistics estimate %s)',
                          coalesce((select n_live_tup::text from rel_state where name = 'orders'), 'n/a'))
              when c.orders = 0 then '0 -- EMPTY: any data-level verification against this database would be vacuous'
              else c.orders::text end
    from counts c
  union all
  select 601, 'INFO', 'data', 'orders with additional fees / pending fees',
         coalesce(c.orders_with_charges || ' / ' || c.pending_charges, 'unverified')
    from counts c
  union all
  select 602, 'INFO', 'data', 'clients', coalesce(c.clients::text, 'unverified')
    from counts c
  union all
  select 603, case when coalesce(c.dangling_profile_codes, 0) = 0 then 'INFO' else 'WARN' end,
         'data', 'profiles whose client_code has no client',
         coalesce(c.dangling_profile_codes || ' (blocks validating the 20261105010000 FK; not part of this migration)', 'unverified')
    from counts c
),
summary as (
  select count(*) filter (where status = 'FAIL') as fails,
         count(*) filter (where status = 'WARN') as warns
    from checks
)
select string_agg(format('%-4s  %-8s %-58s %s', status, area, item, detail), E'\n' order by ord, item) as pf_report,
       (select fails from summary) as pf_fails,
       (select warns from summary) as pf_warns,
       (select fails from summary) = 0 as pf_ok
  from checks \gset

rollback;

\echo :pf_report
\echo
\echo 'preflight phase' :phase '--' :pf_fails 'FAIL,' :pf_warns 'WARN'
\if :pf_ok
\echo 'PREFLIGHT_RESULT=PASS'
\else
\echo 'PREFLIGHT_RESULT=FAIL'
do $$ begin raise exception 'preflight: blocking failure(s) -- see FAIL lines above'; end $$;
\endif
