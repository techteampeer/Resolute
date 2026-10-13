-- =====================================================================
-- Client PII is for super admins; everyone else gets the directory
-- =====================================================================
-- RECONSTRUCTED FROM PRODUCTION. This migration was applied straight to the
-- production project and never committed, so `supabase_migrations` listed
-- 20260909120000_client_pii_super_admin_only while supabase/migrations/ did not
-- contain it — a rebuild from this directory would not have reproduced
-- production. The statements column in the remote history was null, so the SQL
-- below was rebuilt from the live schema (policies, the view definition, the
-- function body and the grants) and verified object-for-object against it.
--
-- What it does, and why the app has to know about it:
--
--   clients_read was `is_staff() OR code = my_client_code()`, so every screener,
--   examiner, typer and plain admin could read a client's name, contact, email
--   and phone. It is now `is_super_admin() OR code = my_client_code()`. Only
--   Rajni, Saravanan and Vivek see who a client actually is; everyone else sees
--   the code, which is what displayClient has always rendered in the UI.
--
--   Staff still need the client list to do their jobs — to group invoices, to
--   pick a client when Admin places an order. public.client_directory is that
--   list with the PII columns left out: code, payment_terms, activity,
--   registered, and nothing that names a company or a person.
--
-- The view is intentionally NOT security_invoker: it runs as its owner so it can
-- read past clients_read, and carries its own `is_staff() OR code =
-- my_client_code()` guard instead. Supabase's advisor flags that shape
-- (security_definer_view) — here it is the mechanism, not an oversight, and the
-- guard is what keeps a client to their own row.
-- =====================================================================

-- Who is a super admin. Same shape as is_admin()/is_staff(): SECURITY DEFINER so
-- it can read profiles under RLS, STABLE so the planner may cache it per
-- statement, and a pinned search_path.
create or replace function public.is_super_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select super_admin from public.profiles where id = auth.uid()), false)
$$;

grant execute on function public.is_super_admin() to anon, authenticated;

-- Reads: super admins only (plus a client reading its own row).
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients
  for select
  using (public.is_super_admin() or code = public.my_client_code());

-- Writes stay with every admin, but as three explicit policies rather than one
-- `for all` — a `for all` policy also grants SELECT, which would have handed the
-- names straight back to any admin and undone the line above.
drop policy if exists clients_admin_write  on public.clients;
drop policy if exists clients_admin_insert on public.clients;
drop policy if exists clients_admin_update on public.clients;
drop policy if exists clients_admin_delete on public.clients;

create policy clients_admin_insert on public.clients
  for insert with check (public.is_admin());
create policy clients_admin_update on public.clients
  for update using (public.is_admin()) with check (public.is_admin());
create policy clients_admin_delete on public.clients
  for delete using (public.is_admin());

-- The non-PII client list every staff member may read.
create or replace view public.client_directory as
  select code, payment_terms, activity, registered
  from public.clients c
  where public.is_staff() or code = public.my_client_code();

grant select on public.client_directory to authenticated;

comment on view public.client_directory is
  'Client list without PII — code, terms, activity and registration date only. '
  'Staff read this; only super admins may read public.clients, which carries the '
  'company name and contact details.';
