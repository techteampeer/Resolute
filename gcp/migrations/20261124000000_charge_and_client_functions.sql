-- =====================================================================
-- GCP migration 20261124000000 — charge + client-company functions
-- =====================================================================
-- Target: a Cloud SQL database shaped like resolute_live (PostgreSQL 15) that
-- lacks the functions the GCP API needs for ADR 0003 B1/B2:
--
--   resolve_order_charge(text,text,text)      owner client approves/declines a fee
--   admin_create_client(text,text,text)       admin match-or-create a client company
--   gcp_raise_order_charge(text,text,numeric) staff raise a fee, one transaction
--   gcp_resolve_order_charge(text,text,text)  resolve + EXPLICIT admin notification
--
-- plus the charge.approved / charge.declined notification_types rows they fan
-- out to. This is the "reviewed GCP migration" ADR 0003 and specs B1 §12.1 /
-- B4 "Still open" call for: the behaviour of supabase/migrations 20261104000000,
-- 20261105000000 and 20261117000000 (part 1 + 3), ported -- those files are
-- never run against resolute_live (CLAUDE.md).
--
-- NOT ported, on purpose:
--   * 20261117000000 part 2 (notify_on_order_event classifier): B1 §6 makes the
--     GCP notification EXPLICIT (gcp_resolve_order_charge) instead of a trigger
--     side effect. If a classifier that knows charge events is present anyway,
--     both paths use the order_events id as the dedupe seed, so the outbox
--     still holds exactly one row per recipient.
--   * 20261105010000 (profiles.client_code FK): needs reconciling against the
--     live data first (gcp/preflight.sh reports dangling codes). Separate change.
--
-- HOW IT IS GUARDED
--   0. Prerequisites are checked first -- every problem listed at once, then
--      abort: server version, tables + columns + types, the functions these
--      call (exact signatures), roles, table ownership, FORCE RLS, privileges.
--   1. The four definitions are compiled into a throwaway schema inside this
--      transaction and compared with any copy already in public (source,
--      signature, return type, defaults, SECURITY DEFINER, config, volatility).
--      Missing -> moved into public. Identical -> left as is. DIFFERENT -> abort:
--      a function that drifted in production is never silently replaced.
--   2. Ownership is set to the owner of public.orders. These SECURITY DEFINER
--      functions run as their owner, and on Cloud SQL there is no superuser:
--      only the TABLE OWNER bypasses RLS, so owned by anyone else they would
--      quietly update zero rows.
--   3. EXECUTE is exactly {owner, authenticated}. 20260722000000's default
--      privileges grant every new function to anon/service_role; revoked here.
--   4. Post-conditions are asserted inside the same transaction, including a
--      no-claims call of each function that must be refused. Any failure rolls
--      everything back.
--   5. One transaction. It COMMITS only with  -v apply=true -v confirm_db=<db>
--      where <db> is the connected database; otherwise it rolls back (dry run).
--      gcp/migrate.sh runs it that way, with the read-only preflight around it.
--
-- It changes no existing row: it adds functions and inserts two
-- notification_types rows with ON CONFLICT DO NOTHING (an existing row with
-- that key is reported, not altered).
-- =====================================================================

\set ON_ERROR_STOP on
\if :{?apply}
\else
  \set apply false
\endif
\if :{?confirm_db}
\else
  \set confirm_db ''
\endif

begin;
set local lock_timeout = '5s';
set local statement_timeout = '5min';
-- Deterministic name resolution for everything below, whatever the operator's
-- session had: every object is schema-qualified, and with only pg_catalog on
-- the path a function's regprocedure text is fully qualified, so the guard
-- can look objects up in the catalog without needing USAGE on their schema
-- (to_regprocedure raises "permission denied for schema" instead of
-- returning NULL). The function bodies pin their own search_path.
set local search_path = pg_catalog, pg_temp;

select set_config('resolute_mig.apply', :'apply', true),
       set_config('resolute_mig.confirm_db', :'confirm_db', true);

-- ── 0. Prerequisites ──────────────────────────────────────────────────────
do $guard$
declare
  problems text[] := '{}';
  apply    boolean;
  v_owner  name;
  r        record;
  t        text;
