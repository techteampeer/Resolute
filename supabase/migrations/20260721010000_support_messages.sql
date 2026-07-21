-- In-portal support inbox (client ⇄ admin). Backs the SupportContext so threads
-- sync across devices instead of living only in per-browser localStorage.
--
-- Isolation mirrors orders: a client sees/writes only their own thread
-- (client_code = my_client_code()); staff see all and reply. Uses the existing
-- SECURITY DEFINER helpers my_client_code() / is_staff().

create table if not exists public.support_messages (
  id          uuid primary key default gen_random_uuid(),
  client_code text not null,
  sender      text not null check (sender in ('client', 'support')),
  author      text,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists support_messages_thread_idx
  on public.support_messages (client_code, created_at);

alter table public.support_messages enable row level security;

-- Client: read + write only their own thread; may only post as 'client'.
drop policy if exists support_client_read on public.support_messages;
create policy support_client_read on public.support_messages for select
  using (client_code = public.my_client_code());

drop policy if exists support_client_write on public.support_messages;
create policy support_client_write on public.support_messages for insert
  with check (sender = 'client' and client_code = public.my_client_code());

-- Staff: read every thread; reply only as 'support'.
drop policy if exists support_staff_read on public.support_messages;
create policy support_staff_read on public.support_messages for select
  using (public.is_staff());

drop policy if exists support_staff_write on public.support_messages;
create policy support_staff_write on public.support_messages for insert
  with check (public.is_staff() and sender = 'support');

-- Live updates so both sides see new messages without a refresh (guarded: the
-- supabase_realtime publication exists by default; ignore if already added).
do $$ begin
  alter publication supabase_realtime add table public.support_messages;
exception when duplicate_object then null; when undefined_object then null; end $$;
