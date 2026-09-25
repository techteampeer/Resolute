-- Email-intake client resolution and atomic order creation.
--
-- POST /api/orders/email-intake receives the client's company name as Gemini
-- read it from the email — never a client code, which the model cannot know.
-- This migration gives the API ONE database function, intake_create_order(),
-- that resolves that name to a clients row and inserts the order in the same
-- transaction, so a client is never created without its order:
--
--   exactly one client matches the normalised name → that client
--   more than one matches                           → 'ambiguous' (the API
--                                                     answers 422, nothing is
--                                                     created)
--   none matches                                    → a NEW client, CL-numbered
--
-- Pieces:
--   client_name_key(name)      the one normalisation rule. Mirrored exactly by
--                              normalizeCompanyName() in
--                              services/email_intake/schema.js.
--   client_code_seq            the CL-number sequence, started above the
--                              highest CL code actually in the table.
--   next_client_code()         CL08, CL09 … CL99, CL100 …
--   intake_resolve_client(...) match-or-create under a per-name lock.
--   intake_create_order(...)   the only function the API calls: resolve the
--                              client, then insert the order, atomically.
--
-- Identity comes from the company name ONLY. The contact name and email are
-- written onto a newly created client as its contact details; they are never
-- used to match one. Clients has no uniqueness on name or email, and a sender
-- address is spoofable.
--
-- Automatic creation assumes the `resolute` Gmail label is a TRUSTED intake
-- queue (a controlled pilot): any email that passes validation there can
-- create a client. Sender allow-listing / provisional clients are future work.
--
-- Nothing else changes: no new column, no RLS policy change, and website and
-- admin orders are placed exactly as before. Idempotent.

