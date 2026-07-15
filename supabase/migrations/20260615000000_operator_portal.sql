-- =====================================================================
-- Resolute — consolidated migration: "Operator" feature → latest
-- Baseline: the init migration (20260601000000_init.sql). Safe / idempotent.
--
-- Enum note: on a fresh database both values below already exist from init
-- (no-ops here); the guards keep this re-runnable on older databases. New
-- enum values from a PREVIOUS migration are always usable here because the
-- CLI runs each migration file in its own transaction.
-- =====================================================================

-- ── PART 1 — Enum additions ─────────────────────────────────────────────────
-- Operator role (all-in-one portal) + "Out for Delivery" order status.
alter type user_role    add value if not exists 'operator';
alter type order_status add value if not exists 'delivery';

-- ── PART 2 — Schema (prerequisite column; pre-Operator, guarded for safety) ──
-- Per-role workflow data: search assignment, screener/examiner docs,
-- delivery method + invoice flag, commitment document, email intake, etc.
alter table public.orders
  add column if not exists workflow jsonb not null default '{}'::jsonb;

-- ── PART 3 — Data: align existing order statuses with their owning role ──────
-- Status is now DERIVED from assigned_to (one stage at a time, fixed order);
-- this clears the legacy 6-step "searching" drift. Idempotent (re-runnable).
update public.orders
set status = (case
  when assigned_to = 'screener' then 'screening'
  when assigned_to = 'examiner' then 'examining'
  when assigned_to = 'typer'    then 'typing'
  when assigned_to = 'delivery' then 'delivery'
  when assigned_to is null      then 'delivered'
  else status::text
end)::order_status;


-- =====================================================================
-- VERIFY — resulting schema matches the current application codebase
-- =====================================================================
-- Expect user_role to include 'operator'; order_status to include 'delivery'.
select 'user_role'   as enum, array_agg(v order by v) as values
from unnest(enum_range(null::user_role)::text[])   v
union all
select 'order_status', array_agg(v order by v)
from unnest(enum_range(null::order_status)::text[]) v;

-- Expect one row: orders.workflow, jsonb.
select column_name, data_type
from information_schema.columns
where table_schema = 'public' and table_name = 'orders' and column_name = 'workflow';

-- Sanity: current status distribution after realignment.
select assigned_to, status, count(*)
from public.orders group by assigned_to, status order by assigned_to;
