// B3 integration (access-control slice): the GCP documents API end-to-end against
// a REAL Postgres — supertest → the actual documentsRouter → withUserClaims →
// RLS. Enforces delivery-only release server-side: staff see the whole paper
// trail; a client sees only what Delivery released. GCS signing/upload is
// env-gated (asserted to fail safe with 501 once authorized).
//
//   cd services/api && npm install
//   DB_HOST=127.0.0.1 DB_PORT=54322 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
//     node __tests__/documents.integration.mjs

process.env.DB_HOST ??= '127.0.0.1'
process.env.DB_PORT ??= '54322'
process.env.DB_USER ??= 'postgres'
process.env.DB_PASSWORD ??= 'postgres'
process.env.DB_NAME ??= 'postgres'

const express = (await import('express')).default
const request = (await import('supertest')).default
const { documentsRouter } = await import('../src/routes/documents.js')
const { withServiceRole, closePool } = await import('../src/db.js')

let failures = 0
const check = (name, pass, detail = '') => {
  console.log(`  ${pass ? '✓' : '*** FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}
const svc = (text, params) => withServiceRole((c) => c.query(text, params))
const one = async (text, params) => (await svc(text, params)).rows[0] || {}

const app = express()
app.use(express.json())
app.use((req, _res, next) => { const h = req.header('x-test-user'); if (h) req.user = JSON.parse(h); next() })
app.use('/api/orders/:orderId/documents', documentsRouter)
app.use((err, _req, res, _next) => { console.error('[it]', err?.message || err); res.status(500).json({ error: 'internal' }) })

const list = (user, oid) => request(app).get(`/api/orders/${oid}/documents`).set('x-test-user', JSON.stringify(user))
const open = (user, oid, docId) => request(app).post(`/api/orders/${oid}/documents/${encodeURIComponent(docId)}/open`).set('x-test-user', JSON.stringify(user))

const OWN = 'RTS-GCPIT-DOCS', OTHER = 'RTS-GCPIT-DOCS2'
const WF = JSON.stringify({
  titleSearchDoc: { name: 'search.pdf', type: 'application/pdf', path: 'orders/o/ts.pdf' },
  screenerDoc: { name: 'scr.pdf', type: 'application/pdf', path: 'orders/o/scr.pdf' },
  deliveryDocs: [
    { id: 'd1', name: 'final.pdf', type: 'application/pdf', path: 'orders/o/d1.pdf', sendToCustomer: true },
    { id: 'd2', name: 'notes.pdf', type: 'application/pdf', path: 'orders/o/d2.pdf', sendToCustomer: false },
  ],
  docShare: { screener: true, 'delivery:d1': false },
})
const wipe = async () => { for (const id of [OWN, OTHER]) { await svc('delete from public.order_events where order_id=$1', [id]); await svc('delete from public.orders where id=$1', [id]) } }
const ids = (res) => (Array.isArray(res.body) ? res.body.map((d) => d.id).sort() : [])

try {
  const clientP = await one(`select id, client_code, email from public.profiles where email='client@resolute.com'`)
  const adminP = await one(`select id, email from public.profiles where email='admin@resolute.com'`)
  if (!clientP.id || !adminP.id) { console.log('*** FAIL  missing demo profile'); process.exit(1) }
  const admin = { id: adminP.id, role: 'admin', email: adminP.email }
  const client = { id: clientP.id, role: 'client', email: clientP.email }
  const cc2 = (await one(`select code from public.clients where code <> $1 order by code limit 1`, [clientP.client_code])).code

  await wipe()
  await svc(`insert into public.orders (id, client_code, state, county, type, status, assigned_to, progress, created, workflow)
    values ($1,$2,'FL','Doc','Full Search','received','admin',5,current_date,$3::jsonb)`, [OWN, clientP.client_code, WF])
  await svc(`insert into public.orders (id, client_code, state, county, type, status, assigned_to, progress, created, workflow)
    values ($1,$2,'FL','Doc','Full Search','received','admin',5,current_date,$3::jsonb)`, [OTHER, cc2, WF])

  console.log('── listing (delivery-only release) ──')
  const staffList = await list(admin, OWN)
  check('staff see the whole paper trail (4 docs)', staffList.status === 200 && ids(staffList).length === 4, JSON.stringify(ids(staffList)))
  const cliList = await list(client, OWN)
  check('owner client sees only released docs (titleSearch + overridden screener)', cliList.status === 200
    && JSON.stringify(ids(cliList)) === JSON.stringify(['screener', 'titleSearch']), JSON.stringify(ids(cliList)))
  check('client list excludes the un-released delivery docs', !ids(cliList).includes('delivery:d1') && !ids(cliList).includes('delivery:d2'))
  check('non-owner client cannot list another order’s docs (404)', (await list(client, OTHER)).status === 404)

  console.log('\n── open authorization (403 vs 501) ──')
  check('client opening a released doc → 501 (authorized; GCS signing env-gated)', (await open(client, OWN, 'titleSearch')).status === 501)
  check('client opening the overridden-shared screener → 501', (await open(client, OWN, 'screener')).status === 501)
  check('client opening an un-released delivery doc → 403', (await open(client, OWN, 'delivery:d1')).status === 403)
  check('client opening a never-shared doc → 403', (await open(client, OWN, 'delivery:d2')).status === 403)
  check('client opening an unknown doc → 404', (await open(client, OWN, 'nope:x')).status === 404)
  check('staff opening any referenced doc → 501 (authorized)', (await open(admin, OWN, 'delivery:d2')).status === 501)
  check('staff opening an unknown doc → 404', (await open(admin, OWN, 'nope:x')).status === 404)
  check('non-owner client opening a doc on another order → 404', (await open(client, OTHER, 'titleSearch')).status === 404)

  await wipe()
} catch (err) {
  console.error('\n*** integration error:', err?.stack || err?.message || err)
  failures++
} finally {
  await closePool()
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
