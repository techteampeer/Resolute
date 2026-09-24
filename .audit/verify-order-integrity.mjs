// Verifies the 20260921000000 hardening over the REAL REST path (RLS + triggers):
//   F1  a non-billing user cannot self-grant can_confirm_payments
//   F2  a staffer cannot move an order to another client, nor hand it directly
//       to another desk; returning it to Admin still works
// Model script: it ASSERTS with an exit code (exit 1 on any failure), which is
// the pattern the rest of .audit/ should adopt (roadmap workstream H).
//
// Requires the local stack: `supabase start` + this migration applied.
//   node .audit/verify-order-integrity.mjs
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

// ── F1: self-grant of can_confirm_payments must be refused ──────────────────
// Role-agnostic guard: any non-service authenticated account is blocked. A
// production `user` (operator@) and a client stand in for "not the billing owner".
console.log('── F1: can_confirm_payments is not self-grantable ──')
const idOf = (email) => (sqlJson(`select id from profiles where email = '${email}'`)[0] || {}).id
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
// Post-D3 the production login is `user` and orders are worked from the `user`
// pool (orders_update_assigned = can_work_production() and assigned_to='user').
// guard_order_handoff() is unchanged and still enforces the same two vectors.
console.log('── F2: order handoff is server-authoritative ──')
const codes = sqlJson('select code from clients order by code').map(r => r.code)
const c1 = codes[0]
const c2 = codes[1] ?? null           // a different client (or null) to attempt a move to
const OID = 'RTS-AUDIT-F2'
// Fresh test order sitting in the production (`user`) pool.
sql(`delete from orders where id = '${OID}'`)
sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, progress, created)
     values ('${OID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', 'screening', 'user', 20, current_date)`)

const assignedNow = () => sqlJson(`select assigned_to, client_code from orders where id = '${OID}'`)[0] || {}

// A. move to another client — refused
const a = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ client_code: c2 }),
})
check('cross-client move refused', a.status >= 400, `HTTP ${a.status}`)
check('client_code unchanged in DB', (assignedNow().client_code ?? null) === (c1 ?? null))

// B. hand directly to another desk (skip the Admin gate) — refused
const b = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ assigned_to: 'delivery', status: 'delivery' }),
})
check('direct desk-to-desk handoff refused', b.status >= 400, `HTTP ${b.status}`)
check('assigned_to still user in DB', assignedNow().assigned_to === 'user')

// C. return to Admin (the legitimate handoff) — allowed
const c = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ assigned_to: 'admin', status: 'examining' }),
})
check('return-to-Admin allowed', c.status < 400, `HTTP ${c.status}`)
check('assigned_to now admin in DB', assignedNow().assigned_to === 'admin')

// D. the order has left the pool (parked with Admin) — a production user can no
//    longer write it. This is the new scoping: the capability is the user pool,
//    not "any staff". RLS filters the row out, so the PATCH updates 0 rows.
const beforeD = sqlJson(`select progress from orders where id = '${OID}'`)[0].progress
await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ progress: 999 }),
})
check('user cannot write an order outside the pool',
  sqlJson(`select progress from orders where id = '${OID}'`)[0].progress === beforeD,
  `progress was ${beforeD}`)

// cleanup
sql(`delete from orders where id = '${OID}'`)

// ── D3: the terminal transition is delivery-completion only ─────────────────
// Clearing the desk (assigned_to -> null) for a pooled user is valid ONLY when
// it writes status 'delivered' AND the three earlier stages are already stamped.
// That stops (a) jumping an early-stage order to done and (b) leaving an
// unassigned order in an inconsistent state.
console.log('── D3: pipeline state machine is server-authoritative ──')
const TID = 'RTS-AUDIT-D3'
const stat = () => sqlJson(`select assigned_to::text a, status::text s from orders where id = '${TID}'`)[0] || {}
const dates = () => sqlJson(`select completed_dates cd from orders where id = '${TID}'`)[0]?.cd || {}
const reset = (d, status = 'delivery') => {
  sql(`delete from orders where id = '${TID}'`)
  sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, progress, created, completed_dates)
       values ('${TID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', '${status}', 'user', 80, current_date, '${d}'::jsonb)`)
}
const DELIVERY_READY = '{"screener":"2026-06-01","examiner":"2026-06-02","typer":"2026-06-03"}'
const P = (body) => as('user', `/orders?id=eq.${TID}`, { method: 'PATCH', body: JSON.stringify(body) })

// A. early stage, nothing done -> jumping straight to delivered is refused
reset('{}', 'screening')
check('early-stage terminal jump refused', (await P({ assigned_to: null, status: 'delivered' })).status >= 400)
check('order still in pool', stat().a === 'user')

// B. delivery-ready, but clearing the desk with a non-delivered status is refused
reset(DELIVERY_READY)
check('clear-desk with wrong status refused', (await P({ assigned_to: null, status: 'screening' })).status >= 400)
check('order not left unassigned/inconsistent', stat().a === 'user')

// B2. delivery-ready + delivered but WITHOUT stamping the delivery date is refused
reset(DELIVERY_READY)
check('completion without a delivery stamp refused', (await P({ assigned_to: null, status: 'delivered' })).status >= 400)
check('still in pool', stat().a === 'user')

// C. delivery-ready + delivery stamped + delivered -> the legitimate completion
reset(DELIVERY_READY)
const c3 = await P({ completed_dates: { screener: '2026-06-01', examiner: '2026-06-02', typer: '2026-06-03', delivery: '2026-06-04' }, assigned_to: null, status: 'delivered', completed: '2026-06-04' })
check('legitimate delivery completion allowed', c3.status < 400, `HTTP ${c3.status}`)
check('order delivered + desk cleared', stat().a == null && stat().s === 'delivered', `a=${stat().a} s=${stat().s}`)

// D. completed_dates advances one stage at a time, in order — no back-fill.
reset('{}', 'screening')
check('back-filling multiple stage dates refused', (await P({ completed_dates: { screener: '2026-06-01', examiner: '2026-06-02', typer: '2026-06-03' } })).status >= 400)
check('completed_dates unchanged', Object.keys(dates()).length === 0)
check('stamping out of order (skip screener) refused', (await P({ completed_dates: { examiner: '2026-06-02' } })).status >= 400)
check('junk (non-date) stamp refused', (await P({ completed_dates: { screener: 'soon' }, assigned_to: 'admin', status: 'examining' })).status >= 400)
// The Admin gate: stamping a non-delivery stage MUST return the order to Admin.
check('stamping without returning to Admin refused', (await P({ completed_dates: { screener: '2026-06-01' } })).status >= 400)
check('screener still unstamped', dates().screener == null)
// Stamping the current stage AND handing back to Admin is the legitimate move.
const step = await P({ completed_dates: { screener: '2026-06-01' }, assigned_to: 'admin', status: 'examining' })
check('stamp + return-to-Admin allowed', step.status < 400, `HTTP ${step.status}`)
check('screener date set + parked with Admin', dates().screener != null && stat().a === 'admin')

// E. status is derived from the pipeline: a pooled user can't set it freely.
reset('{}', 'screening')
check('setting status=delivered while in the pool refused', (await P({ status: 'delivered' })).status >= 400)
check('status unchanged', stat().s === 'screening')

sql(`delete from orders where id = '${TID}'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
