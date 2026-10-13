-- =====================================================================
-- Foundation F1 — per-person order assignee column.
-- =====================================================================
-- Assignment today routes an order to a ROLE QUEUE (orders.assigned_to, the
-- user_role enum) — for production work that is the shared `user` pool, so any
-- production user can act on any pooled order. To support individual production
-- accounts (assign to a specific person, per-user workload, admin reassignment,
-- single-seating owned by one user end-to-end), add a nullable owner column
-- pointing at the assignee's profile.
--
-- COLUMNS ONLY. RLS (orders_update_assigned) and guard_order_handoff are NOT
-- touched here — they are tightened in the later sprint migrations (owner-scoped
-- RLS, and the single-seating guard rewrite). Existing rows keep
-- assigned_user_id null and behave exactly as before this migration.
--
-- on delete set null: if a profile is removed, the order is simply unassigned
-- (parked for Admin to re-route), never deleted.
-- =====================================================================

alter table public.orders
  add column if not exists assigned_user_id uuid references public.profiles(id) on delete set null;

comment on column public.orders.assigned_user_id is
  'The specific production user currently responsible for this order (null = unassigned / pool / delivered). Complements assigned_to, which remains the role queue.';

-- Assignment queries filter by owner ("my work", per-user workload counts).
create index if not exists orders_assigned_user_id_idx
  on public.orders (assigned_user_id);
