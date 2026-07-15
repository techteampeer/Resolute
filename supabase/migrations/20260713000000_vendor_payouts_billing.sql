-- =====================================================================
-- Resolute — vendors, payouts ledger, subscriptions, audit trail, order IDs,
-- and demo-user seeding. Idempotent; runs on top of the earlier
-- timestamped migrations in this directory.
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

insert into public.vendors (code, name, contact, coverage, cycle) values
  ('VN01','Meridian Abstracting LLC','Paul Ortiz','FL · GA · SC','weekly'),
  ('VN02','TitleTrace Abstractors','Gina Malone','TX · OK · LA','days15'),
  ('VN03','Keystone Search Group','Ed Novak','NY · NJ · PA','days30')
on conflict (code) do nothing;

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

insert into public.subscriptions (id, name, amount, cycle) values
  ('sub1','DataTree Title Plant',299,'days30'),
  ('sub2','NetOnline County Access',149,'days30')
on conflict (id) do nothing;

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

-- ── 6) Seed the demo accounts (mirrors src/context/AuthContext.jsx) ──────────
-- Same technique payment_system.sql used for Vivek. Change these passwords
-- before real client data enters the system.
create or replace function public._seed_user(
  p_email text, p_pass text, p_name text, p_role user_role,
  p_super boolean default false, p_client text default null
) returns void language plpgsql security definer set search_path = public, extensions as $$
declare uid uuid;
begin
  select id into uid from auth.users where email = p_email;
  if uid is null then
    uid := gen_random_uuid();
    insert into auth.users (
      instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
      raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
      confirmation_token, recovery_token, email_change, email_change_token_new,
      email_change_token_current, phone_change, phone_change_token, reauthentication_token
    ) values (
      '00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated',
      p_email, crypt(p_pass, gen_salt('bf')), now(),
      '{"provider":"email","providers":["email"]}',
      jsonb_build_object('name', p_name, 'role', p_role::text), now(), now(),
      '', '', '', '', '', '', '', ''
    );
    insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
    values (gen_random_uuid(), uid, uid::text,
      jsonb_build_object('sub', uid::text, 'email', p_email), 'email', now(), now(), now());
  end if;
  insert into public.profiles (id, email, name, role, super_admin, client_code)
  values (uid, p_email, p_name, p_role, p_super, p_client)
  on conflict (id) do update
    set name = excluded.name, role = excluded.role,
        super_admin = excluded.super_admin, client_code = excluded.client_code;
end $$;

select public._seed_user('rajni@resolute.com',    'admin123',    'Rajni',         'admin',    true);
select public._seed_user('saravanan@resolute.com','admin123',    'Saravanan',     'admin',    true);
select public._seed_user('vivek@resolute.com',    'vivek123',    'Vivek',         'admin',    true);
select public._seed_user('admin@resolute.com',    'admin123',    'Alex Morrison', 'admin',    false);
select public._seed_user('screener@resolute.com', 'screener123', 'Sam Carter',    'screener');
select public._seed_user('examiner@resolute.com', 'examiner123', 'Jordan Lee',    'examiner');
select public._seed_user('typer@resolute.com',    'typer123',    'Priya Nair',    'typer');
select public._seed_user('delivery@resolute.com', 'delivery123', 'Morgan Davis',  'delivery');
select public._seed_user('client@resolute.com',   'client123',   'Taylor Brooks', 'client',   false, 'CL01');
select public._seed_user('operator@resolute.com', 'operator123', 'Jordan Blake',  'operator');

drop function public._seed_user(text, text, text, user_role, boolean, text);
