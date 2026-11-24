// GCP database verification: gcp/migrations/20261124000000 over POPULATED data,
// through the API's own DB layer, as the API's own non-superuser login.
//
// Run by gcp/test/run.sh against a disposable PostgreSQL 15 database built the
// way production was (gcp/bootstrap.sh), seeded (gcp/test/identities.sql +
// fixtures.sql) and only THEN migrated. Never point it at a real database: it
// writes test charges, clients and notifications.
//
// Two connections, on purpose:
//   * the app pool -- services/api/src/db.js exactly as Cloud Run uses it,
//     logged in as DB_USER (the NOINHERIT app role): every action goes through
//     withUserClaims (SET LOCAL ROLE authenticated + injected claims) or
//     withServiceRole, so RLS, grants and SECURITY DEFINER behave as in prod;
//   * an owner connection (GCP_IT_OWNER_*) used ONLY to inspect -- counts,
//     catalog, outbox -- never to act.
//
// The vacuity gate runs first: if the database does not hold the populated
// fixture data, the suite exits 2 before asserting anything. An assertion over
// an empty orders table passes without validating anything, and that must
// never be reported as a pass.
//
// GCP_IT_SHAPE = prodshape | lineage
//   prodshape  built WITHOUT the four migrations resolute_live lacks (the
//              charge-aware notify classifier among them)
//   lineage    built from every migration (the Supabase lineage on main)
// Exit: 0 all passed, 1 a check failed, 2 vacuous / misconfigured.

process.env.DB_HOST ??= '127.0.0.1'
process.env.DB_PORT ??= '5432'
for (const k of ['DB_USER', 'DB_PASSWORD', 'DB_NAME', 'GCP_IT_OWNER_USER', 'GCP_IT_OWNER_PASSWORD']) {
  if (!process.env[k]) { console.error(`gcp-migration IT: ${k} is required`); process.exit(2) }
}
const SHAPE = process.env.GCP_IT_SHAPE || 'prodshape'
if (!['prodshape', 'lineage'].includes(SHAPE)) { console.error(`gcp-migration IT: bad GCP_IT_SHAPE ${SHAPE}`); process.exit(2) }

const pg = (await import('pg')).default
const { withUserClaims, withServiceRole, closePool } = await import('../src/db.js')
const { resolveAppUser } = await import('../src/auth.js')

const conn = (user, password) => new pg.Client({
  host: process.env.DB_HOST, port: Number(process.env.DB_PORT), database: process.env.DB_NAME, user, password,
})
const owner = conn(process.env.GCP_IT_OWNER_USER, process.env.GCP_IT_OWNER_PASSWORD)
await owner.connect()
const q = async (text, params) => (await owner.query(text, params)).rows
const one = async (text, params) => (await q(text, params))[0] || {}

let failures = 0
let passes = 0
const check = (name, pass, detail = '') => {
  if (pass) passes++
  else failures++
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}
const section = (s) => console.log(`\n── ${s} ──`)
const finding = (s) => console.log(`  NOTE  ${s}`)

// Run fn inside the app's claims transaction; return { ok, value } or { ok:false, code, message }.
const attempt = async (user, sql, params) => {
  try {
    const { rows } = await withUserClaims(user, (c) => c.query(sql, params))
    return { ok: true, value: rows[0] ? Object.values(rows[0])[0] : undefined }
  } catch (err) {
    return { ok: false, code: err.code, message: err.message }
  }
}
const refusedWith = (r, code) => !r.ok && r.code === code
const show = (r) => (r.ok ? `ok ${JSON.stringify(r.value)}` : `${r.code} ${r.message}`)

// Identities (gcp/test/identities.sql).
const U = (n, role, email) => ({ id: `a0000000-0000-4000-8000-0000000000${n}`, role, email })
const superAdmin = U('01', 'admin', 'rajni@resolute.com')
const admin = U('04', 'admin', 'admin@resolute.com')
const typer = U('08', 'user', 'typer@resolute.com')       // owns RTS-20005 on the production desk
const operator = U('11', 'user', 'operator@resolute.com') // another production user
const clientA = U('10', 'client', 'client@resolute.com')  // CL01
const clientB = U('12', 'client', 'client.b@gcp-test.invalid') // CL02

