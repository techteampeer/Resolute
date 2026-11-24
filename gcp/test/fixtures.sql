-- =====================================================================
-- Populated, production-shaped order data — DISPOSABLE test databases only
-- =====================================================================
-- Loaded by gcp/test/run.sh AFTER identities.sql and BEFORE the guarded
-- migration. That order is the point of this file:
--
--   `supabase start` (CI) and gcp/bootstrap.sh run every migration against
--   EMPTY tables and only seed afterwards, so any check a migration makes
--   about existing orders -- and any backfill it performs -- runs against
--   nothing and passes without validating anything. (supabase/seed.sql and the
--   D3 migration both say as much in their comments.) resolute_live is not
--   empty. Here the data exists first, the migration runs over it, and the
--   suite refuses to run at all if it is missing (the vacuity gate in
--   services/api/__tests__/gcp-migration.integration.mjs).
--
-- What it models, because production has it:
--   * charges in every state: pending, approved, declined, and LEGACY charges
--     written before `status` existed (no status key; amount stored as a
--     string) -- resolve_order_charge treats a missing status as pending;
--   * workflow.payment objects (unpaid / confirmed) that a resolution must
--     never touch, invoice amounts, stage plans and document references;
--   * orders on the production desk owned by one `user`;
--   * a second client company, so isolation can be tested;
--   * two companies whose names normalise to the same key (Harbor Point Title
--     LLC / L.L.C.) -> admin_create_client must answer 'ambiguous';
--   * a non-CL client code, which next_client_code() must ignore;
--   * history: every order insert fires orders_log_created, so order_events
--     and the notification outbox fill up the way they do in production.
--
-- No real person's data: every name/email is invented, on .test/.invalid
-- domains.
-- =====================================================================

-- ── Client companies (CL01/CL02 come from identities.sql) ─────────────────
insert into public.clients (code, name, contact, email, phone, registered, activity, payment) values
  ('CL03', 'Sterling Law Firm',             'Riley Stone',   'riley@sterlinglaw.test',   '(213) 555-0119', '2025-02-26', 'medium', 'Credit Card'),
  ('CL04', 'Pinnacle Real Estate',          'Morgan Pratt',  'morgan@pinnaclere.test',   '(718) 555-0173', '2025-03-12', 'medium', 'Invoice (Net-30)'),
  ('CL05', 'BlueStar Title Agency',         'Jamie Fox',     'jamie@bluestartitle.test', '(404) 555-0150', '2025-04-01', 'low',    'Check'),
  ('CL06', 'Meridian Mortgage LLC',         'Avery Banks',   'avery@meridianmtg.test',   '(216) 555-0137', '2025-04-22', 'low',    'Wire'),
  ('CL07', 'Coastal Title Services',        'Quinn Rivera',  'quinn@coastaltitle.test',  '(704) 555-0164', '2025-05-15', 'low',    'ACH'),
  ('CL12', 'Harbor Point Title LLC',        'Drew Hale',     'drew@harborpoint.test',    '(617) 555-0101', '2025-08-01', 'low',    'ACH'),
  ('CL13', 'Harbor Point Title, L.L.C.',    'Drew Hale',     'drew@harborpoint.test',    '(617) 555-0101', '2025-09-12', 'low',    'ACH'),
  ('LEGACY-A', 'Old Mill Abstract',         'Pat Moreno',    'pat@oldmill.test',         '(512) 555-0190', '2024-11-30', 'low',    'Check')
on conflict (code) do nothing;

-- ── Orders the suite exercises by id ──────────────────────────────────────
insert into public.orders
  (id, client_code, state, county, type, status, priority, payment, assigned_to, assigned_user_id,
   progress, created, eta, completed, completed_dates, completed_by, workflow, client_file_no)
