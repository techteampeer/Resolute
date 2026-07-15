-- =====================================================================
-- Resolute — vendors, payouts ledger, subscriptions, audit trail, and
-- server-generated order IDs. Schema only; runs on top of the earlier
-- timestamped migrations in this directory. (Demo vendors/subscriptions
-- and all demo logins live in supabase/seed.sql — local dev only.)
-- =====================================================================

-- ── 1) Vendors (abstractor firms the screener can route ABS searches to) ─────
create table if not exists public.vendors (
  code       text primary key,             -- e.g. VN01
  name       text not null,
  contact    text,
  coverage   text,
  cycle      text not null default 'days30' check (cycle in ('weekly','days15','days30')),
  created_at timestamptz not null default now()
);

alter table public.vendors enable row level security;
drop policy if exists vendors_read on public.vendors;
create policy vendors_read on public.vendors for select using (public.is_staff());
drop policy if exists vendors_admin_write on public.vendors;
create policy vendors_admin_write on public.vendors for all
  using (public.is_admin()) with check (public.is_admin());

-- ── 2) Vendor payouts ledger (money OUT, one payable per order) ───────────────
-- The order's workflow JSONB stays authoritative for the UI; this table is the
-- durable, queryable financial record (constrained amounts, FK-checked vendor).
create table if not exists public.vendor_payouts (
  id          uuid primary key default gen_random_uuid(),
  order_id    text not null unique references public.orders(id) on delete cascade,
  vendor_code text not null references public.vendors(code),
  amount      numeric(10,2) not null check (amount >= 0),
  status      text not null default 'accrued' check (status in ('accrued','paid')),
  set_by      text,
  set_at      date,
  paid_by     text,
  paid_at     date,
  reference   text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists vendor_payouts_vendor_idx on public.vendor_payouts(vendor_code, status);

drop trigger if exists vendor_payouts_touch on public.vendor_payouts;
create trigger vendor_payouts_touch before update on public.vendor_payouts
  for each row execute function public.touch_updated_at();

alter table public.vendor_payouts enable row level security;
drop policy if exists vendor_payouts_read on public.vendor_payouts;
create policy vendor_payouts_read on public.vendor_payouts for select using (public.is_staff());
drop policy if exists vendor_payouts_admin_write on public.vendor_payouts;
create policy vendor_payouts_admin_write on public.vendor_payouts for all
  using (public.is_admin()) with check (public.is_admin());

-- ── 3) Recurring subscriptions (title plants / services) ─────────────────────
create table if not exists public.subscriptions (
  id           text primary key,
  name         text not null,
  amount       numeric(10,2) not null check (amount >= 0),
  cycle        text not null default 'days30' check (cycle in ('weekly','days15','days30')),
  last_paid_at date,
  paid_by      text,
  created_at   timestamptz not null default now()
);

alter table public.subscriptions enable row level security;
drop policy if exists subscriptions_read on public.subscriptions;
create policy subscriptions_read on public.subscriptions for select using (public.is_staff());
drop policy if exists subscriptions_admin_write on public.subscriptions;
create policy subscriptions_admin_write on public.subscriptions for all
  using (public.is_admin()) with check (public.is_admin());

-- ── 4) Append-only audit trail ────────────────────────────────────────────────
-- No UPDATE/DELETE policies on purpose: rows can only be added and read.
create table if not exists public.order_events (
  id         bigint generated always as identity primary key,
  order_id   text,
  action     text not null,
  type       text not null default 'status',
  actor      text,
  created_at timestamptz not null default now()
);
create index if not exists order_events_created_idx on public.order_events(created_at desc);
create index if not exists order_events_order_idx on public.order_events(order_id);

alter table public.order_events enable row level security;
drop policy if exists order_events_read on public.order_events;
create policy order_events_read on public.order_events for select using (public.is_staff());
drop policy if exists order_events_insert on public.order_events;
create policy order_events_insert on public.order_events for insert
  with check (public.is_staff());

-- ── 5) Server-generated order IDs (fixes client-side max()+1 race) ───────────
create sequence if not exists public.order_id_seq;
select setval('public.order_id_seq', greatest(
  coalesce((select max(nullif(regexp_replace(id, '\D', '', 'g'), '')::bigint) from public.orders), 10048),
  10048));

create or replace function public.next_order_id()
returns text language sql security definer set search_path = public as
$$ select 'RTS-' || nextval('public.order_id_seq') $$;
grant execute on function public.next_order_id() to authenticated;
