-- =====================================================================
-- GCP test identities — for DISPOSABLE test databases only
-- =====================================================================
-- supabase/seed.sql cannot provision logins on a GCP-shaped database: it
-- writes GoTrue's auth.users columns (encrypted_password, instance_id, ...) and
-- auth.identities, and relies on the handle_new_user() trigger, which
-- 02_post_migrate.sql drops. On GCP, Firebase (Identity Platform) owns sign-in
-- and auth.users is only the firebase_uid -> profiles.id map, so a test
-- identity is exactly two rows: the map entry and the profile.
--
--   * firebase_uid values are 28 characters, the shape Firebase issues, and
--     start with "gcptest" so they can never collide with a real account.
--   * profiles.id values are fixed UUIDs so tests and logs are reproducible.
--   * No passwords exist anywhere: tests act as a user by injecting the same
--     request.jwt.claims services/api/src/db.js injects for a verified token.
--
-- The @resolute.com addresses mirror the demo logins in supabase/seed.sql,
-- because the existing services/api integration suites look those up by email;
-- the extra @gcp-test.invalid identities exist for isolation tests.
-- Loaded by gcp/test/run.sh as the schema owner (no claims), which the
-- privilege guard on profiles allows. Self-contained: it brings the two client
-- companies its client identities point at (profiles.client_code is FK'd to
-- clients on databases that carry 20261105010000), so it can seed a database
-- that has no orders at all -- the empty-table negative test needs exactly that.
-- =====================================================================

insert into public.clients (code, name, contact, email, phone, registered, activity, payment) values
  ('CL01', 'Lakewood Title Group',  'Dana Whitfield', 'dana@lakewoodtitle.test',  '(305) 555-0142', '2025-01-20', 'high', 'Wire'),
  ('CL02', 'Apex Lending Partners', 'Casey Wilson',   'casey@apexlending.test',   '(713) 555-0188', '2025-02-04', 'high', 'ACH')
on conflict (code) do nothing;

insert into auth.users (id, firebase_uid, email) values
  ('a0000000-0000-4000-8000-000000000001', 'gcptestRAJNI0000000000000001', 'rajni@resolute.com'),
  ('a0000000-0000-4000-8000-000000000002', 'gcptestSARAVANAN00000000002', 'saravanan@resolute.com'),
  ('a0000000-0000-4000-8000-000000000003', 'gcptestVIVEK0000000000000003', 'vivek@resolute.com'),
  ('a0000000-0000-4000-8000-000000000004', 'gcptestADMIN0000000000000004', 'admin@resolute.com'),
  ('a0000000-0000-4000-8000-000000000005', 'gcptestSUPERADMIN0000000005', 'superadmin@resolute.com'),
  ('a0000000-0000-4000-8000-000000000006', 'gcptestSCREENER000000000006', 'screener@resolute.com'),
  ('a0000000-0000-4000-8000-000000000007', 'gcptestEXAMINER000000000007', 'examiner@resolute.com'),
  ('a0000000-0000-4000-8000-000000000008', 'gcptestTYPER0000000000000008', 'typer@resolute.com'),
  ('a0000000-0000-4000-8000-000000000009', 'gcptestDELIVERY000000000009', 'delivery@resolute.com'),
  ('a0000000-0000-4000-8000-000000000010', 'gcptestCLIENT00000000000010', 'client@resolute.com'),
  ('a0000000-0000-4000-8000-000000000011', 'gcptestOPERATOR000000000011', 'operator@resolute.com'),
  ('a0000000-0000-4000-8000-000000000012', 'gcptestCLIENTB0000000000012', 'client.b@gcp-test.invalid'),
  ('a0000000-0000-4000-8000-000000000013', 'gcptestFORMERADMIN00000013', 'former.admin@gcp-test.invalid')
on conflict (id) do nothing;

insert into public.profiles (id, name, email, role, super_admin, client_code, status, can_confirm_payments) values
  ('a0000000-0000-4000-8000-000000000001', 'Rajni',         'rajni@resolute.com',            'admin',  true,  null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000002', 'Saravanan',     'saravanan@resolute.com',        'admin',  true,  null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000003', 'Vivek',         'vivek@resolute.com',            'admin',  true,  null,   'active',   true),
  ('a0000000-0000-4000-8000-000000000004', 'Alex Morrison', 'admin@resolute.com',            'admin',  false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000005', 'Super Admin',   'superadmin@resolute.com',       'admin',  true,  null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000006', 'Sam Carter',    'screener@resolute.com',         'user',   false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000007', 'Jordan Lee',    'examiner@resolute.com',         'user',   false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000008', 'Priya Nair',    'typer@resolute.com',            'user',   false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000009', 'Morgan Davis',  'delivery@resolute.com',         'user',   false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000010', 'Taylor Brooks', 'client@resolute.com',           'client', false, 'CL01', 'active',   false),
  ('a0000000-0000-4000-8000-000000000011', 'Jordan Blake',  'operator@resolute.com',         'user',   false, null,   'active',   false),
  ('a0000000-0000-4000-8000-000000000012', 'Casey Wilson',  'client.b@gcp-test.invalid',     'client', false, 'CL02', 'active',   false),
  -- An admin who left: must never receive a notification.
  ('a0000000-0000-4000-8000-000000000013', 'Former Admin',  'former.admin@gcp-test.invalid', 'admin',  false, null,   'disabled', false)
on conflict (id) do nothing;
