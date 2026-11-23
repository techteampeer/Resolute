// B2 integration: the GCP client-company API end-to-end against a REAL Postgres —
// supertest → the actual clientsRouter → withUserClaims → admin_create_client →
// intake_resolve_client (per-name advisory lock, normalised match, CL-code
// allocation). Authorization + the resolver are the database's, so we exercise
// the database, not a mock.
//
// Runs against the local Supabase stack (db-integrity CI lane, or `supabase
// start` on a laptop). Not a .test.js, so root vitest (no DB) skips it. Reuses the
// demo accounts; its own Zzgcpit-* test clients are cleaned up at both ends.
//
//   cd services/api && npm install
//   DB_HOST=127.0.0.1 DB_PORT=54322 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
//     node __tests__/clients.integration.mjs

process.env.DB_HOST ??= '127.0.0.1'
process.env.DB_PORT ??= '54322'
process.env.DB_USER ??= 'postgres'
process.env.DB_PASSWORD ??= 'postgres'
process.env.DB_NAME ??= 'postgres'

const express = (await import('express')).default
const request = (await import('supertest')).default
const { clientsRouter } = await import('../src/routes/clients.js')
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
app.use('/api/clients', clientsRouter)
app.use((err, _req, res, _next) => { console.error('[it]', err?.message || err); res.status(500).json({ error: 'internal' }) })

const call = (user, body) =>
  request(app).post('/api/clients').set('x-test-user', JSON.stringify(user)).send(body || {})

const PREFIX = 'Zzgcpit'
const nonce = Date.now().toString(36)
const wipe = () => svc(`delete from public.clients where name like $1`, [`${PREFIX}%`])

try {
  const prof = (email) => one(`select id, role, email from public.profiles where email = $1`, [email])
  const adminP = await prof('admin@resolute.com')
  const userP = await prof('operator@resolute.com')
  const clientP = await prof('client@resolute.com')
  if (!adminP.id || !userP.id || !clientP.id) { console.log('*** FAIL  missing demo profile'); process.exit(1) }
  const u = (p) => ({ id: p.id, role: p.role, email: p.email })
  const admin = u(adminP), user = u(userP), client = u(clientP)
  check('sanity: demo roles are admin / user / client',
    admin.role === 'admin' && user.role === 'user' && client.role === 'client', `${admin.role}/${user.role}/${client.role}`)

  await wipe()
  const NEW = `${PREFIX} Harborline ${nonce}`
  const VARIANT = `   ${PREFIX.toUpperCase()}   Harborline, ${nonce}.  ` // same client_name_key as NEW

  console.log('── authorization ──')
  check('non-admin (production user) cannot create (403)', (await call(user, { company: NEW })).status === 403)
  check('client cannot create (403)', (await call(client, { company: NEW })).status === 403)

  console.log('\n── validation ──')
  check('empty company → 422', (await call(admin, { company: '' })).status === 422)
  check('whitespace company → 422', (await call(admin, { company: '   ' })).status === 422)
  // A name that is only punctuation normalises to nothing: the DB raises 22023 → 422.
  check('punctuation-only company → 422', (await call(admin, { company: '.,-' })).status === 422)

  console.log('\n── create / match (idempotent) / normalise ──')
  const c1 = await call(admin, { company: NEW })
  check('admin creates a new client (201)', c1.status === 201, `HTTP ${c1.status}`)
  check('result is status=created with a CL code', c1.body?.status === 'created' && /^CL\d+$/.test(c1.body?.code || ''), JSON.stringify(c1.body))
  const CODE = c1.body?.code
  check('the client row exists with that code + name', (await one(`select 1 as x from public.clients where code=$1 and name=$2`, [CODE, NEW])).x === 1)

  const c2 = await call(admin, { company: NEW })
  check('creating the same name again → 200 matched, same code (idempotent)', c2.status === 200 && c2.body?.status === 'matched' && c2.body?.code === CODE, JSON.stringify(c2.body))

  const c3 = await call(admin, { company: VARIANT })
  check('a case/punctuation variant matches the same client (normalised)', c3.status === 200 && c3.body?.status === 'matched' && c3.body?.code === CODE, JSON.stringify(c3.body))
  check('no duplicate client row was created for the variant', (await one(`select count(*)::int n from public.clients where name like $1 and name ~* 'harborline'`, [`${PREFIX}%`])).n === 1)

  console.log('\n── contact + email written onto a created client ──')
  const WD = `${PREFIX} Westvale ${nonce}`
  const c4 = await call(admin, { company: WD, contact: 'Dana Lee', email: 'dana@westvale.example' })
  check('created with contact + email (201)', c4.status === 201 && c4.body?.status === 'created', JSON.stringify(c4.body))
  const row = await one(`select contact, email from public.clients where code=$1`, [c4.body?.code])
  check('contact + email persisted on the new client', row.contact === 'Dana Lee' && row.email === 'dana@westvale.example', JSON.stringify(row))

  console.log('\n── ambiguous (several match → pick, nothing created) ──')
  const DUP = `${PREFIX} Dup ${nonce}`
  await svc(`insert into public.clients (code, name, registered) values ('ZZITA',$1,current_date), ('ZZITB',$2,current_date)`,
    [DUP, `${DUP}.`]) // trailing dot drops → identical key
  const c5 = await call(admin, { company: DUP })
  check('several matches → 200 ambiguous with the codes', c5.status === 200 && c5.body?.status === 'ambiguous'
    && Array.isArray(c5.body?.codes) && c5.body.codes.includes('ZZITA') && c5.body.codes.includes('ZZITB'), JSON.stringify(c5.body))
  check('ambiguous created no new client', (await one(`select count(*)::int n from public.clients where name like $1 and name ~* 'dup'`, [`${PREFIX}%`])).n === 2)

  console.log('\n── concurrency (no client-code race: created exactly once) ──')
  const RACE = `${PREFIX} Race ${nonce}`
  const [p1, p2] = await Promise.all([call(admin, { company: RACE }), call(admin, { company: RACE })])
  const statuses = [p1.body?.status, p2.body?.status].sort()
  check('two parallel creates → exactly one created, one matched', statuses[0] === 'created' && statuses[1] === 'matched', JSON.stringify(statuses))
  check('both resolve to the same single code', p1.body?.code && p1.body.code === p2.body.code, `${p1.body?.code}/${p2.body?.code}`)
  check('exactly one client row for the raced name', (await one(`select count(*)::int n from public.clients where name like $1 and name ~* 'race'`, [`${PREFIX}%`])).n === 1)

  await wipe()
} catch (err) {
  console.error('\n*** integration error:', err?.stack || err?.message || err)
  failures++
} finally {
  await closePool()
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
