// Verifies the "new client users cannot place orders" fix (20261105010000).
//
// Root cause: orders.client_code is FK'd to clients(code), but profiles.client_code
// was not — and the admin add-user form took the code as free text. A client whose
// profile.client_code named no real client passed the orders_insert_client RLS check
// (order code == my_client_code()) and was then rejected by orders_client_code_fkey,
// so the order silently failed. This checks the DB backstop now added: a profile can
// never be pointed at a non-existent client, while a validly-linked client still
// places orders and a null-linked one is cleanly blocked (not a phantom insert).
//
// Runs against the local stack. Mutates ONE demo profile and restores it.
import { as, sql, sqlJson } from './harness.mjs'

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const throws = (q) => { try { sql(q); return false } catch { return true } }

const row = sqlJson(`select p.id, p.client_code from profiles p
  join auth.users u on u.id = p.id where u.email = 'client@resolute.com'`)[0]
if (!row) { console.log('*** no client@resolute.com profile'); process.exit(1) }
const UID = row.id, ORIG = row.client_code || 'CL01'
const BOGUS = 'CLZZ'
sql(`delete from clients where code = '${BOGUS}'`)

console.log('── profiles.client_code FK (provisioning backstop) ──')
// 1. A profile can NOT be pointed at a client that does not exist (the fix).
const rejected = throws(`update profiles set client_code = '${BOGUS}' where id = '${UID}'`)
check('profile update to a non-existent client is rejected', rejected)
check('profile left pointing at the real client', (sqlJson(`select client_code from profiles where id='${UID}'`)[0]||{}).client_code === ORIG)
// 2. A real client code is accepted; NULL (staff) is allowed.
check('profile update to a real client is accepted', !throws(`update profiles set client_code = '${ORIG}' where id = '${UID}'`))

console.log('\n── order placement end-to-end (RLS enforced) ──')
const place = (oid, ccode) => as('client', '/orders', { method: 'POST', body: JSON.stringify({
  id: oid, client_code: ccode, state: 'FL', county: 'Prov', type: 'Full Search',
  status: 'received', priority: 'normal', assigned_to: 'admin', progress: 5,
  created: new Date().toISOString().slice(0, 10), workflow: { intake: { source: 'web' } },
}) })

// 3. A correctly-linked client places an order.
sql(`update profiles set client_code = '${ORIG}' where id = '${UID}'`)
sql(`delete from orders where id = 'RTS-PROV-OK'`)
const ok = await place('RTS-PROV-OK', ORIG)
check('a correctly-linked client places an order', ok.status < 400, `HTTP ${ok.status}`)
sql(`delete from orders where id = 'RTS-PROV-OK'`)

// 4. The orders FK still rejects a dangling order code directly (defense in depth).
const fk = throws(`insert into orders (id, client_code, state, county, type, status, assigned_to, progress, created)
  values ('RTS-PROV-FK', '${BOGUS}', 'FL', 'Prov', 'Full Search', 'received', 'admin', 5, current_date)`)
check('orders.client_code FK rejects an unknown client', fk)
sql(`delete from orders where id = 'RTS-PROV-FK'`)

// 5. A client with NO client_code is blocked by RLS (my_client_code() is null) —
//    no phantom order, a clean refusal rather than a silent failure.
sql(`update profiles set client_code = null where id = '${UID}'`)
sql(`delete from orders where id = 'RTS-PROV-NULL'`)
const noCode = await place('RTS-PROV-NULL', null)
check('an unlinked client cannot place an order (RLS)', noCode.status >= 400, `HTTP ${noCode.status}`)
check('no phantom order persisted', sqlJson(`select count(*)::int n from orders where id='RTS-PROV-NULL'`)[0].n === 0)
sql(`delete from orders where id = 'RTS-PROV-NULL'`)

// restore
sql(`update profiles set client_code = '${ORIG}' where id = '${UID}'`)
console.log(`\nrestored client_code → ${ORIG}`)
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
