-- Per-order client↔admin messaging (order-specific "Client Inbox"). Reuses the
-- support_messages table with an optional order_id: messages tagged with an
-- order form that order's thread; untagged messages remain the general Support
-- thread. Client can only message on their OWN orders (RLS below), staff on any.
alter table public.support_messages
  add column if not exists order_id text references public.orders(id) on delete cascade;

create index if not exists support_messages_order_idx
  on public.support_messages (order_id, created_at);

-- Tighten the client write policy: a client posts as 'client', in their own
-- thread, and if the message is tagged to an order it must be their order.
drop policy if exists support_client_write on public.support_messages;
create policy support_client_write on public.support_messages for insert
  with check (
    sender = 'client'
    and client_code = public.my_client_code()
    and (
      order_id is null
      or exists (select 1 from public.orders o
                 where o.id = order_id and o.client_code = public.my_client_code())
    )
  );
