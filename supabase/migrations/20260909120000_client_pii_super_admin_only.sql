-- Move client-identity masking from the interface into the database.
--
-- CLAUDE.md: "non-super-admins see client codes, not names". Until now that was
-- enforced only at render time by displayClient(). The data told a different
-- story: clients_read was `is_staff() or code = my_client_code()`, so every
-- screener, examiner, typer, delivery and non-super admin could read the whole
-- clients table — name, contact, email and phone — and fetchOrders() embedded
-- `clients(name)` on every order for all of them. The names were in the network
-- response of a screener's own session regardless of what the page rendered,
-- and readable outright with one PostgREST call.
--
-- A hidden field is not a control. This makes the rule true where it is claimed.
--
-- Staff still need the registry itself: an admin picks a client when creating an
-- order, and billing groups invoices by client and edits payment terms. None of
-- that needs a name. So the identifying columns and the operational ones are
-- separated:
--
--   public.clients            base table — PII. Super admins, and the client's
--                             own row. Nobody else, at all.
--   public.client_directory   view — code, terms, activity, registered. No name,
--                             no contact, no email, no phone. All staff.
--
-- The view is owned by postgres and is not security_invoker, so it does not
-- inherit the base table's RLS — which is the point. It carries its own filter
-- so it cannot become a way to enumerate the registry from a client session.

-- ---------------------------------------------------------------------------
-- 1. The predicate the rule is actually written in.
-- ---------------------------------------------------------------------------
-- is_admin() is not the right test here: a non-super admin must be masked too.
create or replace function public.is_super_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select super_admin from public.profiles where id = auth.uid()), false)
$$;

revoke all on function public.is_super_admin() from public;
grant execute on function public.is_super_admin() to authenticated, anon;

-- ---------------------------------------------------------------------------
-- 2. Operational client data, with no identity in it.
-- ---------------------------------------------------------------------------
create or replace view public.client_directory as
  select c.code, c.payment_terms, c.activity, c.registered
  from public.clients c
  where public.is_staff() or c.code = public.my_client_code();

revoke all on public.client_directory from anon;
grant select on public.client_directory to authenticated;

comment on view public.client_directory is
  'Client registry without identifying columns. Staff read this; only super admins may read public.clients itself.';

-- ---------------------------------------------------------------------------
-- 3. The base table becomes super-admin only.
-- ---------------------------------------------------------------------------
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients for select
  using (public.is_super_admin() or code = public.my_client_code());

-- clients_admin_write was declared FOR ALL. Policies are OR'd and a FOR ALL
-- policy's USING clause applies to SELECT as well, so `using (is_admin())`
-- silently granted every admin — super or not — read of the whole table, right
-- past clients_read. Splitting it into the three write commands is what makes
-- the read policy above the only thing governing reads.
--
-- Writes stay is_admin(): creating or editing a client is an administrative act,
-- and an admin doing it necessarily supplies the name they are writing. Reading
-- the whole registry is the part that leaked.
drop policy if exists clients_admin_write on public.clients;

create policy clients_admin_insert on public.clients
  for insert with check (public.is_admin());
create policy clients_admin_update on public.clients
  for update using (public.is_admin()) with check (public.is_admin());
create policy clients_admin_delete on public.clients
  for delete using (public.is_admin());
