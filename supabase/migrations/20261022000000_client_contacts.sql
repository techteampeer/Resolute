-- =====================================================================
-- Per-company people directory (client_contacts). Captures the person who
-- places an order (name / email / phone / title + a marketing opt-in) so the
-- placer can be re-selected next time and so Resolute can build a marketing
-- list with explicit consent.
--
-- PII model (CLAUDE.md, extended to people): a company's contacts are visible
-- ONLY to that company and to ADMINS. Production users (screener / Search QC /
-- examiner / typer / Typing QC / delivery — role 'user') must NEVER see client
-- contact PII, exactly as they see client CODES, not names. So the staff-side
-- policy keys on is_admin(), never is_staff(). Isolation otherwise mirrors
-- support_messages: a client sees/writes only their own (client_code =
-- my_client_code()).
-- =====================================================================

create table if not exists public.client_contacts (
  id               uuid primary key default gen_random_uuid(),
  client_code      text not null,
  name             text not null,
  email            text,
  phone            text,
  title            text,
  marketing_opt_in boolean not null default false,
  created_by       text,                      -- who added them (admin name, or 'client')
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists client_contacts_code_idx
  on public.client_contacts (client_code, name);

alter table public.client_contacts enable row level security;

-- Client: full management of their OWN company's people, and nobody else's. The
-- with-check pins client_code to their own, so a contact can't be moved to or
-- from another company.
drop policy if exists client_contacts_client_all on public.client_contacts;
create policy client_contacts_client_all on public.client_contacts for all
  using (client_code = public.my_client_code())
  with check (client_code = public.my_client_code());

-- Admins (NOT production users): manage every company's directory. is_admin(),
-- never is_staff() — a production user matches neither policy and so sees no
-- contact rows at all.
drop policy if exists client_contacts_admin_all on public.client_contacts;
create policy client_contacts_admin_all on public.client_contacts for all
  using (public.is_admin())
  with check (public.is_admin());