values
  -- CL01: one charge of each kind, a payment object and an invoice amount.
  ('RTS-20001', 'CL01', 'FL', 'Miami-Dade', 'Full Search', 'received', 'normal', 'ACH', 'admin', null,
   5, '2026-11-02', '2026-11-09', null, '{}', '{}',
   '{"invoiceAmount": 150,
     "payment": {"status": "unpaid", "method": "ach"},
     "pendingCharges": [
       {"id": "chg_fx_p1", "label": "Extra county",  "amount": 60,   "raisedBy": "Alex Morrison", "raisedByRole": "admin", "raisedAt": "2026-11-03", "status": "pending",  "resolvedAt": null},
       {"id": "chg_fx_a1", "label": "Rush handling", "amount": 25,   "raisedBy": "Alex Morrison", "raisedByRole": "admin", "raisedAt": "2026-11-03", "status": "approved", "resolvedAt": "2026-11-04"},
       {"id": "chg_fx_d1", "label": "Copies",        "amount": 12.5, "raisedBy": "Priya Nair",    "raisedByRole": "user",  "raisedAt": "2026-11-03", "status": "declined", "resolvedAt": "2026-11-04"}]}',
   'LK-55120'),
  -- CL01: a legacy charge (no status key, amount as a string) + a confirmed payment.
  ('RTS-20002', 'CL01', 'FL', 'Broward', 'Current Owner', 'received', 'normal', 'Wire', 'admin', null,
   5, '2026-10-20', '2026-10-27', null, '{}', '{}',
   '{"invoiceAmount": 95,
     "payment": {"status": "confirmed", "method": "wire", "confirmedBy": "Vivek", "confirmedAt": "2026-10-30"},
     "pendingCharges": [
       {"id": "chg_fx_legacy", "label": "Courier", "amount": "45.50", "raisedBy": "Priya Nair"}]}',
   'LK-55121'),
  -- CL01: the charge two sessions race to resolve.
  ('RTS-20003', 'CL01', 'GA', 'Fulton', 'Lien Search', 'received', 'rush', 'ACH', 'admin', null,
   5, '2026-11-05', '2026-11-06', null, '{}', '{}',
   '{"payment": {"status": "unpaid", "method": "ach"},
     "pendingCharges": [
       {"id": "chg_fx_race", "label": "Second parcel", "amount": 80, "raisedBy": "Alex Morrison", "raisedByRole": "admin", "raisedAt": "2026-11-05", "status": "pending", "resolvedAt": null}]}',
   null),
  -- CL02 (client B): a pending charge client A must never be able to resolve.
  ('RTS-20004', 'CL02', 'TX', 'Harris', 'Full Search', 'received', 'normal', 'ACH', 'admin', null,
   5, '2026-11-06', '2026-11-13', null, '{}', '{}',
   '{"payment": {"status": "unpaid", "method": "ach"},
     "pendingCharges": [
       {"id": "chg_fx_b1", "label": "Probate check", "amount": 40, "raisedBy": "Alex Morrison", "raisedByRole": "admin", "raisedAt": "2026-11-06", "status": "pending", "resolvedAt": null}]}',
   'AP-9001'),
  -- CL01, typer stage, owned on the production desk by typer@ (…008).
  ('RTS-20005', 'CL01', 'AZ', 'Maricopa', 'Full Search', 'typing', 'normal', 'Wire', 'user', 'a0000000-0000-4000-8000-000000000008',
   50, '2026-11-01', '2026-11-08', null, '{"screener": "2026-11-01", "examiner": "2026-11-02"}',
   '{"screener": "Sam Carter", "examiner": "Jordan Lee"}',
   '{"singleSeating": true, "payment": {"status": "unpaid", "method": "wire"}}',
   null),
  -- CL01, delivered and paid: history only.
  ('RTS-20006', 'CL01', 'NC', 'Mecklenburg', 'HOA Estoppel', 'delivered', 'normal', 'ACH', null, null,
   100, '2026-10-01', '2026-10-03', '2026-10-03',
   '{"screener": "2026-10-01", "examiner": "2026-10-02", "typer": "2026-10-02", "delivery": "2026-10-03"}',
   '{"screener": "Sam Carter", "examiner": "Jordan Lee", "typer": "Priya Nair", "delivery": "Morgan Davis"}',
   '{"invoiceAmount": 175,
     "payment": {"status": "confirmed", "method": "ach", "confirmedBy": "Vivek", "confirmedAt": "2026-10-10"},
     "pendingCharges": [
       {"id": "chg_fx_h1", "label": "Extra county", "amount": 60, "raisedBy": "Alex Morrison", "raisedByRole": "admin", "raisedAt": "2026-10-02", "status": "approved", "resolvedAt": "2026-10-02"}],
     "deliveryDocs": [{"id": "dd06", "name": "Final Report.pdf", "path": "orders/RTS-20006/final-report.pdf"}]}',
   'LK-54000');

