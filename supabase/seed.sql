-- =====================================================================
-- Resolute Portal — LOCAL sample data / demo logins
-- =====================================================================
-- The Supabase CLI runs this file on `supabase db reset` (local dev only).
-- It is NEVER applied by `supabase db push`, so production stays clean:
-- no sample clients/orders/vendors and no known-password demo accounts.
--
-- Real users are created through Auth (signup/invite); the
-- handle_new_user() trigger from the init migration provisions their
-- profile automatically. Nothing here is required for the app to run.
--
-- NOTE: plain statements only — no helper function. The CLI's seed loader
-- splits on ';', so a dollar-quoted function body can't live here.
-- =====================================================================

-- ── Sample clients (mirror src/data/mockData.js) ────────────────────────────
insert into public.clients (code,name,contact,email,phone,registered,activity,payment) values
  ('CL01','Lakewood Title Group','Dana Whitfield','dana@lakewoodtitle.com','(305) 555-0142','2025-01-20','high','Wire'),
  ('CL02','Apex Lending Partners','Casey Wilson','casey@apexlending.com','(713) 555-0188','2025-02-04','high','ACH'),
  ('CL03','Sterling Law Firm','Riley Stone','riley@sterlinglaw.com','(213) 555-0119','2025-02-26','medium','Credit Card'),
  ('CL04','Pinnacle Real Estate','Morgan Pratt','morgan@pinnaclere.com','(718) 555-0173','2025-03-12','medium','Invoice (Net-30)'),
  ('CL05','BlueStar Title Agency','Jamie Fox','jamie@bluestartitle.com','(404) 555-0150','2025-04-01','low','Check'),
  ('CL06','Meridian Mortgage LLC','Avery Banks','avery@meridianmtg.com','(216) 555-0137','2025-04-22','low','Wire'),
  ('CL07','Coastal Title Services','Quinn Rivera','quinn@coastaltitle.com','(704) 555-0164','2025-05-15','low','ACH')
on conflict (code) do nothing;

-- ── Sample orders ───────────────────────────────────────────────────────────
insert into public.orders
  (id,client_code,state,county,type,status,priority,payment,clarification,assigned_to,
   screener,examiner,typer,delivery,progress,created,eta,completed,completed_dates,completed_by) values
  ('RTS-10041','CL01','FL','Miami-Dade','Full Search','examining','rush','Wire',null,'examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',65,'2026-06-09','2026-06-11',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10042','CL02','TX','Harris','Current Owner','delivered','normal','ACH',null,null,
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',100,'2026-06-08','2026-06-10','2026-06-10',
   '{"screener":"2026-06-08","examiner":"2026-06-09","typer":"2026-06-09","delivery":"2026-06-10"}',
   '{"screener":"Sam Carter","examiner":"Jordan Lee","typer":"Priya Nair","delivery":"Morgan Davis"}'),
  ('RTS-10043','CL03','CA','Los Angeles','Two-Owner','examining','normal','Credit Card','responded','examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',45,'2026-06-09','2026-06-12',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10044','CL04','NY','Kings','Lien Search','screening','rush','Invoice (Net-30)','pending','screener',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',10,'2026-06-10','2026-06-11',null,'{}','{}'),
  ('RTS-10045','CL05','GA','Fulton','Full Search','screening','normal','Check','responded','screener',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',25,'2026-06-10','2026-06-13',null,'{}','{}'),
  ('RTS-10046','CL06','OH','Cuyahoga','Tax Certificate','delivered','normal','Wire',null,null,
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',100,'2026-06-07','2026-06-09','2026-06-09',
   '{"screener":"2026-06-07","examiner":"2026-06-08","typer":"2026-06-08","delivery":"2026-06-09"}',
   '{"screener":"Sam Carter","examiner":"Jordan Lee","typer":"Priya Nair","delivery":"Morgan Davis"}'),
  ('RTS-10047','CL07','NC','Mecklenburg','HOA Estoppel','examining','rush','ACH',null,'examiner',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',55,'2026-06-09','2026-06-11',null,
   '{"screener":"2026-06-09"}','{"screener":"Sam Carter"}'),
  ('RTS-10048','CL01','AZ','Maricopa','Current Owner','typing','normal','Wire',null,'typer',
   'Sam Carter','Jordan Lee','Priya Nair','Morgan Davis',85,'2026-06-08','2026-06-12',null,
   '{"screener":"2026-06-08","examiner":"2026-06-10"}','{"screener":"Sam Carter","examiner":"Jordan Lee"}')
on conflict (id) do nothing;

-- Post-D3 (ADR 0001): the stage LOGIN roles are retired and production orders
-- live in the `user` pool. The fixtures above are written on stage desks for
-- readability; consolidate them into the pool exactly as the D3 migration
-- re-points real in-flight data, so they surface on the Production Desk /user
-- workspace. Their pipeline stage still derives from completed_dates.
update public.orders
   set assigned_to = 'user',
       workflow = coalesce(workflow, '{}'::jsonb) || '{"singleSeating":true}'::jsonb
 where assigned_to in ('screener', 'examiner', 'typer', 'delivery');

-- Demo: attach screener/examiner docs to RTS-10044 (Files section).
update public.orders
set workflow = coalesce(workflow, '{}'::jsonb) || jsonb_build_object(
  'screenerDoc', jsonb_build_object('id','sd44','name','Kings County Chain of Title.pdf','type','pdf'),
  'examinerDoc', jsonb_build_object('id','ed44','name','Examiner Findings - Lien Search.docx','type','word')
)
where id = 'RTS-10044';

-- ── Sample vendors (abstractor firms) & subscriptions ──────────────────────
insert into public.vendors (code, name, contact, coverage, cycle) values
  ('VN01','Meridian Abstracting LLC','Paul Ortiz','FL · GA · SC','weekly'),
  ('VN02','TitleTrace Abstractors','Gina Malone','TX · OK · LA','days15'),
  ('VN03','Keystone Search Group','Ed Novak','NY · NJ · PA','days30')
on conflict (code) do nothing;

insert into public.subscriptions (id, name, amount, cycle) values
  ('sub1','DataTree Title Plant',299,'days30'),
  ('sub2','NetOnline County Access',149,'days30')
on conflict (id) do nothing;

-- ── Demo logins (mirror src/context/AuthContext.jsx) ────────────────────────
-- Insert the auth users in one statement; the handle_new_user() trigger then
-- creates each profile (name/email/role from metadata). pgcrypto is schema-
-- qualified (extensions.*) so crypt/gen_salt resolve regardless of search_path.
-- Token columns must be '' (not NULL) or GoTrue password sign-in returns 500.
insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change, email_change_token_new,
  email_change_token_current, phone_change, phone_change_token, reauthentication_token
)
select '00000000-0000-0000-0000-000000000000', gen_random_uuid(),
  'authenticated', 'authenticated', d.email,
  extensions.crypt(d.pass, extensions.gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}',
  jsonb_build_object('name', d.name, 'role', d.role),
  now(), now(), '', '', '', '', '', '', '', ''