begin
  begin
    apply := current_setting('resolute_mig.apply')::boolean;
  exception when others then
    raise exception 'migration: -v apply must be true or false (got %)', current_setting('resolute_mig.apply');
  end;
  if apply and current_setting('resolute_mig.confirm_db') is distinct from current_database() then
    problems := problems || format('apply=true needs -v confirm_db=%s (got %L)', current_database(),
                                   current_setting('resolute_mig.confirm_db'));
  end if;

  if current_setting('server_version_num')::int < 150000 then
    problems := problems || format('PostgreSQL 15+ required (server is %s)', current_setting('server_version'));
  end if;

  -- Tables and the columns these functions read or write, with their types.
  -- pg_attribute, not information_schema: the latter hides the columns of
  -- tables the connecting role holds no privilege on.
  for r in
    select * from (values
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
      ('public','notification_outbox','dedupe_key','text')
    ) as c(sch, tbl, col, typ)
  loop
    select ty.typname::text into t
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      join pg_type ty on ty.oid = a.atttypid
     where n.nspname = r.sch and c.relname = r.tbl and c.relkind in ('r', 'p') and a.attname = r.col;
    if t is null then
      problems := problems || format('missing column %s.%s.%s', r.sch, r.tbl, r.col);
    elsif t <> r.typ then
      problems := problems || format('column %s.%s.%s is %s, expected %s', r.sch, r.tbl, r.col, t, r.typ);
    end if;
  end loop;

  -- Functions these call, by exact signature.
  foreach t in array array[
    'auth.uid()', 'public.my_client_code()', 'public.is_admin()', 'public.is_staff()',
    'public.client_name_key(text)', 'public.next_client_code()',
    'public.intake_resolve_client(text,text,text)',
    'public.enqueue_notification(text,text,jsonb,text,text,public.user_role[])'
  ] loop
    if not exists (select 1 from pg_proc p where p.oid::regprocedure::text = t) then
      problems := problems || format('missing function %s', t);
    end if;
  end loop;

  foreach t in array array['authenticated', 'anon'] loop
    if not exists (select 1 from pg_roles where rolname = t) then
      problems := problems || format('missing role %s', t);
    end if;
  end loop;

  -- One owner for everything the definer functions touch, and it must actually
  -- bypass RLS on those tables (owner without FORCE, or BYPASSRLS).
  select pg_get_userbyid(c.relowner) into v_owner
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'orders' and c.relkind in ('r', 'p');
  if v_owner is not null then
    for r in
      select c.relname, pg_get_userbyid(c.relowner) as owner, c.relforcerowsecurity as forced
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind in ('r', 'p')
         and c.relname in ('orders', 'clients', 'profiles', 'order_events', 'notification_types',
                           'notification_outbox', 'notification_preferences')
    loop
      if r.owner <> v_owner and not (select rolbypassrls from pg_roles where rolname = v_owner) then
        problems := problems || format('table %s is owned by %s, not %s (definer functions would be RLS-filtered)', r.relname, r.owner, v_owner);
      end if;
      if r.forced and not (select rolbypassrls from pg_roles where rolname = v_owner) then
        problems := problems || format('table %s has FORCE ROW LEVEL SECURITY; its owner would be RLS-filtered', r.relname);
      end if;
    end loop;

    if not pg_has_role(current_user, v_owner, 'MEMBER') then
      problems := problems || format('%s is not a member of %s (the owner of public.orders), so cannot give it these functions', current_user, v_owner);
    end if;
    if not has_schema_privilege(v_owner, 'public', 'CREATE') then
      problems := problems || format('%s lacks CREATE on schema public', v_owner);
    end if;
    foreach t in array array[
      'public.my_client_code()', 'public.is_admin()', 'public.client_name_key(text)',
      'public.intake_resolve_client(text,text,text)',
      'public.enqueue_notification(text,text,jsonb,text,text,public.user_role[])'
    ] loop
      if exists (select 1 from pg_proc p where p.oid::regprocedure::text = t
                  and not has_function_privilege(v_owner, p.oid, 'EXECUTE')) then
        problems := problems || format('%s cannot EXECUTE %s', v_owner, t);
      end if;
    end loop;
  else
    problems := problems || 'missing table public.orders';
  end if;

  if not has_schema_privilege(current_user, 'public', 'CREATE') then
    problems := problems || format('%s lacks CREATE on schema public', current_user);
  end if;
  if not has_database_privilege(current_user, current_database(), 'CREATE') then
    problems := problems || format('%s lacks CREATE on database %s (needed for the transaction-local staging schema)', current_user, current_database());
  end if;
  if to_regnamespace('resolute_gcp_mig_staging') is not null then
    problems := problems || 'schema resolute_gcp_mig_staging already exists (left over from an interrupted run?)';
  end if;

  -- A same-named function with a DIFFERENT signature would make callers
  -- ambiguous or hit the wrong body; refuse rather than add an overload.
  for r in
    select p.oid::regprocedure::text as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('resolve_order_charge', 'admin_create_client',
                         'gcp_raise_order_charge', 'gcp_resolve_order_charge')
       and p.oid::regprocedure::text not in (
         'public.resolve_order_charge(text,text,text)', 'public.admin_create_client(text,text,text)',
         'public.gcp_raise_order_charge(text,text,numeric)', 'public.gcp_resolve_order_charge(text,text,text)')
  loop
    problems := problems || format('conflicting overload %s exists', r.sig);
  end loop;

  if cardinality(problems) > 0 then
    raise exception 'migration 20261124000000: % prerequisite(s) unmet:%', cardinality(problems),
      E'\n  - ' || array_to_string(problems, E'\n  - ')
      using hint = 'Run gcp/preflight.sh for the full report. Nothing was changed.';
  end if;
  raise notice 'prerequisites ok (functions will be owned by %)', v_owner;
