-- BUG: newly created client users could not place orders.
--
-- A client places an order with client_code = their profile's client_code (via
-- my_client_code()). orders.client_code is FK'd to clients(code), but
-- profiles.client_code was NOT — and the admin "add user" form took the client
-- code as free text. So a typo, a blank, or a brand-new client with no clients
-- row yet produced a profile whose client_code names no real client. That user
-- logs in and passes the orders_insert_client RLS check (order code == their own
-- code), then the insert is rejected by orders_client_code_fkey:
--   23503  Key is not present in table "clients"
-- i.e. the order silently fails and the client "cannot place orders".
--
-- Enforce the same referential link on profiles so a client account can never be
-- provisioned against a non-existent client. The app layer (api/admin/users.js +
-- the add-user form) is fixed in tandem to pick or create a real client; this is
-- the database backstop that makes the broken state unreachable.
--
-- NOT VALID: new and edited profiles are checked from now on; pre-existing rows
-- are not retroactively scanned, so an already-dangling demo row can't block the
-- migration. client_code stays nullable — staff and admins have none, and NULL is
-- always allowed by a foreign key.
alter table public.profiles drop constraint if exists profiles_client_code_fkey;
alter table public.profiles
  add constraint profiles_client_code_fkey
  foreign key (client_code) references public.clients(code)
  not valid;