-- ── Volume: 40 more orders across every client, statuses and charge states ─
-- Deterministic (generate_series), so a failure reproduces exactly.
insert into public.orders
  (id, client_code, state, county, type, status, priority, payment, assigned_to,
   progress, created, eta, completed, completed_dates, completed_by, workflow, client_file_no)
select
  format('RTS-%s', 21000 + g),
  (array['CL01','CL02','CL03','CL04','CL05','CL06','CL07','CL12','CL13','LEGACY-A'])[1 + g % 10],
  (array['FL','TX','CA','NY','GA','OH','NC','AZ'])[1 + g % 8],
  (array['Miami-Dade','Harris','Los Angeles','Kings','Fulton','Cuyahoga','Mecklenburg','Maricopa'])[1 + g % 8],
  (array['Full Search','Current Owner','Two-Owner','Lien Search','Tax Certificate'])[1 + g % 5],
  (case when g % 3 = 0 then 'delivered' else 'received' end)::public.order_status,
  (case when g % 5 = 0 then 'rush' else 'normal' end)::public.order_priority,
  (array['ACH','Wire','Check','Credit Card'])[1 + g % 4],
  (case when g % 3 = 0 then null else 'admin' end)::public.user_role,
  case when g % 3 = 0 then 100 else 5 end,
  date '2026-08-01' + g,
  date '2026-08-05' + g,
  case when g % 3 = 0 then date '2026-08-05' + g end,
  case when g % 3 = 0
       then jsonb_build_object('screener', (date '2026-08-02' + g)::text, 'examiner', (date '2026-08-03' + g)::text,
                               'typer', (date '2026-08-04' + g)::text, 'delivery', (date '2026-08-05' + g)::text)
       else '{}'::jsonb end,
  '{}'::jsonb,
  jsonb_build_object(
    'invoiceAmount', 100 + g * 5,
    'payment', jsonb_build_object('status', case when g % 3 = 0 then 'confirmed' else 'unpaid' end, 'method', 'ach'))
  || case
       when g % 4 = 0 then jsonb_build_object('pendingCharges', jsonb_build_array(jsonb_build_object(
            'id', format('chg_bulk_%s', g), 'label', 'Extra county', 'amount', 50 + g, 'raisedBy', 'Alex Morrison',
            'raisedByRole', 'admin', 'raisedAt', (date '2026-08-03' + g)::text,
            'status', case when g % 8 = 0 then 'approved' else 'declined' end,
            'resolvedAt', (date '2026-08-04' + g)::text)))
       when g % 7 = 0 then jsonb_build_object('pendingCharges', jsonb_build_array(jsonb_build_object(
            'id', format('chg_bulk_%s', g), 'label', 'Courier', 'amount', 20 + g, 'raisedBy', 'Priya Nair',
            'raisedByRole', 'user', 'raisedAt', (date '2026-08-03' + g)::text, 'status', 'pending', 'resolvedAt', null)))
       else '{}'::jsonb
     end,
  case when g % 2 = 0 then format('FILE-%s', 7000 + g) end
from generate_series(1, 40) g;

-- ── Historical activity beyond the automatic "order created" lines ────────
insert into public.order_events (order_id, action, type, actor, actor_email, audience)
values
  ('RTS-20001', 'Additional fee of $60.00 requested on RTS-20001 — awaiting approval', 'status', 'Resolute', 'admin@resolute.com', 'all'),
  ('RTS-20001', 'Client approved an additional fee of $25.00 on RTS-20001',           'status', 'Client',   null,                 'all'),
  ('RTS-20001', 'Client declined an additional fee of $12.50 on RTS-20001',           'status', 'Client',   null,                 'all'),
  ('RTS-20006', 'Order delivered',                                                    'progress', 'Morgan Davis', 'delivery@resolute.com', 'all'),
  ('RTS-20003', 'Internal note: second parcel confirmed with county',                 'status', 'Alex Morrison', 'admin@resolute.com', 'staff');