end
$guard$;

-- ── 1. Compile the definitions into a transaction-local staging schema ────
create schema resolute_gcp_mig_staging;

-- 1a. Verbatim from supabase/migrations/20261117000000 (supersedes 20261105000000).
create function resolute_gcp_mig_staging.resolve_order_charge(p_order_id text, p_charge_id text, p_decision text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_amount numeric;
begin
  if p_decision not in ('approved', 'declined') then
    raise exception 'resolve_order_charge: decision must be approved or declined (got %)', p_decision;
  end if;

  -- Capture the charge amount for the audit line, scoped exactly like the update.
  select (c->>'amount')::numeric into v_amount
    from public.orders o
    cross join lateral jsonb_array_elements(coalesce(o.workflow->'pendingCharges', '[]'::jsonb)) c
   where o.id = p_order_id
     and o.client_code = public.my_client_code()
     and c->>'id' = p_charge_id
     and coalesce(c->>'status', 'pending') = 'pending'
   limit 1;

  update public.orders
     set workflow = jsonb_set(
           coalesce(workflow, '{}'::jsonb),
           '{pendingCharges}',
           (
             select coalesce(jsonb_agg(
               case
                 when c->>'id' = p_charge_id and coalesce(c->>'status', 'pending') = 'pending'
                 then c || jsonb_build_object('status', p_decision, 'resolvedAt', to_char(now(), 'YYYY-MM-DD'))
                 else c
               end
               order by ord), '[]'::jsonb)
             from jsonb_array_elements(coalesce(workflow->'pendingCharges', '[]'::jsonb)) with ordinality as t(c, ord)
           ),
           true)
   where id = p_order_id
     and client_code = public.my_client_code()
     and exists (
       select 1 from jsonb_array_elements(coalesce(workflow->'pendingCharges', '[]'::jsonb)) c
        where c->>'id' = p_charge_id and coalesce(c->>'status', 'pending') = 'pending'
     );
  if not found then
    raise exception 'resolve_order_charge: order not found, not owned, or no pending charge %', p_charge_id;
  end if;

  insert into public.order_events (order_id, action, type, actor, actor_email, audience)
  values (
    p_order_id,
    format('Client %s an additional fee of $%s on %s',
           p_decision,
           to_char(coalesce(v_amount, 0), 'FM999,999,990.00'),
           p_order_id),
    'status', 'Client', null, 'all');
end;
$$;

-- 1b. Verbatim from supabase/migrations/20261104000000.
create function resolute_gcp_mig_staging.admin_create_client(
  p_company text,
  p_contact text default null,
  p_email   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolved jsonb;
begin
  -- Admins only. is_admin() reads the CALLER's auth.uid() even though this
  -- function runs as its owner, so a client or an unauthenticated caller is
  -- rejected here before any client row can be created.
  if not public.is_admin() then
    raise exception 'admin_create_client: admin only' using errcode = '42501';
  end if;

  if public.client_name_key(p_company) is null then
    raise exception 'admin_create_client: company name is required' using errcode = '22023';
  end if;

  -- Same resolver the email intake uses: match one existing client by normalised
  -- name, return 'ambiguous' when several match, or create a new CL client under
  -- the per-name lock. Returns { status: matched|created|ambiguous, code?, name?, codes? }.
  v_resolved := public.intake_resolve_client(p_company, p_contact, p_email);
  return v_resolved;
end;
$$;

-- 1c. Raise a pending fee in ONE statement-level transaction (B1 §3.1/§5.2).
-- SECURITY INVOKER on purpose: it runs as the caller (`authenticated` with the
-- request's claims), so the orders UPDATE policies are the real guard exactly
-- as on the repo's raise path -- Admin via orders_write_admin, a production
-- user only on an order assigned to them (orders_update_assigned). Mirrors
-- services/api/src/charges.js (validateRaise, buildPendingCharge,
-- raiseEventAction) so the stored charge and the activity line are identical.
-- Raising notifies nobody by mail (the classifier ignores this wording); the
-- client sees the line in-portal.
-- SQLSTATEs the API maps: 42501 -> 403, 22023 -> 422, P0002 -> 404.
create function resolute_gcp_mig_staging.gcp_raise_order_charge(p_order_id text, p_label text, p_amount numeric)
returns jsonb
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_label  text := btrim(coalesce(p_label, ''));
  v_name   text;
  v_role   text;
  v_email  text;
  v_charge jsonb;
  v_rows   int;
begin
  if auth.uid() is null then
    raise exception 'gcp_raise_order_charge: not authenticated' using errcode = '42501';
  end if;
  if not public.is_staff() then
    raise exception 'gcp_raise_order_charge: only staff can raise a fee' using errcode = '42501';
  end if;
  if length(v_label) < 1 or length(v_label) > 120 then
    raise exception 'gcp_raise_order_charge: label must be 1-120 characters' using errcode = '22023';
  end if;
  if p_amount is null or not (p_amount > 0 and p_amount <= 1000000) then
    raise exception 'gcp_raise_order_charge: amount must be a positive number up to 1000000 (got %)', p_amount
      using errcode = '22023';
  end if;

  -- Visible under orders_read? A row the caller cannot see is "not found".
  perform 1 from public.orders where id = p_order_id;
  if not found then
    raise exception 'gcp_raise_order_charge: order % not found', p_order_id using errcode = 'P0002';
  end if;

  select name, role::text, email into v_name, v_role, v_email
    from public.profiles where id = auth.uid();

  v_charge := jsonb_build_object(
    'id',           'chg_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16),
    'label',        v_label,
    'amount',       p_amount,
    'raisedBy',     coalesce(nullif(v_name, ''), 'Resolute'),
    'raisedByRole', v_role,
    'raisedAt',     to_char(now() at time zone 'UTC', 'YYYY-MM-DD'),
    'status',       'pending',
    'resolvedAt',   null);

  -- Append under the UPDATE policy and the row lock: two concurrent raises
  -- both land, because the SET is recomputed on the latest row version.
  update public.orders
     set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{pendingCharges}',
                              coalesce(workflow->'pendingCharges', '[]'::jsonb) || jsonb_build_array(v_charge),
                              true)
   where id = p_order_id;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'gcp_raise_order_charge: you cannot modify order %', p_order_id using errcode = '42501';
  end if;

  insert into public.order_events (order_id, action, type, actor, actor_email, audience)
  values (p_order_id,
          format('Additional fee of $%s requested on %s — awaiting approval',
                 to_char(p_amount, 'FM999,999,990.00'), p_order_id),
          'status', 'Resolute', v_email, 'all');

  return v_charge;
end;
$$;

-- 1d. Resolve + notify explicitly (B1 §5.1 + §6). Delegates the decision to
-- resolve_order_charge verbatim (own order via my_client_code(), pending-only,
-- row-locked, audit line), then enqueues charge.approved|declined for the admin
-- tier itself instead of relying on the order_events trigger. SECURITY DEFINER
-- because enqueue_notification is not executable by session roles; it adds no
-- authority of its own -- resolve_order_charge decides, under the caller's
-- claims, and every refusal rolls the whole call back.
-- SQLSTATEs: 42501 not a client / not signed in, 22023 bad decision,
-- P0001 not found / not owned / not pending (resolve_order_charge's message).
create function resolute_gcp_mig_staging.gcp_resolve_order_charge(p_order_id text, p_charge_id text, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type     text;
  v_before   bigint[];
  v_event    public.order_events%rowtype;
  v_order    public.orders%rowtype;
  v_charge   jsonb;
  v_client   text;
  v_notified int;
begin
  if auth.uid() is null then
    raise exception 'gcp_resolve_order_charge: not authenticated' using errcode = '42501';
  end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then
    raise exception 'gcp_resolve_order_charge: decision must be approved or declined (got %)', p_decision
      using errcode = '22023';
  end if;
  if public.my_client_code() is null then
    raise exception 'gcp_resolve_order_charge: only the owning client can resolve a fee' using errcode = '42501';
  end if;

  v_type := case p_decision when 'approved' then 'charge.approved' else 'charge.declined' end;
  if not exists (select 1 from public.notification_types where key = v_type) then
    raise exception 'gcp_resolve_order_charge: notification type % is not installed', v_type using errcode = '55000';
  end if;

  select coalesce(array_agg(id), '{}') into v_before
    from public.order_events where order_id = p_order_id;

  perform public.resolve_order_charge(p_order_id, p_charge_id, p_decision);

  select * into v_order from public.orders where id = p_order_id;
  select c into v_charge
    from jsonb_array_elements(coalesce(v_order.workflow->'pendingCharges', '[]'::jsonb)) c
   where c->>'id' = p_charge_id
   limit 1;
  select name into v_client from public.clients where code = v_order.client_code;

  -- The audit row resolve_order_charge just wrote: new since the snapshot and
  -- worded exactly as it words it. Newest wins: any competing resolve on this
  -- order queued behind our row lock, so it cannot have committed a newer one.
  select * into v_event
    from public.order_events
   where order_id = p_order_id
     and id <> all (v_before)
     and action = format('Client %s an additional fee of $%s on %s', p_decision,
                         to_char(coalesce((v_charge->>'amount')::numeric, 0), 'FM999,999,990.00'),
                         p_order_id)
   order by id desc
   limit 1;
  if not found then
    raise exception 'gcp_resolve_order_charge: resolution of % on % left no audit event', p_charge_id, p_order_id;
  end if;

  -- Same payload shape notify_on_order_event() builds, so services/notify
  -- renders it with the same template either way.
  v_notified := public.enqueue_notification(
    v_type, p_order_id,
    jsonb_build_object(
      'orderId',      p_order_id,
      'action',       v_event.action,
      'actor',        v_event.actor,
      'occurredAt',   v_event.created_at,
      'clientName',   v_client,
      'clientCode',   v_order.client_code,
      'clientFileNo', v_order.client_file_no,
      'orderType',    v_order.type,
      'state',        v_order.state,
      'county',       v_order.county,
      'priority',     v_order.priority,
      'status',       v_order.status,
      'assignedTo',   v_order.assigned_to,
      'eta',          v_order.eta),
    -- The trigger's dedupe seed for this event: if a charge-aware classifier
    -- also fires, the outbox keeps one row per recipient.
    v_event.id::text,
    null);

  return jsonb_build_object(
    'orderId',    p_order_id,
    'chargeId',   p_charge_id,
    'decision',   p_decision,
    'amount',     v_charge->'amount',
    'resolvedAt', v_charge->>'resolvedAt',
    'eventId',    v_event.id,
    'notified',   v_notified);
end;
$$;

-- ── 2. Compare with what is already in public; move in what is missing ────
create temporary table resolute_mig_plan (fn text primary key, action text not null) on commit drop;

do $compare$
declare
  sig    text;
  s      pg_proc%rowtype;
  p      pg_proc%rowtype;
  drift  text[] := '{}';
begin
  foreach sig in array array[
    'resolve_order_charge(text,text,text)', 'admin_create_client(text,text,text)',
    'gcp_raise_order_charge(text,text,numeric)', 'gcp_resolve_order_charge(text,text,text)'
  ] loop
    select * into strict s from pg_proc where oid = to_regprocedure('resolute_gcp_mig_staging.' || sig);
    select * into p from pg_proc where oid = to_regprocedure('public.' || sig);
    if not found then
      insert into resolute_mig_plan values (sig, 'create');
    elsif p.prosrc is distinct from s.prosrc
       or p.prorettype <> s.prorettype or p.proretset <> s.proretset
       or p.prosecdef <> s.prosecdef or p.provolatile <> s.provolatile
       or p.proisstrict <> s.proisstrict or p.prolang <> s.prolang
       or p.proconfig is distinct from s.proconfig
       or p.proargnames is distinct from s.proargnames
       or pg_get_function_arguments(p.oid) is distinct from pg_get_function_arguments(s.oid) then
      drift := drift || ('public.' || sig);
    else
      insert into resolute_mig_plan values (sig, 'identical');
    end if;
  end loop;

  if cardinality(drift) > 0 then
    raise exception 'migration 20261124000000: existing definition differs from this migration: %',
      array_to_string(drift, ', ')
      using hint = 'Production drifted from the reviewed definition. Reconcile by hand; nothing was changed.';
  end if;
end
$compare$;

do $move$
declare r record;
begin
  for r in select fn from resolute_mig_plan where action = 'create' loop
    execute format('alter function resolute_gcp_mig_staging.%s set schema public', r.fn);
  end loop;
end
$move$;

drop schema resolute_gcp_mig_staging cascade;

-- ── 3. Ownership, EXECUTE, provenance ─────────────────────────────────────
do $acl$
declare
  v_owner name;
  sig     text;
  f       regprocedure;
  g       record;
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'public.orders'::regclass;
  foreach sig in array array[
    'resolve_order_charge(text,text,text)', 'admin_create_client(text,text,text)',
    'gcp_raise_order_charge(text,text,numeric)', 'gcp_resolve_order_charge(text,text,text)'
  ] loop
    f := ('public.' || sig)::regprocedure;
    execute format('alter function public.%s owner to %I', sig, v_owner);
    execute format('revoke all on function public.%s from public', sig);
    for g in
      select distinct a.grantee
        from pg_proc p, aclexplode(p.proacl) a
       where p.oid = f and a.grantee <> 0 and a.grantee <> p.proowner
    loop
      execute format('revoke all on function public.%s from %I', sig, pg_get_userbyid(g.grantee));
    end loop;
    execute format('grant execute on function public.%s to authenticated', sig);
    execute format('comment on function public.%s is %L', sig,
      'resolute gcp migration 20261124000000 (ADR 0003 B1/B2). Change only through a new reviewed gcp/migrations file.');
  end loop;
end
$acl$;

-- ── 4. The notification types gcp_resolve_order_charge fans out to ────────
-- Verbatim rows from supabase/migrations/20261117000000 part 1. An existing row
-- is left exactly as it is (it may carry deliberate production edits).
insert into public.notification_types (key, label, description, default_roles, default_mode, sort_order) values
  ('charge.approved', 'Additional fee approved',
   'A client approved an additional fee — it is added to the order invoice.',
   '{admin}'::public.user_role[], 'immediate', 70),
  ('charge.declined', 'Additional fee declined',
   'A client declined an additional fee — it will not be billed.',
   '{admin}'::public.user_role[], 'immediate', 71)
on conflict (key) do nothing;

-- ── 5. Post-conditions (still inside the transaction) ─────────────────────
do $post$
declare
  v_owner  name;
  sig      text;
  f        regprocedure;
  p        pg_proc%rowtype;
  problems text[] := '{}';
  want_def boolean;
  r        record;
  roles    text[];
begin
  select pg_get_userbyid(relowner) into v_owner from pg_class where oid = 'public.orders'::regclass;

  foreach sig in array array[
    'resolve_order_charge(text,text,text)', 'admin_create_client(text,text,text)',
    'gcp_raise_order_charge(text,text,numeric)', 'gcp_resolve_order_charge(text,text,text)'
  ] loop
    f := to_regprocedure('public.' || sig);
    if f is null then
      problems := problems || format('public.%s missing', sig);
      continue;
    end if;
    select * into p from pg_proc where oid = f;
    want_def := sig <> 'gcp_raise_order_charge(text,text,numeric)';
    if p.prosecdef <> want_def then
      problems := problems || format('%s SECURITY DEFINER is %s, expected %s', sig, p.prosecdef, want_def);
    end if;
    if p.proconfig is distinct from array['search_path=public'] then
      problems := problems || format('%s config is %s, expected search_path=public', sig, p.proconfig);
    end if;
    if pg_get_userbyid(p.proowner) <> v_owner then
      problems := problems || format('%s owned by %s, expected %s', sig, pg_get_userbyid(p.proowner), v_owner);
    end if;
    if has_function_privilege('public', f, 'EXECUTE') then
      problems := problems || format('%s executable by PUBLIC', sig);
    end if;
    if has_function_privilege('anon', f, 'EXECUTE') then
      problems := problems || format('%s executable by anon', sig);
    end if;
    if not has_function_privilege('authenticated', f, 'EXECUTE') then
      problems := problems || format('%s not executable by authenticated', sig);
    end if;
    select array_agg(distinct pg_get_userbyid(a.grantee) order by pg_get_userbyid(a.grantee)) into roles
      from aclexplode(p.proacl) a where a.grantee <> p.proowner;
    if roles is distinct from array['authenticated']::text[] then
      problems := problems || format('%s EXECUTE grantees are %s, expected {authenticated}', sig, roles);
    end if;
  end loop;

  if to_regnamespace('resolute_gcp_mig_staging') is not null then
    problems := problems || 'staging schema still present';
  end if;

  for r in select k from unnest(array['charge.approved', 'charge.declined']) k loop
    if not exists (select 1 from public.notification_types where key = r.k) then
      problems := problems || format('notification type %s missing', r.k);
    elsif not exists (select 1 from public.notification_types where key = r.k and 'admin' = any (default_roles)) then
      raise notice 'notification type % exists but does not reach admin by default -- kept as found', r.k;
    end if;
  end loop;

  -- No-claims calls must be refused before touching anything. (This session
  -- has no request.jwt.claims, so auth.uid() is null.)
  if auth.uid() is not null then
    problems := problems || 'post-check session unexpectedly carries claims';
  else
    begin
      perform public.admin_create_client('Post-check Probe Co');
      problems := problems || 'admin_create_client accepted a call with no claims';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.gcp_raise_order_charge('__post_check__', 'probe', 1);
      problems := problems || 'gcp_raise_order_charge accepted a call with no claims';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.gcp_resolve_order_charge('__post_check__', 'probe', 'approved');
      problems := problems || 'gcp_resolve_order_charge accepted a call with no claims';
    exception when insufficient_privilege then null;
    end;
    begin
      perform public.resolve_order_charge('__post_check__', 'probe', 'approved');
      problems := problems || 'resolve_order_charge resolved a charge with no claims';
    exception when raise_exception then null;
    end;
  end if;

  if cardinality(problems) > 0 then
    raise exception 'migration 20261124000000: post-condition(s) failed:%',
      E'\n  - ' || array_to_string(problems, E'\n  - ');
  end if;

  raise notice 'post-conditions ok: %', (
    select string_agg(fn || '=' || action, ', ' order by fn) from resolute_mig_plan);
end
$post$;

\if :apply
commit;
\echo 'migration 20261124000000: APPLIED (committed)'
\else
rollback;
\echo 'migration 20261124000000: DRY RUN -- rolled back, nothing changed'
\endif