const workflow = async (id) => (await one('select workflow from public.orders where id = $1', [id])).workflow || {}
const chargesOf = (wf) => (Array.isArray(wf.pendingCharges) ? wf.pendingCharges : [])
const chargeOf = (wf, id) => chargesOf(wf).find((c) => c.id === id)
const same = (a, b) => JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b))
function sortKeys(v) { // jsonb does not preserve key order; compare structurally
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
  return v
}
const outboxFor = (eventId) =>
  q(`select recipient_email, recipient_role, type_key from public.notification_outbox where dedupe_key like $1`, [`%:${eventId}:%`])

try {
  // ── 0. Vacuity gate ─────────────────────────────────────────────────────
  section(`vacuity gate (${SHAPE})`)
  const v = await one(`
    select (select count(*) from public.orders)::int as orders,
           (select count(*) from public.orders
             where jsonb_typeof(workflow->'pendingCharges') = 'array'
               and jsonb_array_length(workflow->'pendingCharges') > 0)::int as with_charges,
           (select count(*) from public.orders o,
                   jsonb_array_elements(case when jsonb_typeof(o.workflow->'pendingCharges') = 'array'
                                             then o.workflow->'pendingCharges' else '[]'::jsonb end) c
             where coalesce(c->>'status', 'pending') = 'pending')::int as pending,
           (select count(distinct client_code) from public.orders)::int as clients_with_orders,
           (select count(*) from public.profiles where role = 'admin' and status = 'active')::int as admins,
           (select count(*) from public.profiles where role = 'client')::int as client_logins,
           (select count(*) from public.orders where id in ('RTS-20001','RTS-20002','RTS-20003','RTS-20004','RTS-20005'))::int as anchors`)
  const MIN = { orders: 20, with_charges: 5, pending: 4, clients_with_orders: 3, admins: 2, client_logins: 2, anchors: 5 }
  const short = Object.entries(MIN).filter(([k, min]) => !(v[k] >= min))
  console.log(`  data: ${JSON.stringify(v)}`)
  if (short.length) {
    console.error(`\nVACUOUS: refusing to verify against a database without the populated fixtures (${
      short.map(([k, min]) => `${k}=${v[k] ?? 0} < ${min}`).join(', ')}). A pass here would validate nothing.`)
    process.exitCode = 2
    throw new Error('vacuous')
  }
  check('populated data present before any assertion', true, `${v.orders} orders, ${v.pending} pending fees`)
  const ACTIVE_ADMINS = (await q(`select email from public.profiles where role = 'admin' and status = 'active' and coalesce(email,'') <> '' order by email`)).map((r) => r.email)

  // ── 1. Roles, ownership, grants ─────────────────────────────────────────
  section('roles, ownership, grants')
  const app = await one(`select rolsuper, rolbypassrls, rolinherit, rolcanlogin,
                                pg_has_role(rolname, 'authenticated', 'MEMBER') as authn,
                                pg_has_role(rolname, 'service_role', 'MEMBER') as svc
                           from pg_roles where rolname = $1`, [process.env.DB_USER])
  check('app role: LOGIN, not superuser, no BYPASSRLS, NOINHERIT',
    app.rolcanlogin && !app.rolsuper && !app.rolbypassrls && !app.rolinherit, JSON.stringify(app))
  check('app role can SET ROLE authenticated and service_role', app.authn && app.svc)

  const ordersOwner = (await one(`select pg_get_userbyid(relowner) as o from pg_class where oid = 'public.orders'::regclass`)).o
  const FNS = [
    ['resolve_order_charge(text,text,text)', true],
    ['admin_create_client(text,text,text)', true],
    ['gcp_raise_order_charge(text,text,numeric)', false],
    ['gcp_resolve_order_charge(text,text,text)', true],
  ]
  for (const [sig, definer] of FNS) {
    const f = await one(`
      select pg_get_userbyid(p.proowner) as owner, p.prosecdef, p.proconfig,
             (select array_agg(distinct pg_get_userbyid(a.grantee)::text) from aclexplode(p.proacl) a where a.grantee <> p.proowner) as grantees,
             has_function_privilege('public', p.oid, 'EXECUTE') as pub,
             has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
             has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
             has_function_privilege($2, p.oid, 'EXECUTE') as app_direct
        from pg_proc p where p.oid = to_regprocedure($1)`, [`public.${sig}`, process.env.DB_USER])
    check(`${sig}: owned by ${ordersOwner} (the table owner — bypasses RLS without a superuser)`, f.owner === ordersOwner, f.owner)
    check(`${sig}: SECURITY ${definer ? 'DEFINER' : 'INVOKER'}, search_path pinned`,
      f.prosecdef === definer && same(f.proconfig, ['search_path=public']))
    check(`${sig}: EXECUTE only by authenticated (not PUBLIC/anon/service_role/app login)`,
      same(f.grantees, ['authenticated']) && !f.pub && !f.anon && !f.svc && !f.app_direct, JSON.stringify(f.grantees))
  }

  // The app login itself (no SET ROLE) holds nothing: NOINHERIT.
  const bare = conn(process.env.DB_USER, process.env.DB_PASSWORD)
  await bare.connect()
  const bareTry = async (sql) => { try { await bare.query(sql); return 'allowed' } catch (e) { return e.code } }
  check('app login without SET ROLE cannot read orders', (await bareTry('select 1 from public.orders limit 1')) === '42501')
  check('app login without SET ROLE cannot call gcp_resolve_order_charge',
    (await bareTry(`select public.gcp_resolve_order_charge('RTS-20001','x','approved')`)) === '42501')
  check('app login cannot assume the schema owner', (await bareTry(`set role "${ordersOwner}"`)) === '42501')
  await bare.end()

  check('authenticated cannot read the identity map (auth.users)',
    refusedWith(await attempt(clientA, 'select count(*) from auth.users'), '42501'))
  check('authenticated cannot call the intake resolver directly',
    refusedWith(await attempt(admin, `select public.intake_resolve_client('Direct Call Co')`), '42501'))
  check('authenticated cannot call enqueue_notification',
    refusedWith(await attempt(admin, `select public.enqueue_notification('charge.approved','RTS-20001','{}'::jsonb,'x',null,null)`), '42501'))
  let svcRaise
  try { await withServiceRole((c) => c.query(`select public.gcp_raise_order_charge('RTS-20001','x',1)`)); svcRaise = 'allowed' } catch (e) { svcRaise = e.code }
  check('service_role cannot call the charge functions', svcRaise === '42501', svcRaise)

  // ── 2. Identity resolution over the fixed grants (the real auth.js path) ─
  section('identity resolution (resolveAppUser via withServiceRole)')
  const who = await resolveAppUser({ uid: 'gcptestCLIENT00000000000010' })
  check('a mapped Firebase UID resolves to its portal profile',
    who && who.id === clientA.id && who.role === 'client' && who.email === clientA.email, JSON.stringify(who))
  check('an unknown Firebase UID resolves to nobody', (await resolveAppUser({ uid: 'gcptestNOSUCHACCOUNT0000000' })) === null)

  // ── 3. RLS isolation on the populated data ──────────────────────────────
  section('row isolation')
  const total = (await one('select count(*)::int n from public.orders')).n
  const cl01 = (await one(`select count(*)::int n from public.orders where client_code = 'CL01'`)).n
  const cl02 = (await one(`select count(*)::int n from public.orders where client_code = 'CL02'`)).n
  const seeA = await attempt(clientA, 'select count(*)::int from public.orders')
  const seeB = await attempt(clientB, 'select count(*)::int from public.orders')
  const seeAdmin = await attempt(admin, 'select count(*)::int from public.orders')
  check('client A sees exactly its own orders', seeA.value === cl01 && cl01 > 0, `${seeA.value} of ${cl01}`)
  check('client B sees exactly its own orders', seeB.value === cl02 && cl02 > 0, `${seeB.value} of ${cl02}`)
  check('admin sees every order', seeAdmin.value === total, `${seeAdmin.value} of ${total}`)
  check(`client A cannot see client B's order`, (await attempt(clientA, `select count(*)::int from public.orders where id = 'RTS-20004'`)).value === 0)

  // ── 4. Raise: gcp_raise_order_charge ────────────────────────────────────
  section('raise a fee (gcp_raise_order_charge)')
  const RAISE = 'select public.gcp_raise_order_charge($1, $2, $3)'
  const wf1Before = await workflow('RTS-20001')
  const chargeMailBefore = (await one(`select count(*)::int n from public.notification_outbox where order_id = 'RTS-20001' and type_key like 'charge.%'`)).n
  const r1 = await attempt(admin, RAISE, ['RTS-20001', '  Title update  ', 30])
  const c1 = r1.value || {}
  check('admin raises a fee', r1.ok && /^chg_[0-9a-f]{16}$/.test(c1.id || ''), show(r1))
  check('server-shaped charge: trimmed label, pending, raisedBy/Role, UTC date, no resolvedAt',
    c1.label === 'Title update' && c1.status === 'pending' && c1.resolvedAt === null &&
    c1.raisedBy === 'Alex Morrison' && c1.raisedByRole === 'admin' &&
    c1.raisedAt === new Date().toISOString().slice(0, 10) && Number(c1.amount) === 30, JSON.stringify(c1))
  const wf1 = await workflow('RTS-20001')
  check('appended: the three existing charges are byte-for-byte unchanged',
    chargesOf(wf1).length === 4 && same(chargesOf(wf1).slice(0, 3), chargesOf(wf1Before)))
  check('payment and invoice untouched by a raise',
    same(wf1.payment, wf1Before.payment) && wf1.invoiceAmount === wf1Before.invoiceAmount)
  const ev1 = await one(`select action, actor, audience, actor_email from public.order_events where order_id = 'RTS-20001' order by id desc limit 1`)
  check('client-visible activity line, staff name masked',
    ev1.action === 'Additional fee of $30.00 requested on RTS-20001 — awaiting approval' &&
    ev1.actor === 'Resolute' && ev1.audience === 'all' && ev1.actor_email === admin.email, JSON.stringify(ev1))
  check('raising sends no mail', (await one(`select count(*)::int n from public.notification_outbox where order_id = 'RTS-20001' and type_key like 'charge.%'`)).n === chargeMailBefore)

  const r2 = await attempt(typer, RAISE, ['RTS-20005', 'Extra county', 45])
  check('the production user who owns the order raises a fee', r2.ok && r2.value.raisedByRole === 'user', show(r2))
  const n5 = chargesOf(await workflow('RTS-20005')).length
  check('a production user who does not own it is refused (403)', refusedWith(await attempt(operator, RAISE, ['RTS-20005', 'x', 5]), '42501'))
  check('a client is refused (403)', refusedWith(await attempt(clientA, RAISE, ['RTS-20001', 'x', 5]), '42501'))
  check('an unknown order is not found (404)', refusedWith(await attempt(admin, RAISE, ['RTS-NOPE', 'x', 5]), 'P0002'))
  for (const [label, amount, why] of [
    ['', 10, 'empty label'], ['x'.repeat(121), 10, 'label over 120'], ['ok', 0, 'zero amount'],
    ['ok', -5, 'negative amount'], ['ok', 1000000.01, 'over the 1,000,000 ceiling'], ['ok', null, 'no amount'],
    ['ok', 'NaN', 'NaN amount'],
  ]) {
    check(`validation: ${why} → 422`, refusedWith(await attempt(admin, RAISE, ['RTS-21001', label, amount]), '22023'))
  }
  check('refusals wrote nothing', chargesOf(await workflow('RTS-20005')).length === n5 &&
    chargesOf(await workflow('RTS-21001')).length === 0)
  const edge = await attempt(admin, RAISE, ['RTS-21001', 'Ceiling', 1000000])
  check('exactly 1,000,000 is accepted', edge.ok, show(edge))

  const before3 = chargesOf(await workflow('RTS-20003')).length
  const [p1, p2] = await Promise.all([
    attempt(admin, RAISE, ['RTS-20003', 'Parallel A', 11]),
    attempt(admin, RAISE, ['RTS-20003', 'Parallel B', 12]),
  ])
  const after3 = chargesOf(await workflow('RTS-20003'))
  check('two concurrent raises both land (no lost update)', p1.ok && p2.ok && after3.length === before3 + 2 &&
    after3.some((c) => c.label === 'Parallel A') && after3.some((c) => c.label === 'Parallel B'))

  // ── 5. Resolve: gcp_resolve_order_charge ────────────────────────────────
  section('resolve a fee (gcp_resolve_order_charge)')
  const RESOLVE = 'select public.gcp_resolve_order_charge($1, $2, $3)'
  const wfA = await workflow('RTS-20001')
  const ap = await attempt(clientA, RESOLVE, ['RTS-20001', 'chg_fx_p1', 'approved'])
  check('the owning client approves', ap.ok && ap.value.decision === 'approved' && Number(ap.value.amount) === 60, show(ap))
  const wfA2 = await workflow('RTS-20001')
  const p1c = chargeOf(wfA2, 'chg_fx_p1')
  check('only that charge changed: status approved + resolvedAt, amount kept',
    p1c.status === 'approved' && /^\d{4}-\d{2}-\d{2}$/.test(p1c.resolvedAt) && p1c.amount === 60 &&
    same(chargesOf(wfA2).filter((c) => c.id !== 'chg_fx_p1'), chargesOf(wfA).filter((c) => c.id !== 'chg_fx_p1')))
  check('approval is not payment: workflow.payment byte-for-byte unchanged, invoice base unchanged',
    same(wfA2.payment, wfA.payment) && wfA2.payment.status === 'unpaid' && wfA2.invoiceAmount === wfA.invoiceAmount)
  const approvedTotal = chargesOf(wfA2).filter((c) => c.status === 'approved').reduce((s, c) => s + Number(c.amount), 0)
  check('approved fees now total 85 (25 earlier + 60) — counted once', approvedTotal === 85, String(approvedTotal))
  const evA = await one('select id, action, actor, audience from public.order_events where id = $1', [ap.value?.eventId])
  check('audit event written by resolve_order_charge',
    evA.action === 'Client approved an additional fee of $60.00 on RTS-20001' && evA.actor === 'Client' && evA.audience === 'all', JSON.stringify(evA))
  const mailA = await outboxFor(ap.value?.eventId)
  check('charge.approved mailed to each ACTIVE admin exactly once (explicit enqueue, deduped)',
    mailA.length === ACTIVE_ADMINS.length && same(mailA.map((m) => m.recipient_email).sort(), ACTIVE_ADMINS) &&
    mailA.every((m) => m.type_key === 'charge.approved' && m.recipient_role === 'admin'),
    `${mailA.length} rows for ${ACTIVE_ADMINS.length} admins`)
  check('nobody else is mailed: no client, no disabled admin',
    !mailA.some((m) => m.recipient_role === 'client' || m.recipient_email.startsWith('former.admin')))

  const mailCountA = (await one(`select count(*)::int n from public.notification_outbox where order_id = 'RTS-20001' and type_key like 'charge.%'`)).n
  const replay = await attempt(clientA, RESOLVE, ['RTS-20001', 'chg_fx_p1', 'approved'])
  check('replay is refused (409 path) and changes nothing',
    refusedWith(replay, 'P0001') && /no pending charge/.test(replay.message) &&
    same(await workflow('RTS-20001'), wfA2) &&
    (await one(`select count(*)::int n from public.notification_outbox where order_id = 'RTS-20001' and type_key like 'charge.%'`)).n === mailCountA)

  const wfL = await workflow('RTS-20002')
  const dl = await attempt(clientA, RESOLVE, ['RTS-20002', 'chg_fx_legacy', 'declined'])
  const wfL2 = await workflow('RTS-20002')
  const lc = chargeOf(wfL2, 'chg_fx_legacy')
  check('a LEGACY charge (no status key, string amount) can be declined', dl.ok && lc.status === 'declined' && lc.amount === '45.50', show(dl))
  check('declining leaves a confirmed payment untouched', same(wfL2.payment, wfL.payment) && wfL2.payment.status === 'confirmed')
  const mailL = await outboxFor(dl.value?.eventId)
  check('charge.declined mailed to each active admin once',
    mailL.length === ACTIVE_ADMINS.length && mailL.every((m) => m.type_key === 'charge.declined'), String(mailL.length))

  const wfB = await workflow('RTS-20004')
  const cross = await attempt(clientA, RESOLVE, ['RTS-20004', 'chg_fx_b1', 'approved'])
  check(`client A cannot resolve client B's fee, and it stays pending`,
    refusedWith(cross, 'P0001') && same(await workflow('RTS-20004'), wfB))
  check('client B can resolve its own fee', (await attempt(clientB, RESOLVE, ['RTS-20004', 'chg_fx_b1', 'approved'])).ok)
  check('staff cannot resolve on a client\'s behalf (403)', refusedWith(await attempt(admin, RESOLVE, ['RTS-20003', 'chg_fx_race', 'approved']), '42501'))
  check('a production user cannot resolve (403)', refusedWith(await attempt(typer, RESOLVE, ['RTS-20003', 'chg_fx_race', 'approved']), '42501'))
  check('an invalid decision → 422', refusedWith(await attempt(clientA, RESOLVE, ['RTS-20003', 'chg_fx_race', 'maybe']), '22023'))
  check('a missing decision → 422', refusedWith(await attempt(clientA, RESOLVE, ['RTS-20003', 'chg_fx_race', null]), '22023'))
  check('an unknown charge id → refused', refusedWith(await attempt(clientA, RESOLVE, ['RTS-20003', 'chg_nope', 'approved']), 'P0001'))

  // Real overlap: A holds the row lock (sleeps before COMMIT); B starts inside
  // that window, must WAIT for the lock, then find nothing pending.
  const raceA = withUserClaims(clientA, async (c) => {
    const r = await c.query(RESOLVE, ['RTS-20003', 'chg_fx_race', 'approved'])
    await c.query('select pg_sleep(1)')
    return r.rows[0]
  }).then(() => ({ ok: true }), (e) => ({ ok: false, code: e.code }))
  await new Promise((res) => setTimeout(res, 250))
  const tB = Date.now()
  const raceB = await attempt(clientA, RESOLVE, ['RTS-20003', 'chg_fx_race', 'approved'])
  const waited = Date.now() - tB
  const raceAResult = await raceA
  check('two concurrent approvals: exactly one wins', raceAResult.ok && refusedWith(raceB, 'P0001'), `${JSON.stringify(raceAResult)} / ${show(raceB)}`)
  check('the loser really waited on the row lock (the race overlapped)', waited >= 500, `${waited} ms`)
  check('one audit event and one mail per admin for the raced charge',
    (await one(`select count(*)::int n from public.order_events where order_id = 'RTS-20003' and action = 'Client approved an additional fee of $80.00 on RTS-20003'`)).n === 1 &&
    (await one(`select count(*)::int n from public.notification_outbox where order_id = 'RTS-20003' and type_key = 'charge.approved'`)).n === ACTIVE_ADMINS.length)

  // ── 6. The repo API's current resolve path on this shape ────────────────
  section('resolve_order_charge alone (services/api resolveCharge today)')
  const gap = await attempt(admin, RAISE, ['RTS-20001', 'Gap probe', 7])
  const gapResolve = await attempt(clientA, 'select public.resolve_order_charge($1, $2, $3)', ['RTS-20001', gap.value?.id, 'approved'])
  const gapEvent = await one(`select id from public.order_events where order_id = 'RTS-20001' and action = 'Client approved an additional fee of $7.00 on RTS-20001'`)
  const gapMail = (await outboxFor(gapEvent.id)).length
  check('resolve_order_charge resolves and audits on this shape', gap.ok && gapResolve.ok && !!gapEvent.id)
  if (SHAPE === 'prodshape') {
    check('on a resolute_live-shaped database it mails NOBODY (no charge-aware trigger)', gapMail === 0, String(gapMail))
    finding('which is why services/api resolveCharge() calls gcp_resolve_order_charge (B1 §6), not this directly.')
  } else {
    check('on the full Supabase lineage the order_events trigger mails each admin once', gapMail === ACTIVE_ADMINS.length, String(gapMail))
  }

  // ── 7. admin_create_client ──────────────────────────────────────────────
  section('create a client company (admin_create_client)')
  const CREATE = 'select public.admin_create_client($1, $2, $3)'
  const codesBefore = (await q('select code from public.clients')).map((r) => r.code)
  const cr = await attempt(admin, CREATE, ['Riverbend Abstract Co', 'Lee Park', 'lee@riverbend.test'])
  check('admin creates a new company with a fresh CL code',
    cr.ok && cr.value.status === 'created' && /^CL\d{2,}$/.test(cr.value.code) && !codesBefore.includes(cr.value.code), show(cr))
  const row = await one('select name, contact, email, registered::text from public.clients where code = $1', [cr.value?.code])
  check('contact + email persisted, registered today',
    row.name === 'Riverbend Abstract Co' && row.contact === 'Lee Park' && row.email === 'lee@riverbend.test' &&
    row.registered === (await one('select current_date::text d')).d, JSON.stringify(row))
  const again = await attempt(admin, CREATE, ['RIVERBEND abstract co.', null, null])
  check('same name, different case/punctuation → matched, nothing new',
    again.ok && again.value.status === 'matched' && again.value.code === cr.value?.code &&
    (await one('select count(*)::int n from public.clients')).n === codesBefore.length + 1, show(again))
  const amb = await attempt(admin, CREATE, ['Harbor Point Title LLC', null, null])
  check('two existing companies share the key → ambiguous, nothing created',
    amb.ok && amb.value.status === 'ambiguous' && same(amb.value.codes, ['CL12', 'CL13']) &&
    (await one('select count(*)::int n from public.clients')).n === codesBefore.length + 1, show(amb))
  check('a client is refused (403)', refusedWith(await attempt(clientA, CREATE, ['Client Made Co', null, null]), '42501'))
  check('a production user is refused (403)', refusedWith(await attempt(operator, CREATE, ['User Made Co', null, null]), '42501'))
  check('a blank name → 422', refusedWith(await attempt(admin, CREATE, ['   ', null, null]), '22023'))
  check('a punctuation-only name → 422', refusedWith(await attempt(admin, CREATE, ['!!!', null, null]), '22023'))
  const [k1, k2] = await Promise.all([
    attempt(admin, CREATE, ['Northgate Settlement Services', null, null]),
    attempt(superAdmin, CREATE, ['Northgate Settlement Services', null, null]),
  ])
  const statuses = [k1.value?.status, k2.value?.status].sort()
  check('two concurrent creates of one name → one created, one matched, one row',
    same(statuses, ['created', 'matched']) && k1.value.code === k2.value.code &&
    (await one(`select count(*)::int n from public.clients where name = 'Northgate Settlement Services'`)).n === 1,
    `${show(k1)} / ${show(k2)}`)
} catch (err) {
  if (err.message !== 'vacuous') {
    failures++
    console.error(`\nFAIL  unexpected error: ${err.stack || err}`)
  }
} finally {
  await owner.end().catch(() => {})
  await closePool().catch(() => {})
}

if (process.exitCode !== 2) {
  console.log(`\n${failures ? 'FAILED' : 'PASSED'}: ${passes} passed, ${failures} failed (${SHAPE})`)
  process.exitCode = failures ? 1 : 0
}
