-- =====================================================================
-- Resolute Portal — Supabase schema (v1)
-- Run in the Supabase SQL editor, or `supabase db push`.
-- Mirrors the app's mock shapes (src/data/mockData.js, src/data/fulfillment.js).
-- =====================================================================

create extension if not exists "pgcrypto";

-- ---- Enums ----------------------------------------------------------
do $$ begin create type user_role as enum
  ('admin','screener','examiner','typer','delivery','client','operator');
exception when duplicate_object then null; end $$;
-- For databases created before 'operator' existed:
alter type user_role add value if not exists 'operator';

do $$ begin create type order_status as enum
  ('received','screening','searching','examining','typing','delivered','onhold');
exception when duplicate_object then null; end $$;
alter type order_status add value if not exists 'delivery';

do $$ begin create type order_priority as enum ('normal','rush');
exception when duplicate_object then null; end $$;

-- ---- profiles (1:1 with auth.users) ---------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  name        text not null default '',
  email       text,
  role        user_role not null default 'client',
  super_admin boolean not null default false,
  client_code text,                       -- set for client-portal users
  status      text not null default 'active',
  created_at  timestamptz not null default now()
);

-- ---- clients --------------------------------------------------------
create table if not exists public.clients (
  code       text primary key,            -- e.g. CL01
  name       text not null,
  contact    text,
  email      text,
  phone      text,
  registered date,
  activity   text,                         -- high | medium | low
  payment    text,
  created_at timestamptz not null default now()
);

-- ---- orders ---------------------------------------------------------
create table if not exists public.orders (
  id              text primary key,        -- e.g. RTS-10048
  client_code     text references public.clients(code),
  state           text,
  county          text,
  type            text,
  status          order_status   not null default 'received',
  priority        order_priority not null default 'normal',
  payment         text,
  clarification   text,
  assigned_to     user_role,               -- role queue currently holding it (null = delivered)
  screener        text,
  examiner        text,
  typer           text,
  delivery        text,
  progress        int  not null default 0,
  created         date,
  eta             date,
  completed       date,
  completed_dates jsonb not null default '{}'::jsonb,  -- { screener: date, ... }
  completed_by    jsonb not null default '{}'::jsonb,  -- { screener: name, ... }
  workflow        jsonb not null default '{}'::jsonb,  -- per-role data: searchAssignment, screenerDoc, examinerDoc, deliveryMethod, ...
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists orders_client_code_idx on public.orders(client_code);
create index if not exists orders_assigned_to_idx on public.orders(assigned_to);

-- ---- fulfillments (document-shaped payload as JSONB) ----------------
-- The Typer fulfillment object is deeply nested and edited as a whole, so it
-- is stored as JSONB keyed by order. Relational tables above are used where
-- we filter / secure (orders, clients, profiles).
create table if not exists public.fulfillments (
  order_id   text primary key references public.orders(id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_by uuid references public.profiles(id),
  updated_at timestamptz not null default now()
);

-- ---- updated_at triggers -------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

drop trigger if exists orders_touch on public.orders;
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

drop trigger if exists fulfillments_touch on public.fulfillments;
create trigger fulfillments_touch before update on public.fulfillments
  for each row execute function public.touch_updated_at();

-- ---- auto-create a profile on sign-up -------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name, email, role)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'name',''),
          new.email,
          coalesce((new.raw_user_meta_data->>'role')::user_role,'client'))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- =====================================================================
-- Row-Level Security
-- SECURITY DEFINER helpers read the caller's profile without RLS recursion.
-- =====================================================================
create or replace function public.my_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid() $$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()) <> 'client', false) $$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select role from public.profiles where id = auth.uid()) = 'admin', false) $$;

create or replace function public.my_client_code()
returns text language sql stable security definer set search_path = public as $$
  select client_code from public.profiles where id = auth.uid() $$;

alter table public.profiles     enable row level security;
alter table public.clients      enable row level security;
alter table public.orders       enable row level security;
alter table public.fulfillments enable row level security;

-- profiles: self or any staff can read; users edit own row; admins manage all
drop policy if exists profiles_read on public.profiles;
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_staff());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update
  using (id = auth.uid() or public.is_admin())
  with check (id = auth.uid() or public.is_admin());

drop policy if exists profiles_admin_write on public.profiles;
create policy profiles_admin_write on public.profiles for all
  using (public.is_admin()) with check (public.is_admin());

-- clients: staff read all; client users read their own; admins write.
-- NOTE: Member-admin "client code only" is enforced in the app layer
-- (displayClient); column-level masking can be added later via a view.
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select
  using (public.is_staff() or code = public.my_client_code());

drop policy if exists clients_admin_write on public.clients;
create policy clients_admin_write on public.clients for all
  using (public.is_admin()) with check (public.is_admin());

-- orders: staff read all; client users read their own
drop policy if exists orders_read on public.orders;
create policy orders_read on public.orders for select
  using (public.is_staff() or client_code = public.my_client_code());

drop policy if exists orders_write_admin on public.orders;
create policy orders_write_admin on public.orders for all
  using (public.is_admin()) with check (public.is_admin());

-- role users may update orders sitting in their own queue
drop policy if exists orders_update_assigned on public.orders;
create policy orders_update_assigned on public.orders for update
  using (public.is_staff() and assigned_to = public.my_role())
  with check (public.is_staff());

