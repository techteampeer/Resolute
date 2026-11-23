// B4 integration (profile-edit slice): the GCP admin-users API end-to-end against
// a REAL Postgres — supertest → the actual adminUsersRouter → withServiceRole →
// the profiles_guard_privilege_columns trigger. Authorization is the route's code
// gate (service-role writes bypass RLS), so we exercise exactly that path.
//
// Only the profile-edit path is wired; create/remove/setActive/resetPassword and
// listing are env-gated (Firebase auth backend) → asserted to fail safe with 501.
//
// Edits a demo `user` account (never operator@/typer@, used by the charges suite)
// and restores its original columns in `finally`.
//
//   cd services/api && npm install
//   DB_HOST=127.0.0.1 DB_PORT=54322 DB_USER=postgres DB_PASSWORD=postgres DB_NAME=postgres \
//     node __tests__/adminUsers.integration.mjs

process.env.DB_HOST ??= '127.0.0.1'
process.env.DB_PORT ??= '54322'
process.env.DB_USER ??= 'postgres'
process.env.DB_PASSWORD ??= 'postgres'
process.env.DB_NAME ??= 'postgres'

const express = (await import('express')).default
const request = (await import('supertest')).default
const { adminUsersRouter } = await import('../src/routes/adminUsers.js')
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
app.use('/api/admin/users', adminUsersRouter)
app.use((err, _req, res, _next) => { console.error('[it]', err?.message || err); res.status(500).json({ error: 'internal' }) })

const post = (user, body) => request(app).post('/api/admin/users').set('x-test-user', JSON.stringify(user)).send(body || {})
const get = (user) => request(app).get('/api/admin/users').set('x-test-user', JSON.stringify(user))

