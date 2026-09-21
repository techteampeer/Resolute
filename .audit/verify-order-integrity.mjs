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
console.log('── F1: can_confirm_payments is not self-grantable ──')
const idOf = (email) => (sqlJson(`select id from profiles where email = '${email}'`)[0] || {}).id
for (const who of ['screener', 'client']) {
  const email = `${who}@resolute.com`
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
console.log('── F2: order handoff is server-authoritative ──')
const codes = sqlJson('select code from clients order by code').map(r => r.code)
const c1 = codes[0]
const c2 = codes[1] ?? null           // a different client (or null) to attempt a move to
const OID = 'RTS-AUDIT-F2'
// Fresh test order sitting on the screener's desk.
sql(`delete from orders where id = '${OID}'`)
sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, progress, created)
     values ('${OID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', 'screening', 'screener', 20, current_date)`)

const assignedNow = () => sqlJson(`select assigned_to, client_code from orders where id = '${OID}'`)[0] || {}

// A. move to another client — refused
const a = await as('screener', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ client_code: c2 }),
})
check('cross-client move refused', a.status >= 400, `HTTP ${a.status}`)
check('client_code unchanged in DB', (assignedNow().client_code ?? null) === (c1 ?? null))

// B. hand directly to another desk (skip the Admin gate) — refused
const b = await as('screener', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ assigned_to: 'delivery', status: 'delivery' }),
})
check('direct desk-to-desk handoff refused', b.status >= 400, `HTTP ${b.status}`)
check('assigned_to still screener in DB', assignedNow().assigned_to === 'screener')

// C. return to Admin (the legitimate handoff) — allowed
const c = await as('screener', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ assigned_to: 'admin', status: 'examining' }),
})
check('return-to-Admin allowed', c.status < 400, `HTTP ${c.status}`)
check('assigned_to now admin in DB', assignedNow().assigned_to === 'admin')

// cleanup
sql(`delete from orders where id = '${OID}'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
