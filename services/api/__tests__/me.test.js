// GET /api/me (services/api/src/server.js) through the REAL auth gate, route,
// repository and mapper, in their registration order. express is replaced by a
// small recording app that dispatches like Express (path-prefix `use`, exact
// `get`, error handlers after next(err)) because it is not installed for the
// root test run. Firebase verification, identity resolution and the claims
// transaction are mocked; the SQL and the response are the real code's.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ decoded: null, appUser: null, rows: [], dbError: null, claimed: [], queries: [] }))

vi.mock('express', () => {
  const express = () => {
    const app = { layers: [] }
    app.use = (...a) => { app.layers.push(typeof a[0] === 'string' ? { kind: 'use', path: a[0], fn: a[1] } : { kind: 'use', path: '', fn: a[0] }); return app }
    app.get = (path, fn) => { app.layers.push({ kind: 'get', path, fn }); return app }
    return app
  }
  express.json = () => (_req, _res, next) => next()
  return { default: express }
})
vi.mock('../src/auth.js', () => ({
  verifyBearer: vi.fn(async (authz) => (authz === 'Bearer valid' ? h.decoded : null)),
  resolveAppUser: vi.fn(async () => h.appUser),
}))
vi.mock('../src/db.js', () => ({
  withUserClaims: vi.fn(async (user, fn) => {
    h.claimed.push(user)
    if (h.dbError) throw h.dbError
    return fn({ query: async (sql, params) => { h.queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return { rows: h.rows } } })
  }),
  withServiceRole: vi.fn(() => { throw new Error('service_role must not be used') }),
}))
vi.mock('../src/routes/orders.js', () => ({ ordersRouter: (_req, _res, next) => next() }))
vi.mock('../src/routes/charges.js', () => ({ chargesRouter: (_req, _res, next) => next() }))
vi.mock('../src/routes/clients.js', () => ({ clientsRouter: (_req, _res, next) => next() }))
vi.mock('../src/routes/adminUsers.js', () => ({ adminUsersRouter: (_req, _res, next) => next() }))
vi.mock('../src/routes/documents.js', () => ({ documentsRouter: (_req, _res, next) => next() }))

const { createServer } = await import('../src/server.js')
const db = await import('../src/db.js')

// Dispatch one request through the app's layers like Express.
async function request(app, { method = 'GET', url, headers = {}, body = {} }) {
  const req = { method, url, path: url, headers, body, query: {} }
  const res = { statusCode: 200, headers: {}, body: undefined,
    set(k, v) { this.headers[k] = v; return this }, status(s) { this.statusCode = s; return this }, json(b) { this.body = b; return this } }
  let err = null
  for (const layer of app.layers) {
    if (res.body !== undefined) break
    const matches = layer.kind === 'get' ? method === 'GET' && url === layer.path : url.startsWith(layer.path)
    if (!matches) continue
    const isErrorHandler = layer.fn.length === 4
    if (!!err !== isErrorHandler) continue
    let called = false
    const next = (e) => { called = true; if (e) err = e }
    await (isErrorHandler ? layer.fn(err, req, res, next) : layer.fn(req, res, next))
    if (!called && res.body === undefined) break
  }
  return res
}

const ID = '0a1b2c3d-0000-4000-8000-0000000000a1'
const ROW = { id: ID, name: 'Ada Lovelace', role: 'admin', status: 'active', super_admin: true, client_code: null,
  can_confirm_payments: 1, permissions: [{ capability: 'users.manage', effect: 'grant' }], firebase_uid: 'leak-me-not' }
const ME_SQL = 'SELECT id, name, role, status, super_admin, client_code, can_confirm_payments, permissions FROM public.profiles WHERE id = $1'
let app
beforeEach(() => {
  Object.assign(h, { decoded: { uid: 'fb-uid', email: 'ada@example.test' }, appUser: { id: ID, role: 'admin', email: 'ada@example.test' },
    rows: [ROW], dbError: null, claimed: [], queries: [] })
  app = createServer()
})
const me = (extra = {}) => request(app, { url: '/api/me', headers: { authorization: 'Bearer valid' }, ...extra })

describe('GET /api/me', () => {
  it('is mounted after the auth gate', () => {
    const gate = app.layers.findIndex((l) => l.kind === 'use' && l.path === '/api')
    const route = app.layers.findIndex((l) => l.kind === 'get' && l.path === '/api/me')
    expect(gate).toBeGreaterThan(-1)
    expect(route).toBeGreaterThan(gate)
  })
  it('returns exactly the nine portal-user fields for the caller\'s own active profile, uncached', async () => {
    const res = await me()
    expect(res.statusCode).toBe(200)
    expect(res.headers['Cache-Control']).toBe('no-store')
    expect(res.body).toEqual({ id: ID, email: 'ada@example.test', role: 'admin', name: 'Ada Lovelace', avatar: 'AL',
      superAdmin: true, clientCode: null, canConfirmPayments: true, permissions: [{ capability: 'users.manage', effect: 'grant' }] })
    expect(JSON.stringify(res.body)).not.toMatch(/leak-me-not|status|firebase/)
  })
  it('reads the profile in the caller\'s RLS transaction, by the verified id only', async () => {
    await me({ body: { id: 'someone-else', email: 'attacker@example.test' } })
    expect(h.claimed).toEqual([h.appUser])
    expect(h.queries).toEqual([{ sql: ME_SQL, params: [ID] }])
    expect(db.withServiceRole).not.toHaveBeenCalled()
  })
  it('email is the verified identity\'s, never request input; name falls back to it', async () => {
    h.rows = [{ ...ROW, name: '', client_code: 'CL01', role: 'client', super_admin: null, can_confirm_payments: null, permissions: null }]
    const res = await me({ body: { email: 'attacker@example.test' } })
    expect(res.body).toMatchObject({ email: 'ada@example.test', name: 'ada@example.test', avatar: 'A', role: 'client',
      clientCode: 'CL01', superAdmin: false, canConfirmPayments: false, permissions: [] })
  })
  it('403 for no profile, an inactive one, someone else\'s, or one without a role', async () => {
    for (const rows of [[], [{ ...ROW, status: 'inactive' }], [{ ...ROW, status: 'pending' }],
      [{ ...ROW, id: '11111111-1111-4111-8111-111111111111' }], [{ ...ROW, role: null }]]) {
      h.rows = rows
      const res = await me()
      expect([res.statusCode, res.body, res.headers['Cache-Control']]).toEqual([403, { error: 'no active profile for this account' }, 'no-store'])
    }
  })
  it('401 for a missing or invalid bearer token -- before any database work', async () => {
    for (const headers of [{}, { authorization: 'Bearer forged' }, { authorization: 'Basic abc' }]) {
      const res = await request(app, { url: '/api/me', headers })
      expect([res.statusCode, res.body]).toEqual([401, { error: 'unauthenticated' }])
    }
    expect(h.claimed).toEqual([])
  })
  it('an account the gate cannot resolve to an active profile never reaches the route', async () => {
    h.appUser = null
    const res = await me()
    expect([res.statusCode, res.body]).toEqual([403, { error: 'no profile for this account' }])
    expect(h.claimed).toEqual([])
  })
  it('a database failure goes to the error handler as a generic 500 -- no details leak', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.dbError = new Error('connect ECONNREFUSED 10.20.0.5:5432 password authentication failed for user "resolute_live_app"')
    const res = await me()
    expect([res.statusCode, res.body]).toEqual([500, { error: 'internal error' }])
    expect(JSON.stringify(res.body)).not.toMatch(/resolute_live_app|10\.20|password/)
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})
