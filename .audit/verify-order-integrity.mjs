// Verifies the order-integrity DB layer over the REAL REST path (RLS + triggers):
//   F1  a non-billing user cannot self-grant can_confirm_payments
//   F2  a staffer cannot move an order to another client, hand it directly to
//       another desk, or reassign it to another user; returning to Admin works
//   A2  a production user may write ONLY orders assigned to them (owner-scoped)
//   A1  a single-seated order's OWNER advances it in-seat with no Admin gate,
//       while ordered stamping / derived status / terminal rules still hold; a
//       NON-single-seated order still hits the every-stage Admin gate
// Model script: it ASSERTS with an exit code (exit 1 on any failure).
//
// Requires the local stack: `supabase start` + migrations applied.
//   node .audit/verify-order-integrity.mjs
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

const idOf = (email) => (sqlJson(`select id from profiles where email = '${email}'`)[0] || {}).id
// The production `user` login (operator@) is the order owner in these tests;
// OTHER is any other real profile id, used as "a different user".
const UID = idOf('operator@resolute.com')
const OTHER = idOf('rajni@resolute.com')

// ── F1: self-grant of can_confirm_payments must be refused ──────────────────
console.log('── F1: can_confirm_payments is not self-grantable ──')
for (const [who, email] of [['user', 'operator@resolute.com'], ['client', 'client@resolute.com']]) {
  const id = idOf(email)
  const r = await as(who, `/profiles?id=eq.${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ can_confirm_payments: true }),
  })
  const stillFalse = sqlJson(`select can_confirm_payments from profiles where id = '${id}'`)[0]?.can_confirm_payments === false
  check(`${who} self-grant refused`, r.status >= 400, `HTTP ${r.status}`)
  check(`${who} flag still false in DB`, stillFalse)
}

// ── F2: order handoff integrity ─────────────────────────────────────────────
// The order is single-seated and OWNED BY the production user (assigned_user_id
// = UID), so owner-scoped RLS lets them write it; the guard constrains the shape.
console.log('── F2: order handoff is server-authoritative ──')
const codes = sqlJson('select code from clients order by code').map(r => r.code)
const c1 = codes[0]
const c2 = codes[1] ?? null           // a different client (or null) to attempt a move to
const OID = 'RTS-AUDIT-F2'
sql(`delete from orders where id = '${OID}'`)
sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, workflow)
     values ('${OID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', 'screening', 'user', '${UID}', 20, current_date, '{"singleSeating":true}'::jsonb)`)

const row = () => sqlJson(`select assigned_to::text a, client_code cc, assigned_user_id u from orders where id = '${OID}'`)[0] || {}

// A. move to another client — refused
const a = await as('user', `/orders?id=eq.${OID}`, { method: 'PATCH', body: JSON.stringify({ client_code: c2 }) })
check('cross-client move refused', a.status >= 400, `HTTP ${a.status}`)
check('client_code unchanged in DB', (row().cc ?? null) === (c1 ?? null))

// B. hand directly to another desk (skip the Admin gate) — refused
const b = await as('user', `/orders?id=eq.${OID}`, { method: 'PATCH', body: JSON.stringify({ assigned_to: 'delivery', status: 'delivery' }) })
check('direct desk-to-desk handoff refused', b.status >= 400, `HTTP ${b.status}`)
check('assigned_to still user in DB', row().a === 'user')

// B2. reassign to another user directly — refused (a real reassign goes via Admin)
const b2 = await as('user', `/orders?id=eq.${OID}`, { method: 'PATCH', body: JSON.stringify({ assigned_user_id: OTHER }) })
check('user cannot reassign to another user', b2.status >= 400, `HTTP ${b2.status}`)
check('owner unchanged in DB', row().u === UID)

// C. return to Admin (the legitimate handoff) — allowed, even for single-seating.
const c = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ assigned_to: 'admin', status: 'examining', completed_dates: { screener: '2026-06-01' } }),
})
check('return-to-Admin allowed', c.status < 400, `HTTP ${c.status}`)
check('assigned_to now admin in DB', row().a === 'admin')

// D. parked with Admin — a production user can no longer write it (out of pool).
const beforeD = sqlJson(`select progress from orders where id = '${OID}'`)[0].progress
await as('user', `/orders?id=eq.${OID}`, { method: 'PATCH', body: JSON.stringify({ progress: 999 }) })
check('user cannot write an order outside the pool',
  sqlJson(`select progress from orders where id = '${OID}'`)[0].progress === beforeD)
sql(`delete from orders where id = '${OID}'`)

