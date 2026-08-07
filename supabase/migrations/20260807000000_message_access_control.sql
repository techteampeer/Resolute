-- =====================================================================
-- Message access control + hardening.
--
-- 1) Only ADMINS may reply to clients. Other staff (screener, examiner,
--    typer, delivery, single seating) can READ every thread but their only
--    write is an INTERNAL note, which clients can never see.
-- 2) Revoke EXECUTE on trigger-only SECURITY DEFINER functions that were
--    reachable as RPCs.
-- Idempotent.
-- =====================================================================

-- ── 1) Visibility: 'client' (part of the client conversation) | 'internal' ────
alter table public.support_messages
  add column if not exists visibility text not null default 'client';

do $$ begin
  alter table public.support_messages
    add constraint support_messages_visibility_check
    check (visibility in ('client','internal'));
exception when duplicate_object then null; end $$;

create index if not exists support_messages_visibility_idx
  on public.support_messages(visibility);

-- ── 2) Read policies ─────────────────────────────────────────────────────────
-- Clients see ONLY client-visible messages on their own thread. Internal notes
-- are invisible to them at the database level, not just in the UI.
drop policy if exists support_client_read on public.support_messages;
create policy support_client_read on public.support_messages for select
  using (client_code = public.my_client_code() and visibility = 'client');

-- All staff keep full read access (view-only for non-admins, see writes below).
drop policy if exists support_staff_read on public.support_messages;
create policy support_staff_read on public.support_messages for select
  using (public.is_staff());

-- ── 3) Write policies ────────────────────────────────────────────────────────
-- Client → their own thread, always client-visible.
drop policy if exists support_client_write on public.support_messages;
create policy support_client_write on public.support_messages for insert
  with check (
    sender = 'client'
    and visibility = 'client'
    and client_code = public.my_client_code()
    and (order_id is null or exists (
      select 1 from public.orders o
      where o.id = support_messages.order_id and o.client_code = public.my_client_code()))
  );

-- Replaces support_staff_write (which let ANY staff role reply to clients).
-- Client-facing replies are admin-only now.
drop policy if exists support_staff_write on public.support_messages;
drop policy if exists support_admin_reply on public.support_messages;
create policy support_admin_reply on public.support_messages for insert
  with check (public.is_admin() and sender = 'support' and visibility = 'client');

-- Any staff member may add an internal note (never leaves the staff side).
drop policy if exists support_staff_note on public.support_messages;
create policy support_staff_note on public.support_messages for insert
  with check (public.is_staff() and sender = 'support' and visibility = 'internal');

-- ── 4) Hardening: trigger-only functions must not be callable as RPCs ────────
revoke execute on function public.handle_new_user()   from anon, authenticated;
revoke execute on function public.log_order_created() from anon, authenticated;
