-- Payment system (ACH + Check, no gateway). Idempotent; run once on top of
-- the existing schema.
--
-- 1) Per-client payment terms (Admin assigns; default per-order).
--    per_order | weekly | net15 | net30
alter table public.clients
  add column if not exists payment_terms text not null default 'per_order';

-- 2) Billing super admin — vivek@resolute.com / vivek123. Only this account
--    can confirm payments (deposit reconciliation) in the app.
--    NOTE: GoTrue reads the token columns into non-nullable strings, so they
--    MUST be '' (not NULL) or password sign-in returns 500 unexpected_failure.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated', 'vivek@resolute.com',
  crypt('vivek123', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}',
  '{"name":"Vivek","role":"admin"}', now(), now(),
  '', '', '', '', '', '', '', ''
where not exists (select 1 from auth.users where email = 'vivek@resolute.com');

insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select gen_random_uuid(), u.id, u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
from auth.users u
where u.email = 'vivek@resolute.com'
  and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

insert into public.profiles (id, email, name, role, super_admin)
select id, 'vivek@resolute.com', 'Vivek', 'admin', true
from auth.users where email = 'vivek@resolute.com'
on conflict (id) do update set role = 'admin', name = 'Vivek', super_admin = true;

-- 3) Payment data itself lives on orders.workflow.payment (JSONB):
--    { method: 'ACH'|'Check', reference, checkDoc: {name,url,path}, statementId,
--      status: 'marked'|'confirmed'|'bounced', markedAt, confirmedAt, confirmedBy }
--    and orders.workflow.invoiceAmount / invoicedAt (stamped by the Typer's
--    Finalize). No new tables are needed; statements are derived per client.

-- ── Verify ───────────────────────────────────────────────────────────────────
-- select code, payment_terms from public.clients;
-- select u.email, p.role, p.super_admin from auth.users u
--   join public.profiles p on p.id = u.id where u.email = 'vivek@resolute.com';