-- ── 1) The match key ────────────────────────────────────────────────────────
-- Deterministic, never fuzzy: lower-case; '&' reads as 'and'; apostrophes and
-- full stops are dropped (L.L.C. = LLC, O'Brien = OBrien); any other run of
-- punctuation or whitespace becomes one space; trimmed. Null when nothing is
-- left, so a name of only punctuation can never match or create a client.
--
-- Case-folding is A–Z only (translate, not lower): lower() folds other letters
-- according to the database locale, which would let the same name produce
-- different keys on different databases, and differ from the JavaScript copy.
create or replace function public.client_name_key(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select nullif(btrim(regexp_replace(regexp_replace(
           replace(translate(coalesce(p_name, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                                                   'abcdefghijklmnopqrstuvwxyz'), '&', ' and '),
           '[''’.]', '', 'g'),
           '[^a-z0-9]+', ' ', 'g')), '')
$$;

-- ── 2) The CL-number sequence ───────────────────────────────────────────────
create sequence if not exists public.client_code_seq minvalue 1;

-- Start above the highest numeric CL code in the table AS IT IS NOW; the seed
-- is not assumed to be the whole client list. Codes that are not CL<digits>
-- are ignored. setval(n, true) makes the next value n + 1, so CL07 → CL08; an
-- empty table starts at CL01. It never moves the sequence backwards, so
-- re-running this file cannot reissue a code.
select setval('public.client_code_seq',
              greatest(m.n, s.last_value),
              m.n > 0 or s.is_called)
  from (select coalesce(max(substring(upper(btrim(code)) from '^CL([0-9]{1,18})$')::bigint), 0) as n
          from public.clients) m,
       public.client_code_seq s;

-- ── 3) The next free code ───────────────────────────────────────────────────
create or replace function public.next_client_code()
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  n      bigint;
  v_code text;
begin
  loop
    n := nextval('public.client_code_seq');
    -- lpad() TRUNCATES input longer than the width ('100' at width 2 is '10'),
    -- so the width grows with the number: CL08, CL09 … CL99, CL100.
    v_code := 'CL' || lpad(n::text, greatest(length(n::text), 2), '0');
    -- A code typed in by hand after this migration ran is skipped, not reissued.
    exit when not exists (select 1 from public.clients where upper(btrim(code)) = v_code);
  end loop;
  return v_code;
end;
$$;

-- ── 4) Match or create ──────────────────────────────────────────────────────
-- Returns jsonb:
--   { "status": "matched",   "code": "CL03", "name": "…" }
--   { "status": "created",   "code": "CL08", "name": "…" }
--   { "status": "ambiguous", "codes": ["CL03", "CL09"] }
create or replace function public.intake_resolve_client(
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
  v_key   text := public.client_name_key(p_company);
  v_name  text := btrim(p_company);
  v_codes text[];
  v_names text[];
  v_code  text;
begin
  if v_key is null then
    raise exception 'intake_resolve_client: company is required' using errcode = '22023';
  end if;

  -- One resolution per normalised name at a time. Two emails for the same new
  -- company both queue here; the second then sees the first one's committed
  -- row (each statement of a volatile function takes a fresh snapshot) and
  -- matches it instead of inserting a duplicate. Held to the end of the
  -- transaction, i.e. until the new client is committed.
  perform pg_advisory_xact_lock(hashtextextended('email_intake.client:' || v_key, 0));

  select array_agg(code order by code), array_agg(name order by code)
    into v_codes, v_names
    from public.clients
   where public.client_name_key(name) = v_key;

  if coalesce(array_length(v_codes, 1), 0) > 1 then
    return jsonb_build_object('status', 'ambiguous', 'codes', to_jsonb(v_codes));
  elsif array_length(v_codes, 1) = 1 then
    return jsonb_build_object('status', 'matched', 'code', v_codes[1], 'name', v_names[1]);
  end if;

  -- No match: a new client with the details the email gave. payment_terms,
  -- created_at and every other column keep their normal defaults.
  v_code := public.next_client_code();
  insert into public.clients (code, name, contact, email, registered)
  values (v_code, v_name, nullif(btrim(p_contact), ''), nullif(btrim(p_email), ''), current_date);

  return jsonb_build_object('status', 'created', 'code', v_code, 'name', v_name);
end;
$$;

-- ── 5) Resolve the client and create the order — atomically ────────────────
-- The ONLY function the intake API calls. One RPC is one transaction, so the
-- client and the order commit together or not at all: if the order insert
-- fails for any reason — a lost idempotency race (23505 on the message-id
-- index), a constraint, a trigger — a client created earlier in the same call
-- is rolled back with it. There is deliberately NO exception block: catching
-- an error here would commit the client and drop the order, which is exactly
-- the orphan this function exists to prevent.
--
-- p_order is the row the API built (buildOrderRow in
-- services/email_intake/intake.js) — the same columns a website order writes.
-- The database adds only what it alone can know inside this transaction: the
-- order id, the client code, and the intake client metadata
-- (workflow.intake.clientMatch / clientCode / clientCreated).
--
-- The order id is drawn AFTER the client resolves, so an ambiguous or unknown
-- client (which Apps Script re-sends every run) never burns an order number.
--
-- Returns jsonb:
--   { "status": "created", "clientMatch": "code|name|created", "clientCode": "CL08",
--     "order": { "id", "status", "assigned_to", "client_code", "type" } }
--   { "status": "ambiguous", "codes": ["CL03", "CL09"] }   nothing written
--   { "status": "unknown_client" }                         nothing written
create or replace function public.intake_create_order(
  p_order       jsonb,
  p_company     text default null,
  p_contact     text default null,
  p_email       text default null,
  p_client_code text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_resolved jsonb;
  v_code     text;
  v_name     text;
  v_match    text;
  v_intake   jsonb;
  v_row      jsonb;
  v_order    jsonb;
begin
  -- 1) The client. An explicit code (a trusted caller) is an exact lookup with
  --    no fallback to the name; otherwise the company name is matched, or the
  --    client is created, under the per-name lock.
  if p_client_code is not null then
    select code, name into v_code, v_name from public.clients where code = p_client_code;
    if v_code is null then
      return jsonb_build_object('status', 'unknown_client');
    end if;
    v_match := 'code';
  else
    v_resolved := public.intake_resolve_client(p_company, p_contact, p_email);
    if v_resolved->>'status' = 'ambiguous' then
      return v_resolved;
    end if;
    v_code  := v_resolved->>'code';
    v_name  := v_resolved->>'name';
    v_match := case when v_resolved->>'status' = 'created' then 'created' else 'name' end;
  end if;

  -- 2) The order: the API's row, plus the id (the same sequence the Place Order
  --    form draws from), the client, and the internal client metadata.
  v_intake := coalesce(p_order #> '{workflow,intake}', '{}'::jsonb) || jsonb_build_object(
    'company',       coalesce(p_order #>> '{workflow,intake,company}', v_name),
    'clientMatch',   v_match,
    'clientCode',    v_code,
    'clientCreated', v_match = 'created');
  v_row := p_order || jsonb_build_object(
    'id',          public.next_order_id(),
    'client_code', v_code,
    'workflow',    coalesce(p_order->'workflow', '{}'::jsonb) || jsonb_build_object('intake', v_intake));

  -- Exactly the columns a website order writes; every other column keeps its
  -- default. The AFTER INSERT trigger orders_log_created (the audit event, and
  -- through it the order.new notification) fires inside this transaction.
  insert into public.orders (
    id, client_code, state, county, type, status, priority, payment, clarification,
    client_file_no, assigned_to, screener, examiner, typer, delivery, progress,
    created, eta, completed, completed_dates, completed_by, workflow)
  select
    id, client_code, state, county, type, status, priority, payment, clarification,
    client_file_no, assigned_to, screener, examiner, typer, delivery, progress,
    created, eta, completed, completed_dates, completed_by, workflow
  from jsonb_populate_record(null::public.orders, v_row)
  returning jsonb_build_object('id', id, 'status', status, 'assigned_to', assigned_to,
                               'client_code', client_code, 'type', type)
  into v_order;

  return jsonb_build_object('status', 'created', 'clientMatch', v_match,
                            'clientCode', v_code, 'order', v_order);
end;
$$;

-- ── 6) Server-only ──────────────────────────────────────────────────────────
-- Only the intake API (service role) may create clients this way, and only
-- through intake_create_order; the other functions are its internals.
-- Supabase grants new functions to anon and authenticated by default, so the
-- revoke is explicit: a signed-in browser session must not be able to create
-- clients or orders through PostgREST.
revoke all on function public.client_name_key(text) from public, anon, authenticated;
revoke all on function public.next_client_code() from public, anon, authenticated;
revoke all on function public.intake_resolve_client(text, text, text) from public, anon, authenticated;
revoke all on function public.intake_create_order(jsonb, text, text, text, text) from public, anon, authenticated;
revoke all on sequence public.client_code_seq from public, anon, authenticated;
grant execute on function public.intake_create_order(jsonb, text, text, text, text) to service_role;

-- ── Verify ──────────────────────────────────────────────────────────────────
-- select public.client_name_key('Atlantic Closing & Escrow, L.L.C.');  -- atlantic closing and escrow llc
-- select last_value, is_called from public.client_code_seq;
-- select public.intake_resolve_client('Lakewood Title Group');           -- matched CL01 on the seed