// ── A2: writes are scoped to the assigned user ──────────────────────────────
console.log('── A2: order writes are owner-scoped ──')
const OWN = 'RTS-AUDIT-A2'
const mk = (owner) => {
  sql(`delete from orders where id = '${OWN}'`)
  sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, workflow)
       values ('${OWN}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', 'screening', 'user', ${owner ? `'${owner}'` : 'null'}, 30, current_date, '{"singleSeating":true}'::jsonb)`)
}
const prog = () => sqlJson(`select progress from orders where id = '${OWN}'`)[0]?.progress
mk(OTHER)
await as('user', `/orders?id=eq.${OWN}`, { method: 'PATCH', body: JSON.stringify({ progress: 999 }) })
check("cannot write another user's order", prog() === 30)
mk(null)
await as('user', `/orders?id=eq.${OWN}`, { method: 'PATCH', body: JSON.stringify({ progress: 999 }) })
check('cannot write an unowned pool order', prog() === 30)
mk(UID)
const mine = await as('user', `/orders?id=eq.${OWN}`, { method: 'PATCH', body: JSON.stringify({ progress: 31 }) })
check('can write my own assigned order', mine.status < 400 && prog() === 31, `HTTP ${mine.status}`)
sql(`delete from orders where id = '${OWN}'`)

// ── A1: single-seating bypass + pipeline state machine ──────────────────────
console.log('── A1: single-seating advances in-seat; the machine still holds ──')
const TID = 'RTS-AUDIT-A1'
const stat = () => sqlJson(`select assigned_to::text a, status::text s from orders where id = '${TID}'`)[0] || {}
const dates = () => sqlJson(`select completed_dates cd from orders where id = '${TID}'`)[0]?.cd || {}
// single: seat mode; owner defaults to UID so owner-scoped RLS admits the write.
const reset = (d, { status = 'delivery', single = true, owner = UID } = {}) => {
  sql(`delete from orders where id = '${TID}'`)
  sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, completed_dates, workflow)
       values ('${TID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', '${status}', 'user', ${owner ? `'${owner}'` : 'null'}, 80, current_date, '${d}'::jsonb, '{"singleSeating":${single}}'::jsonb)`)
}
const DELIVERY_READY = '{"screener":"2026-06-01","examiner":"2026-06-02","typer":"2026-06-03"}'
const P = (body) => as('user', `/orders?id=eq.${TID}`, { method: 'PATCH', body: JSON.stringify(body) })

// A. single-seating: the owner advances stage after stage IN-SEAT, no Admin gate.
reset('{}', { status: 'screening' })
const ss1 = await P({ completed_dates: { screener: '2026-06-01' }, status: 'examining' })
check('single-seating: stamp screener in-seat allowed', ss1.status < 400, `HTTP ${ss1.status}`)
check('stayed in pool at examining (no Admin gate)', stat().a === 'user' && stat().s === 'examining')
const ss2 = await P({ completed_dates: { screener: '2026-06-01', examiner: '2026-06-02' }, status: 'typing' })
check('single-seating: stamp examiner in-seat allowed', ss2.status < 400, `HTTP ${ss2.status}`)
check('advanced to typing in pool', stat().a === 'user' && stat().s === 'typing')

// B. NON-single-seating: the every-stage Admin gate is still enforced.
reset('{}', { status: 'screening', single: false })
check('non-single-seating stamp without Admin refused',
  (await P({ completed_dates: { screener: '2026-06-01' }, status: 'examining' })).status >= 400)
check('screener still unstamped', dates().screener == null)
const nssOk = await P({ completed_dates: { screener: '2026-06-01' }, assigned_to: 'admin', status: 'examining' })
check('non-single-seating stamp + return-to-Admin allowed', nssOk.status < 400, `HTTP ${nssOk.status}`)

// C. ordered stamping is still enforced (even for single-seating).
reset('{}', { status: 'screening' })
check('back-filling multiple stage dates refused',
  (await P({ completed_dates: { screener: '2026-06-01', examiner: '2026-06-02', typer: '2026-06-03' }, status: 'typing' })).status >= 400)
check('completed_dates unchanged', Object.keys(dates()).length === 0)
check('stamping out of order (skip screener) refused',
  (await P({ completed_dates: { examiner: '2026-06-02' }, status: 'typing' })).status >= 400)
check('junk (non-date) stamp refused',
  (await P({ completed_dates: { screener: 'soon' }, status: 'examining' })).status >= 400)
reset('{"screener":"2026-06-01"}', { status: 'examining' })
check('clearing an earlier stage date refused',
  (await P({ completed_dates: {}, status: 'screening' })).status >= 400)

// D. terminal delivery completion (single-seating) — the legitimate finish.
reset(DELIVERY_READY, { status: 'delivery' })
const done = await P({ completed_dates: { screener: '2026-06-01', examiner: '2026-06-02', typer: '2026-06-03', delivery: '2026-06-04' }, assigned_to: null, status: 'delivered', completed: '2026-06-04' })
check('single-seating delivery completion allowed', done.status < 400, `HTTP ${done.status}`)
check('order delivered + desk cleared', stat().a == null && stat().s === 'delivered', `a=${stat().a} s=${stat().s}`)

// E. terminal / status-derivation guards still refuse the bad transitions.
reset('{}', { status: 'screening' })
check('early-stage terminal jump refused', (await P({ assigned_to: null, status: 'delivered' })).status >= 400)
check('order still in pool', stat().a === 'user')
reset(DELIVERY_READY, { status: 'delivery' })
check('clear-desk with wrong status refused', (await P({ assigned_to: null, status: 'screening' })).status >= 400)
reset(DELIVERY_READY, { status: 'delivery' })
check('completion without a delivery stamp refused', (await P({ assigned_to: null, status: 'delivered' })).status >= 400)
reset('{}', { status: 'screening' })
check('setting status=delivered while in the pool refused', (await P({ status: 'delivered' })).status >= 400)
check('status unchanged', stat().s === 'screening')

sql(`delete from orders where id = '${TID}'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
