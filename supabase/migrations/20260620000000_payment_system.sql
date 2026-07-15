-- Payment system (ACH + Check, no gateway). Idempotent; run once on top of
-- the existing schema.
--
-- 1) Per-client payment terms (Admin assigns; default per-order).
--    per_order | weekly | net15 | net30
alter table public.clients
  add column if not exists payment_terms text not null default 'per_order';

-- 2) Billing super admin. Only a super-admin (Vivek) can confirm payments
--    (deposit reconciliation) in the app; super_admin is a flag on the
--    profile. The demo vivek@resolute.com login is seeded locally by
--    supabase/seed.sql; in production create the account via Auth, then set
--    its profile role='admin', super_admin=true.

-- 3) Payment data itself lives on orders.workflow.payment (JSONB):
--    { method: 'ACH'|'Check', reference, checkDoc: {name,url,path}, statementId,
--      status: 'marked'|'confirmed'|'bounced', markedAt, confirmedAt, confirmedBy }
--    and orders.workflow.invoiceAmount / invoicedAt (stamped by the Typer's
--    Finalize). No new tables are needed; statements are derived per client.

-- ── Verify ───────────────────────────────────────────────────────────────────
-- select code, payment_terms from public.clients;
-- select u.email, p.role, p.super_admin from auth.users u
--   join public.profiles p on p.id = u.id where u.email = 'vivek@resolute.com';
