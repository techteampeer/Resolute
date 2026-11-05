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

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