from (values
  ('rajni@resolute.com',    'admin123',    'Rajni',         'admin'),
  ('saravanan@resolute.com','admin123',    'Saravanan',     'admin'),
  ('vivek@resolute.com',    'vivek123',    'Vivek',         'admin'),
  ('admin@resolute.com',    'admin123',    'Alex Morrison', 'admin'),
  -- Post-D3: former stage staff are consolidated into the `user` production
  -- role (the migration re-roles the same accounts on a real database). The
  -- emails are kept so existing logins/bookmarks still resolve.
  ('screener@resolute.com', 'screener123', 'Sam Carter',    'user'),
  ('examiner@resolute.com', 'examiner123', 'Jordan Lee',    'user'),
  ('typer@resolute.com',    'typer123',    'Priya Nair',    'user'),
  ('delivery@resolute.com', 'delivery123', 'Morgan Davis',  'user'),
  ('client@resolute.com',   'client123',   'Taylor Brooks', 'client'),
  ('operator@resolute.com', 'operator123', 'Jordan Blake',  'user')
) as d(email, pass, name, role)
where not exists (select 1 from auth.users u where u.email = d.email);

-- Email/password identity for each seeded user (GoTrue-created users already
-- have one, so they're skipped by the guard).
insert into auth.identities (
  id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at
)
select gen_random_uuid(), u.id, u.id::text,
  jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
from auth.users u
where u.email like '%@resolute.com'
  and not exists (select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email');

-- Fields the trigger doesn't set: the role, super admins, the demo client's code.
--
-- handle_new_user() deliberately provisions every new profile as 'client' and
-- ignores the role in raw_user_meta_data — otherwise anyone could POST to the
-- public /auth/v1/signup endpoint with {"data":{"role":"admin"}} and mint an
-- administrator (see 20260901220000_close_signup_privilege_escalation.sql). Real
-- accounts get their role from an admin through api/admin/users.js, which runs as
-- the service role; these demo logins get theirs here. Without this every seeded
-- login lands on the client portal.
update public.profiles p set role = d.role::user_role
from (values
  ('rajni@resolute.com',    'admin'),
  ('saravanan@resolute.com','admin'),
  ('vivek@resolute.com',    'admin'),
  ('admin@resolute.com',    'admin'),
  ('screener@resolute.com', 'user'),
  ('examiner@resolute.com', 'user'),
  ('typer@resolute.com',    'user'),
  ('delivery@resolute.com', 'user'),
  ('client@resolute.com',   'client'),
  ('operator@resolute.com', 'user')
) as d(email, role)
where p.email = d.email;

update public.profiles set super_admin = true
where email in ('rajni@resolute.com','saravanan@resolute.com','vivek@resolute.com');

-- Vivek alone reconciles money (CLAUDE.md). 20260908010000 seeds the same flag,
-- but a `db reset` runs every migration before this file, so at that point
-- profiles is still empty and the update matches nothing -- leaving a local
-- database on which NOBODY can confirm a payment, mark a vendor payout paid, or
-- mark a subscription paid, since the guard triggers refuse all three. Set it
-- here too, where the rows actually exist. Production is unaffected: its
-- profiles predate the migration, so the update there found Vivek.
update public.profiles set can_confirm_payments = true
where email = 'vivek@resolute.com';
update public.profiles set client_code = 'CL01' where email = 'client@resolute.com';
