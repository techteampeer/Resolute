// Verifies F3 (20260921010000) over the real REST path:
//   - orders.workflow.invoiceAmount is bounds-checked (non-numeric / over-ceiling
//     rejected; a sane value accepted)
//   - product_prices: any signed-in user reads; only super admins write
// Exits non-zero on failure. Requires the local stack + this migration applied.
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

console.log('── F3: order amount bounds ──')
const codes = sqlJson('select code from clients order by code').map(r => r.code)
const c1 = codes[0]
// Owner-scoped RLS (A2): a production `user` may write only orders assigned to
// them, so the amount-bounds order must be owned by the acting user (operator@).
const UID = (sqlJson(`select id from profiles where email = 'operator@resolute.com'`)[0] || {}).id
const OID = 'RTS-AUDIT-F3'
sql(`delete from orders where id = '${OID}'`)
sql(`insert into orders (id, client_code, state, county, type, status, assigned_to, assigned_user_id, progress, created)
     values ('${OID}', ${c1 ? `'${c1}'` : 'null'}, 'FL', 'Test', 'Full Search', 'screening', 'user', '${UID}', 20, current_date)`)

const invOf = () => sqlJson(`select workflow->>'invoiceAmount' as inv from orders where id = '${OID}'`)[0]?.inv ?? null

// non-numeric -> rejected
const bad = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ workflow: { invoiceAmount: 'lots' } }),
})
check('non-numeric invoiceAmount rejected', bad.status >= 400, `HTTP ${bad.status}`)

// over-ceiling -> rejected
const big = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ workflow: { invoiceAmount: 9999999 } }),
})
check('over-ceiling invoiceAmount rejected', big.status >= 400, `HTTP ${big.status}`)

// sane value -> accepted
const ok = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ workflow: { invoiceAmount: 175 } }),
})
check('sane invoiceAmount accepted', ok.status < 400, `HTTP ${ok.status}`)
check('sane invoiceAmount persisted', Number(invOf()) === 175, `db=${invOf()}`)

// negative (credit/discount) within magnitude -> accepted (bound is on magnitude)
const neg = await as('user', `/orders?id=eq.${OID}`, {
  method: 'PATCH', body: JSON.stringify({ workflow: { invoiceAmount: -25 } }),
})
check('negative (discount) invoiceAmount accepted', neg.status < 400, `HTTP ${neg.status}`)

sql(`delete from orders where id = '${OID}'`)

console.log('── F3: product_prices catalogue ──')
const clientRead = await as('client', '/product_prices?select=type,price&limit=1')
check('client can read catalogue', clientRead.status < 400 && Array.isArray(clientRead.body), `HTTP ${clientRead.status}`)

const memberWrite = await as('admin', '/product_prices', {
  method: 'POST', body: JSON.stringify({ type: 'AUDIT ITEM', price: 1 }),
})
check('plain admin cannot write catalogue', memberWrite.status >= 400, `HTTP ${memberWrite.status}`)

const superWrite = await as('rajni', '/product_prices', {
  method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
  body: JSON.stringify({ type: 'AUDIT ITEM', price: 1 }),
})
check('super admin can write catalogue', superWrite.status < 400, `HTTP ${superWrite.status}`)
sql(`delete from product_prices where type = 'AUDIT ITEM'`)

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