let target = null, snapshot = null
try {
  const prof = (email) => one(`select id, role, email, super_admin from public.profiles where email = $1`, [email])
  const adminP = await prof('admin@resolute.com')          // a PLAIN admin (super_admin false)
  const superP = await prof('superadmin@resolute.com')     // a SUPER admin
  const userP = await prof('operator@resolute.com')
  const clientP = await prof('client@resolute.com')
  if (!adminP.id || !superP.id || !userP.id || !clientP.id) { console.log('*** FAIL  missing demo profile'); process.exit(1) }
  const admin = { id: adminP.id, role: 'admin', email: adminP.email }
  const superAdmin = { id: superP.id, role: 'admin', email: superP.email }
  const user = { id: userP.id, role: 'user', email: userP.email }
  const client = { id: clientP.id, role: 'client', email: clientP.email }
  check('sanity: admin@ is a plain admin, superadmin@ is super',
    adminP.super_admin === false && superP.super_admin === true, `${adminP.super_admin}/${superP.super_admin}`)

  // A safe edit target: a production `user` that the other suites don't touch.
  target = await one(`select id, name, role, client_code, super_admin, can_confirm_payments, permissions
                        from public.profiles
                       where role = 'user' and email not in ('operator@resolute.com','typer@resolute.com')
                       order by email limit 1`)
  if (!target.id) { console.log('*** FAIL  no spare demo user to edit'); process.exit(1) }
  snapshot = { ...target }
  const TID = target.id
  const someClient = (await one(`select code from public.clients order by code limit 1`)).code
  const stateOf = () => one(`select name, role, client_code, super_admin, can_confirm_payments from public.profiles where id=$1`, [TID])

  console.log('── authorization (code gate is the only guard) ──')
  check('client cannot manage users (403)', (await post(client, { action: 'update', id: TID, name: 'x' })).status === 403)
  check('production user cannot manage users (403)', (await post(user, { action: 'update', id: TID, name: 'x' })).status === 403)

  console.log('\n── profile edit (plain admin) ──')
  check('plain admin renames a user (200)', (await post(admin, { action: 'update', id: TID, name: 'Zz Edited' })).status === 200)
  check('name persisted', (await stateOf()).name === 'Zz Edited')

  console.log('\n── badClientLink (the "client cannot place orders" FK guard) ──')
  check('role=client + unknown code → 400', (await post(admin, { action: 'update', id: TID, role: 'client', clientCode: 'NOPE-XYZ' })).status === 400)
  check('role=client + blank code → 400', (await post(admin, { action: 'update', id: TID, role: 'client', clientCode: '   ' })).status === 400)
  check('neither bad attempt changed the row (still a user)', (await stateOf()).role === 'user')
  const c6 = await post(admin, { action: 'update', id: TID, role: 'client', clientCode: someClient })
  check('role=client + valid code → 200', c6.status === 200, `HTTP ${c6.status}`)
  const s6 = await stateOf()
  check('row is now a client linked to that code', s6.role === 'client' && s6.client_code === someClient, JSON.stringify(s6))

  console.log('\n── elevated grants need a super admin ──')
  check('plain admin granting super_admin → 403', (await post(admin, { action: 'update', id: TID, role: 'admin', superAdmin: true })).status === 403)
  check('403 attempt did not elevate the row', (await stateOf()).super_admin === false)
  const c8 = await post(superAdmin, { action: 'update', id: TID, role: 'admin', superAdmin: true, canConfirmPayments: true })
  check('super admin grants super_admin + billing → 200', c8.status === 200, `HTTP ${c8.status}`)
  const s8 = await stateOf()
  check('row is now an admin with super_admin + billing', s8.role === 'admin' && s8.super_admin === true && s8.can_confirm_payments === true, JSON.stringify(s8))

  console.log('\n── demotion clears elevated (non-elevated edit, plain admin allowed) ──')
  const c9 = await post(admin, { action: 'update', id: TID, role: 'user' })
  check('plain admin demotes admin→user (200)', c9.status === 200, `HTTP ${c9.status}`)
  const s9 = await stateOf()
  check('super_admin + billing cleared on demotion', s9.role === 'user' && s9.super_admin === false && s9.can_confirm_payments === false, JSON.stringify(s9))

  console.log('\n── validation + fail-safe for env-gated actions ──')
  check('update without id → 400', (await post(admin, { action: 'update', name: 'x' })).status === 400)
  check('update unknown id → 400 no such user', (await post(admin, { action: 'update', id: '00000000-0000-0000-0000-000000000000', name: 'x' })).status === 400)
  check('unknown action → 400', (await post(admin, { action: 'bogus' })).status === 400)
  check('create → 501 not wired (Firebase auth backend)', (await post(admin, { action: 'create', email: 'x@y.z', role: 'client', clientCode: someClient })).status === 501)
  check('remove → 501 not wired', (await post(admin, { action: 'remove', id: TID })).status === 501)
  check('setActive → 501 not wired', (await post(admin, { action: 'setActive', id: TID, active: false })).status === 501)
  check('resetPassword → 501 not wired', (await post(admin, { action: 'resetPassword', email: 'x@y.z' })).status === 501)
  check('GET listing → 501 not wired', (await get(admin)).status === 501)
} catch (err) {
  console.error('\n*** integration error:', err?.stack || err?.message || err)
  failures++
} finally {
  // Restore the edited demo user exactly (service role → the privilege trigger allows it).
  if (target?.id && snapshot) {
    try {
      await svc(`update public.profiles set name=$1, role=$2::public.user_role, client_code=$3,
                   super_admin=$4, can_confirm_payments=$5, permissions=$6::jsonb where id=$7`,
        [snapshot.name, snapshot.role, snapshot.client_code, snapshot.super_admin,
         snapshot.can_confirm_payments, JSON.stringify(snapshot.permissions ?? []), target.id])
    } catch (e) { console.error('*** restore failed:', e?.message || e); failures++ }
  }
  await closePool()
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed')
process.exit(failures ? 1 : 0)
