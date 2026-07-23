-- Client-facing notifications. The bell reads order_events, but that table was
-- staff-only for both read and write, so a client's feed was always empty in
-- Supabase mode (and their "order placed" event was never recorded, since
-- clients can't insert into the audit trail).
--
-- 1) Let a client READ events for their own orders (scoped by order ownership).
--    Staff/global events (order_id null, or other clients' orders) stay hidden.
drop policy if exists order_events_client_read on public.order_events;
create policy order_events_client_read on public.order_events for select
  using (
    order_id is not null
    and exists (
      select 1 from public.orders o
      where o.id = order_events.order_id
        and o.client_code = public.my_client_code()
    )
  );

-- 2) Record the "order placed" event server-side via an AFTER INSERT trigger,
--    so it exists regardless of who created the order (clients can't write the
--    audit trail directly). Runs as definer to bypass the staff-only insert
--    policy. This is the client's order-receipt confirmation notification.
create or replace function public.log_order_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.order_events (order_id, action, type, actor)
  values (new.id, 'Order ' || new.id || ' placed (' || coalesce(new.type, 'Search') || ')', 'new', null);
  return new;
end;
$$;

drop trigger if exists orders_log_created on public.orders;
create trigger orders_log_created
  after insert on public.orders
  for each row execute function public.log_order_created();
