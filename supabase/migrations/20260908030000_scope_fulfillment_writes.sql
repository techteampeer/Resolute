-- =====================================================================
-- Scope fulfillment writes to the desk that owns the order
-- =====================================================================
-- fulfillments_write_staff was `for all using (is_staff())` — no restriction to
-- the assigned role, and none to the order in question. Any staff account could
-- therefore overwrite any order's entire commitment. Demonstrated by patching
-- one order's fulfillment three times in a row as the screener, then delivery,
-- then the operator: all three writes were accepted, last writer winning, and a
-- 4,319-byte commitment was replaced with a 27-byte payload. Repeated through
-- the UI afterwards: the Single Seating desk deep-linked to an order sitting on
-- the typer's desk, typed into the legal description, and the row took it.
--
-- A commitment is the client-facing legal document; the role that owns the order
-- is the only one that should be able to change it, plus Admin, who can now open
-- the fulfillment form as well. Reads are unchanged: all staff may read, and a
-- client may read their own order's fulfillment.
--
-- orders.assigned_to = my_role() is the same test orders_update_assigned already
-- uses for the order row itself, so the two now agree.
-- =====================================================================

drop policy if exists fulfillments_write_staff on public.fulfillments;
drop policy if exists fulfillments_write_owner on public.fulfillments;

create policy fulfillments_write_owner on public.fulfillments
  for all
  using (
    public.is_admin()
    or exists (
      select 1 from public.orders o
      where o.id = fulfillments.order_id
        and o.assigned_to = public.my_role()
    )
  )
  with check (
    public.is_admin()
    or exists (
      select 1 from public.orders o
      where o.id = fulfillments.order_id
        and o.assigned_to = public.my_role()
    )
  );

-- fulfillments.updated_by was never written, so with the policy above now
-- deciding WHO may write, there was still no record of who did. It is a uuid FK
-- to profiles, so stamp the caller's own id — taken from the JWT, not from
-- anything the client sends.
create or replace function public.fulfillments_stamp_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists fulfillments_stamp_author on public.fulfillments;
create trigger fulfillments_stamp_author
  before insert or update on public.fulfillments
  for each row execute function public.fulfillments_stamp_author();
