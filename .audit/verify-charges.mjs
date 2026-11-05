// Verifies resolve_order_charge (20261105000000) over the real RPC path:
//   - the OWNING client can approve / decline a pending charge; status flips and
//     the amount is never touched (consent can't be forged into a different fee)
//   - an invalid decision is rejected
//   - an already-resolved charge can't be re-resolved (no pending → error)
//   - a NON-owner (a staff `user`, whose my_client_code() is null) cannot resolve
// Exits non-zero on failure. Requires the local stack + this migration applied.
import { as, rpc, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

// Act on one of the client's OWN orders (RLS returns only theirs).
const mine = await as('client', '/orders?select=id,client_code&limit=1')
const OID = Array.isArray(mine.body) && mine.body[0]?.id
if (!OID) { console.log('*** FAIL  no client-owned order to test against'); process.exit(1) }

const CHG = 'audit-chg-1'
const seed = () => sql(`update orders set workflow = jsonb_set(coalesce(workflow,'{}'::jsonb),'{pendingCharges}',
  '[{"id":"${CHG}","label":"audit county","amount":40,"raisedBy":"Rajni","raisedByRole":"admin","raisedAt":"2026-11-05","status":"pending","resolvedAt":null}]'::jsonb, true)
  where id = '${OID}'`)
const chargeState = () => sqlJson(`select workflow->'pendingCharges'->0->>'status' as st,
  workflow->'pendingCharges'->0->>'amount' as amt from orders where id = '${OID}'`)[0] || {}

console.log('── resolve_order_charge ──')

// 1. Owner approves a pending charge → flips to approved, amount untouched.
seed()
const approve = await rpc('client', 'resolve_order_charge', { p_order_id: OID, p_charge_id: CHG, p_decision: 'approved' })
check('owner can approve a pending charge', approve.status < 400, `HTTP ${approve.status}`)
let st = chargeState()
check('charge status flipped to approved', st.st === 'approved', `status=${st.st}`)
check('charge amount untouched by approval', st.amt === '40', `amount=${st.amt}`)

// 2. Re-resolving an already-approved charge is rejected (no pending charge).
const redo = await rpc('client', 'resolve_order_charge', { p_order_id: OID, p_charge_id: CHG, p_decision: 'declined' })
check('cannot re-resolve an already-decided charge', redo.status >= 400, `HTTP ${redo.status}`)
check('re-resolve left the approval intact', chargeState().st === 'approved', `status=${chargeState().st}`)

// 3. An invalid decision is rejected.
seed()
const bad = await rpc('client', 'resolve_order_charge', { p_order_id: OID, p_charge_id: CHG, p_decision: 'maybe' })
check('invalid decision rejected', bad.status >= 400, `HTTP ${bad.status}`)
check('invalid decision left the charge pending', chargeState().st === 'pending', `status=${chargeState().st}`)

// 4. A non-owner (staff `user`, my_client_code() is null) cannot resolve it.
const notOwner = await rpc('user', 'resolve_order_charge', { p_order_id: OID, p_charge_id: CHG, p_decision: 'approved' })
check('non-owner cannot resolve the charge', notOwner.status >= 400, `HTTP ${notOwner.status}`)
check('non-owner attempt left the charge pending', chargeState().st === 'pending', `status=${chargeState().st}`)

// Clean up: remove the audit charge from the real demo order.
sql(`update orders set workflow = workflow - 'pendingCharges' where id = '${OID}'`)

console.log('\n── raise path (Admin / Typer write pendingCharges) ──')
// A production `user` may raise a fee only on an order assigned to them (owner RLS);
// Admin may raise on any order. The F3 amount guard watches invoiceAmount /
// abstractorFee, so writing pendingCharges must not trip it.
const UID = (sqlJson(`select id from profiles where email = 'operator@resolute.com'`)[0] || {}).id
const SOID = 'RTS-AUDIT-CHG'
const c1 = sqlJson('select code from clients order by code limit 1')[0]?.code
sql(`delete from orders where id = '${SOID}'`)
// A pipeline-CONSISTENT typer-stage order (screener+examiner done → status 'typing'),
// owned by the production user. Status is derived server-side, so a malformed status
// would be rejected by the derivation guard before we ever test the raise.
sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created, completed_dates)
     values ('${SOID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Charge', 'Full Search', 'typing', 'user', '${UID}', 50, current_date,
             '{"screener":"2026-11-01","examiner":"2026-11-02"}'::jsonb)`)

const CHARGE = JSON.stringify([{ id: 'raise1', label: 'extra county', amount: 60, raisedBy: 'Op', raisedByRole: 'user', raisedAt: '2026-11-05', status: 'pending' }])
const raiseAs = (who) => as(who, `/orders?id=eq.${SOID}`, { method: 'PATCH', body: JSON.stringify({ workflow: { pendingCharges: JSON.parse(CHARGE) } }) })
const pc = () => sqlJson(`select workflow->'pendingCharges'->0->>'status' as st, workflow->'pendingCharges'->0->>'amount' as amt from orders where id = '${SOID}'`)[0] || {}

// owner (production user) can raise on their own order; F3 guard not tripped
const asOwner = await raiseAs('user')
check('owner production user can raise a fee', asOwner.status < 400, `HTTP ${asOwner.status}`)
check('raised charge persisted with its amount', pc().st === 'pending' && pc().amt === '60', `st=${pc().st} amt=${pc().amt}`)

// a non-owner production user cannot touch it (owner-scoped RLS) — the typer login
// is a different `user` account; its PATCH is filtered to 0 rows, leaving the order
// unchanged (the anti-tamper guarantee).
const OTHER = (sqlJson(`select id from profiles where email = 'typer@resolute.com'`)[0] || {}).id
check('sanity: typer is a different production user', !!OTHER && OTHER !== UID, `${OTHER}`)
await as('typer', `/orders?id=eq.${SOID}`, { method: 'PATCH', body: JSON.stringify({ workflow: { pendingCharges: [] } }) })
check('a non-owner production user leaves the order unchanged',
  sqlJson(`select jsonb_array_length(coalesce(workflow->'pendingCharges','[]'::jsonb)) n from orders where id='${SOID}'`)[0].n === 1)

// admin can raise on any order
const asAdmin = await as('admin', `/orders?id=eq.${SOID}`, { method: 'PATCH', body: JSON.stringify({ workflow: { pendingCharges: JSON.parse(CHARGE) } }) })
check('admin can raise a fee on any order', asAdmin.status < 400, `HTTP ${asAdmin.status}`)

sql(`delete from orders where id = '${SOID}'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
