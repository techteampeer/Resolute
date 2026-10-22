-- =====================================================================
-- Company profile (client_profiles) — the CLIENT-EDITABLE half of Company
-- Settings (#13 hybrid). The admin-managed facts (code, name, payment terms,
-- status) stay on `clients` (super-admin-only, surfaced read-only to the client
-- via client_directory). The company's own details it maintains itself —
-- address, phone, website, logo — live here, one row per company.
--
-- Isolation mirrors client_contacts: a client reads/writes only their own row
-- (client_code = my_client_code()); admins manage all via is_admin() (NEVER
-- is_staff(), so production users see nothing). One profile per company (PK).
-- =====================================================================

create table if not exists public.client_profiles (
  client_code text primary key references public.clients(code) on delete cascade,
  address     text,
  city        text,
  state       text,
  zip         text,
  phone       text,
  website     text,
  logo_url    text,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

alter table public.client_profiles enable row level security;

-- Client: full management of their OWN company's profile, pinned to their code.
drop policy if exists client_profiles_client_all on public.client_profiles;
create policy client_profiles_client_all on public.client_profiles for all
  using (client_code = public.my_client_code())
  with check (client_code = public.my_client_code());

-- Admins (not production users) manage every company's profile.
drop policy if exists client_profiles_admin_all on public.client_profiles;
create policy client_profiles_admin_all on public.client_profiles for all
  using (public.is_admin())
  with check (public.is_admin());