drop policy if exists orders_insert_staff on public.orders;
create policy orders_insert_staff on public.orders for insert
  with check (public.is_staff());

-- fulfillments: staff read/write; clients read fulfillment of their orders
drop policy if exists fulfillments_read on public.fulfillments;
create policy fulfillments_read on public.fulfillments for select
  using (public.is_staff()
    or exists (select 1 from public.orders o
               where o.id = fulfillments.order_id and o.client_code = public.my_client_code()));

drop policy if exists fulfillments_write_staff on public.fulfillments;
create policy fulfillments_write_staff on public.fulfillments for all
  using (public.is_staff()) with check (public.is_staff());

-- =====================================================================
-- Storage — private bucket for Title Search / Supplementary uploads
-- Path convention: documents/orders/<order_id>/<filename>
-- =====================================================================
insert into storage.buckets (id, name, public)
values ('documents','documents', false)
on conflict (id) do nothing;

drop policy if exists documents_staff_all on storage.objects;
create policy documents_staff_all on storage.objects for all
  using (bucket_id = 'documents' and public.is_staff())
  with check (bucket_id = 'documents' and public.is_staff());

drop policy if exists documents_client_read on storage.objects;
create policy documents_client_read on storage.objects for select
  using (bucket_id = 'documents'
    and exists (select 1 from public.orders o
                where o.client_code = public.my_client_code()
                  and storage.objects.name like 'orders/' || o.id || '/%'));

-- =====================================================================
-- Seed — clients & orders mirror src/data/mockData.js (safe to re-run).
-- Profiles can't be seeded here (they must link to auth.users); create the
-- staff/client users via Auth, then UPDATE profiles.role / super_admin /
-- client_code. See supabase/seed_profiles.sql for the helper UPDATEs.
-- =====================================================================
insert into public.clients (code,name,contact,email,phone,registered,activity,payment) values
  ('CL01','Lakewood Title Group','Dana Whitfield','dana@lakewoodtitle.com','(305) 555-0142','2025-01-20','high','Wire'),
  ('CL02','Apex Lending Partners','Casey Wilson','casey@apexlending.com','(713) 555-0188','2025-02-04','high','ACH'),
  ('CL03','Sterling Law Firm','Riley Stone','riley@sterlinglaw.com','(213) 555-0119','2025-02-26','medium','Credit Card'),
  ('CL04','Pinnacle Real Estate','Morgan Pratt','morgan@pinnaclere.com','(718) 555-0173','2025-03-12','medium','Invoice (Net-30)'),
  ('CL05','BlueStar Title Agency','Jamie Fox','jamie@bluestartitle.com','(404) 555-0150','2025-04-01','low','Check'),
  ('CL06','Meridian Mortgage LLC','Avery Banks','avery@meridianmtg.com','(216) 555-0137','2025-04-22','low','Wire'),
  ('CL07','Coastal Title Services','Quinn Rivera','quinn@coastaltitle.com','(704) 555-0164','2025-05-15','low','ACH')
on conflict (code) do nothing;

insert into public.orders
  (id,client_code,state,county,type,status,priority,payment,clarification,assigned_to,
   screener,examiner,typer,delivery,progress,created,eta,completed,completed_dates,completed_by) values
  ('RTS-10041','CL01','FL','Miami-Dade','Full Search','examining','rush','Wire',null,'examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',65,'2026-06-09','2026-06-11',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10042','CL02','TX','Harris','Current Owner','delivered','normal','ACH',null,null,
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',100,'2026-06-08','2026-06-10','2026-06-10',
   '{"screener":"2026-06-08","examiner":"2026-06-09","typer":"2026-06-09","delivery":"2026-06-10"}',
   '{"screener":"Sam Carter","examiner":"Jordan Lee","typer":"Priya Nair","delivery":"Morgan Davis"}'),
  ('RTS-10043','CL03','CA','Los Angeles','Two-Owner','examining','normal','Credit Card','responded','examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',45,'2026-06-09','2026-06-12',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10044','CL04','NY','Kings','Lien Search','screening','rush','Invoice (Net-30)','pending','screener',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',10,'2026-06-10','2026-06-11',null,'{}','{}'),
  ('RTS-10045','CL05','GA','Fulton','Full Search','screening','normal','Check','responded','screener',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',25,'2026-06-10','2026-06-13',null,'{}','{}'),
  ('RTS-10046','CL06','OH','Cuyahoga','Tax Certificate','delivered','normal','Wire',null,null,
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',100,'2026-06-07','2026-06-09','2026-06-09',
   '{"screener":"2026-06-07","examiner":"2026-06-08","typer":"2026-06-08","delivery":"2026-06-09"}',
   '{"screener":"Sam Carter","examiner":"Jordan Lee","typer":"Priya Nair","delivery":"Morgan Davis"}'),
  ('RTS-10047','CL07','NC','Mecklenburg','HOA Estoppel','examining','rush','ACH',null,'examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',55,'2026-06-09','2026-06-11',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10048','CL01','AZ','Maricopa','Current Owner','typing','normal','Wire',null,'typer',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',85,'2026-06-08','2026-06-12',null,
   '{"screener":"2026-06-08","examiner":"2026-06-10"}','{"screener":"Sam Carter","examiner":"Jordan Lee"}')
on conflict (id) do nothing;
