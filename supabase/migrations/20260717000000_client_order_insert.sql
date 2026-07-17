-- BUG_002: clients could not place orders when Supabase is live.
-- The only INSERT policies on public.orders were staff/admin
-- (orders_insert_staff, orders_write_admin), so a client-role insert from the
-- portal's Place Order form was rejected by RLS and silently never persisted.
--
-- Allow a client to insert an order ONLY for their own client_code (as
-- resolved from their profile via my_client_code()). Staff/admin policies are
-- unchanged; clients still cannot insert for another client or with a null
-- client_code.
drop policy if exists orders_insert_client on public.orders;
create policy orders_insert_client on public.orders for insert
  with check (
    public.my_client_code() is not null
    and client_code = public.my_client_code()
  );
