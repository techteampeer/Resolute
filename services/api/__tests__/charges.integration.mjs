// B1 integration: the GCP charge API end-to-end against a REAL Postgres —
// supertest → the actual chargesRouter → withUserClaims (SET ROLE authenticated
// + injected claims) → RLS + resolve_order_charge + order_events/notifications.
// This is the authoritative test: authorization is the database's, so we exercise
// the database, not a mock. It asserts the B1 spec §10 matrix.
//
// Runs against the local Supabase stack (db-integrity CI lane, or `supabase
// start` on a laptop). NOT a .test.js, so root vitest (no DB) skips it; invoked
// explicitly. Reuses the demo accounts the seed already provisions, so it never
// touches auth.users — only its own RTS-GCPIT-* orders, cleaned up at both ends.
//
//   cd services/api && npm install
//   DB_HOST=127.0.0.1 DB_PORT=54322 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
//     node __tests__/charges.integration.mjs

// Defaults BEFORE the dynamic imports below (db.js reads config at import time).
process.env.DB_HOST ??= '127.0.0.1'
process.env.DB_PORT ??= '54322'
process.env.DB_USER ??= 'postgres'
process.env.DB_PASSWORD ??= 'postgres'
process.env.DB_NAME ??= 'postgres'

const express = (await import('express')).default
const request = (await import('supertest')).default
const { chargesRouter } = await import('../src/routes/charges.js')
const { withServiceRole, closePool } = await import('../src/db.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const svc = (text, params) => withServiceRole((c) => c.query(text, params))
const one = async (text, params) => (await svc(text, params)).rows[0] || {}

// ── Minimal app: inject req.user from a header (stands in for the Firebase gate,
// which createServer wires in prod). Everything downstream — the router, claims,
// RLS — is the real code path.
const app = express()
app.use(express.json())
app.use((req, _res, next) => { const h = req.header('x-test-user'); if (h) req.user = JSON.parse(h); next() })
app.use('/api/orders/:orderId/charges', chargesRouter)
app.use((err, _req, res, _next) => { console.error('[it]', err?.message || err); res.status(500).json({ error: 'internal' }) })

const call = (user, method, path, body) =>
  request(app)[method](path).set('x-test-user', JSON.stringify(user)).send(body || {})

const OWN = 'RTS-GCPIT-OWN', TYP = 'RTS-GCPIT-TYP', OTHER = 'RTS-GCPIT-OTHER'
const IDS = [OWN, TYP, OTHER]
const wipe = async () => {
  for (const id of IDS) {
    await svc('delete from public.notification_outbox where order_id = $1', [id])
    await svc('delete from public.order_events where order_id = $1', [id])
    await svc('delete from public.orders where id = $1', [id])
  }
}
const approvedTotal = (charges) =>
  (charges || []).filter((c) => c.status === 'approved').reduce((s, c) => s + Number(c.amount || 0), 0)
const workflowOf = async (id) => (await one('select workflow from public.orders where id = $1', [id])).workflow || {}

try {
  // Resolve the demo identities (seed-provisioned; profiles only, no auth.users).
  // Roles come from the DB so req.user mirrors what the Firebase gate would set.
  const prof = (email) => one(`select id, role, client_code, email from public.profiles where email = $1`, [email])
  const clientP = await prof('client@resolute.com')
  const adminP = await prof('admin@resolute.com')
  const ownerP = await prof('operator@resolute.com')
  const otherP = await prof('typer@resolute.com')
  const cc2 = (await one(`select code from public.clients where code <> $1 order by code limit 1`, [clientP.client_code])).code
  for (const [n, p] of [['client', clientP], ['admin', adminP], ['owner', ownerP], ['other', otherP]]) {
    if (!p.id) { console.log(`*** FAIL  missing demo profile: ${n}`); process.exit(1) }
  }
  const user = (p) => ({ id: p.id, role: p.role, email: p.email })
  const client = user(clientP), admin = user(adminP), owner = user(ownerP), other = user(otherP)
  check('sanity: demo roles are client / admin / user / user',
    client.role === 'client' && admin.role === 'admin' && owner.role === 'user' && other.role === 'user' && owner.id !== other.id,
    `${client.role}/${admin.role}/${owner.role}/${other.role}`)

  await wipe()
  // OWN: a client-owned order with a seeded payment (to prove it stays untouched).
  await svc(`insert into public.orders (id, client_code, state, county, type, status, assigned_to, progress, created, workflow)
    values ($1,$2,'FL','Charge','Full Search','received','admin',5,current_date,
      '{"payment":{"status":"unpaid","method":"ach"}}'::jsonb)`, [OWN, clientP.client_code])
  // TYP: a pipeline-consistent typer-stage order OWNED by the production user.
  await svc(`insert into public.orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, completed_dates)
    values ($1,$2,'FL','Charge','Full Search','typing','user',$3,50,current_date,'{"screener":"2026-11-01","examiner":"2026-11-02"}'::jsonb)`,
    [TYP, clientP.client_code, ownerP.id])
  // OTHER: under a DIFFERENT client, with a pending charge the demo client must not reach.
  await svc(`insert into public.orders (id, client_code, state, county, type, status, assigned_to, progress, created, workflow)
    values ($1,$2,'FL','Other','Full Search','received','admin',5,current_date,
      '{"pendingCharges":[{"id":"oth1","label":"x","amount":20,"status":"pending","resolvedAt":null}]}'::jsonb)`, [OTHER, cc2])

  console.log('── raise (authorization) ──')
  check('client cannot raise (403)', (await call(client, 'post', `/api/orders/${OWN}/charges`, { label: 'copy cost', amount: 25 })).status === 403)
  check('non-owner production user cannot raise (403)', (await call(other, 'post', `/api/orders/${TYP}/charges`, { label: 'x', amount: 10 })).status === 403)

  const r3 = await call(owner, 'post', `/api/orders/${TYP}/charges`, { label: 'extra county', amount: 60 })
  check('owner production user raises (201)', r3.status === 201, `HTTP ${r3.status}`)
  check('raised charge is pending with its amount', (r3.body?.workflow?.pendingCharges || []).some((c) => c.status === 'pending' && Number(c.amount) === 60))
  const typEv = await one(`select action, audience from public.order_events where order_id=$1 and action ilike '%requested on ${TYP}%'`, [TYP])
  check('raise writes a client-visible activity row', typEv.audience === 'all', JSON.stringify(typEv))
  check('raise sends NO notification (in-portal only)', (await one(`select count(*)::int n from public.notification_outbox where order_id=$1`, [TYP])).n === 0)

  const r4 = await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'rush copy', amount: 25 })
  check('admin raises on any order (201)', r4.status === 201, `HTTP ${r4.status}`)
  const OWNCHG = (r4.body?.workflow?.pendingCharges || []).find((c) => c.status === 'pending')?.id
  check('captured the created charge id', !!OWNCHG, OWNCHG)

  console.log('\n── raise (validation + 404) ──')
  check('amount 0 → 422', (await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'a', amount: 0 })).status === 422)
  check('amount over limit → 422', (await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'a', amount: 2_000_000 })).status === 422)
  check('empty label → 422', (await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: '   ', amount: 5 })).status === 422)
  check('non-numeric amount → 422', (await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'a', amount: 'abc' })).status === 422)
  check('unknown order → 404', (await call(admin, 'post', `/api/orders/RTS-NOPE/charges`, { label: 'a', amount: 5 })).status === 404)

  console.log('\n── resolve (authorization + ownership) ──')
  check('staff cannot resolve (403)', (await call(admin, 'post', `/api/orders/${OWN}/charges/${OWNCHG}/resolve`, { decision: 'approved' })).status === 403)
  check('non-owner client cannot resolve someone else’s order (404)', (await call(client, 'post', `/api/orders/${OTHER}/charges/oth1/resolve`, { decision: 'approved' })).status === 404)
  check('invalid decision → 422', (await call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG}/resolve`, { decision: 'maybe' })).status === 422)
  check('unknown charge id → 409', (await call(client, 'post', `/api/orders/${OWN}/charges/chg_nope/resolve`, { decision: 'approved' })).status === 409)

  console.log('\n── resolve (approve: consent-to-bill, not payment) ──')
  const v2 = await call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG}/resolve`, { decision: 'approved' })
  check('owner client approves (200)', v2.status === 200, `HTTP ${v2.status}`)
  const approvedChg = (v2.body?.workflow?.pendingCharges || []).find((c) => c.id === OWNCHG)
  check('charge flipped to approved, amount untouched', approvedChg?.status === 'approved' && Number(approvedChg?.amount) === 25, JSON.stringify(approvedChg))
  check('payment object untouched by approval', JSON.stringify((await workflowOf(OWN)).payment) === JSON.stringify({ status: 'unpaid', method: 'ach' }))
  check('re-resolving an approved charge → 409 (replay guard)', (await call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG}/resolve`, { decision: 'declined' })).status === 409)

  console.log('\n── notifications (admin tier only, never the client) ──')
  const apprRoles = (await svc(`select distinct recipient_role from public.notification_outbox where order_id=$1 and type_key='charge.approved'`, [OWN])).rows
  check('approval enqueues charge.approved to admins only', apprRoles.length >= 1 && apprRoles.every((r) => r.recipient_role === 'admin'), JSON.stringify(apprRoles))
  check('approval writes the durable order_events audit row', (await one(`select 1 as x from public.order_events where order_id=$1 and action ilike '%approved an additional fee%'`, [OWN])).x === 1)
  check('no charge notification targets the client', (await one(`select count(*)::int n from public.notification_outbox where order_id=$1 and type_key like 'charge.%' and recipient_role='client'`, [OWN])).n === 0)

  console.log('\n── decline (non-blocking) ──')
  const d1 = await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'maybe fee', amount: 30 })
  const OWNCHG2 = (d1.body?.workflow?.pendingCharges || []).find((c) => c.status === 'pending')?.id
  const v3 = await call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG2}/resolve`, { decision: 'declined' })
  check('owner client declines (200)', v3.status === 200, `HTTP ${v3.status}`)
  check('decline enqueues charge.declined', (await one(`select 1 as x from public.notification_outbox where order_id=$1 and type_key='charge.declined'`, [OWN])).x === 1)

  console.log('\n── concurrency (exactly-once) ──')
  const c3 = await call(admin, 'post', `/api/orders/${OWN}/charges`, { label: 'concurrent', amount: 40 })
  const OWNCHG3 = (c3.body?.workflow?.pendingCharges || []).find((c) => c.status === 'pending')?.id
  const [p1, p2] = await Promise.all([
    call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG3}/resolve`, { decision: 'approved' }),
    call(client, 'post', `/api/orders/${OWN}/charges/${OWNCHG3}/resolve`, { decision: 'approved' }),
  ])
  const statuses = [p1.status, p2.status].sort()
  check('two parallel approvals → exactly one 200, one 409', statuses[0] === 200 && statuses[1] === 409, JSON.stringify(statuses))
  const finalCharges = (await workflowOf(OWN)).pendingCharges || []
  check('the charge is approved exactly once', finalCharges.filter((c) => c.id === OWNCHG3 && c.status === 'approved').length === 1)
  // Invoice counts each approved charge once and excludes the declined one: 25 + 40.
  check('approved-charges total is exactly-once (25 + 40, decline excluded)', approvedTotal(finalCharges) === 65, `total=${approvedTotal(finalCharges)}`)
  check('payment still untouched after all resolves', JSON.stringify((await workflowOf(OWN)).payment) === JSON.stringify({ status: 'unpaid', method: 'ach' }))

  await wipe()
} catch (err) {
  console.error('\n*** integration error:', err?.stack || err?.message || err)
  failures++
} finally {
  await closePool()
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
