// /api/admin/users route adapter (services/api/src/routes/adminUsers.js). express
// is replaced by a recording Router stub (it is not installed for the root test
// run), and provisioning.js by spies: this pins the six REST routes, their
// success statuses, no-store caching, and the error contract -- an AccountError
// becomes its own status + message, anything else goes to the app error handler.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ routes: [] }))
vi.mock('express', () => ({
  Router: () => {
    const r = {}
    for (const m of ['get', 'post', 'patch', 'put', 'delete']) r[m] = (path, fn) => { h.routes.push({ method: m, path, fn }); return r }
    return r
  },
}))
vi.mock('../src/provisioning.js', () => {
  class AccountError extends Error { constructor(status, message) { super(message); this.status = status } }
  return {
    AccountError,
    listAccounts: vi.fn(), createAccount: vi.fn(), activateAccount: vi.fn(),
    updateAccount: vi.fn(), deactivateAccount: vi.fn(), reactivateAccount: vi.fn(),
  }
})

await import('../src/routes/adminUsers.js')
const p = await import('../src/provisioning.js')

const USER = { id: '0a1b2c3d-0000-4000-8000-0000000000a1', role: 'admin', email: 'a@example.test' }
const ID = '0a1b2c3d-0000-4000-8000-0000000000b2'
const route = (method, path) => h.routes.find((r) => r.method === method && r.path === path)
async function call(method, path, req) {
  const res = { headers: {}, statusCode: null, body: null,
    set(k, v) { this.headers[k] = v; return this }, status(s) { this.statusCode = s; return this }, json(b) { this.body = b; return this } }
  const next = vi.fn()
  await route(method, path).fn({ user: USER, params: {}, body: {}, ...req }, res, next)
  return { res, next }
}

beforeEach(() => { for (const k of Object.keys(p)) if (typeof p[k]?.mockReset === 'function') p[k].mockReset() })

describe('admin-user REST routes', () => {
  it('exposes exactly the six account-management routes (no delete, no reset, no invite)', () => {
    expect(h.routes.map((r) => `${r.method.toUpperCase()} ${r.path}`).sort()).toEqual([
      'GET /', 'PATCH /:id', 'POST /', 'POST /:id/activate', 'POST /:id/deactivate', 'POST /:id/reactivate',
    ])
  })
  it('passes the verified caller, id and body through, with the documented success statuses', async () => {
    p.listAccounts.mockResolvedValue([{ id: ID }])
    p.createAccount.mockResolvedValue({ id: ID, status: 'pending' })
    p.activateAccount.mockResolvedValue({ id: ID, status: 'active' })
    p.updateAccount.mockResolvedValue({ id: ID })
    p.deactivateAccount.mockResolvedValue({ id: ID, status: 'inactive', signIn: 'disabled' })
    p.reactivateAccount.mockResolvedValue({ id: ID, status: 'active', signIn: 'enabled' })
    const body = { updatedAt: '2026-11-25T10:00:00Z' }
    const cases = [
      ['get', '/', {}, 200, { users: [{ id: ID }] }, p.listAccounts, [USER]],
      ['post', '/', { body: { email: 'n@example.test', role: 'user' } }, 201, { id: ID, status: 'pending' }, p.createAccount, [USER, { email: 'n@example.test', role: 'user' }]],
      ['post', '/:id/activate', { params: { id: ID } }, 200, { id: ID, status: 'active' }, p.activateAccount, [USER, ID]],
      ['patch', '/:id', { params: { id: ID }, body }, 200, { id: ID }, p.updateAccount, [USER, ID, body]],
      ['post', '/:id/deactivate', { params: { id: ID }, body }, 200, { id: ID, status: 'inactive', signIn: 'disabled' }, p.deactivateAccount, [USER, ID, body]],
      ['post', '/:id/reactivate', { params: { id: ID }, body }, 200, { id: ID, status: 'active', signIn: 'enabled' }, p.reactivateAccount, [USER, ID, body]],
    ]
    for (const [m, path, req, status, out, fn, args] of cases) {
      const { res, next } = await call(m, path, req)
      expect([res.statusCode, res.body, res.headers['Cache-Control']]).toEqual([status, out, 'no-store'])
      expect(fn).toHaveBeenCalledWith(...args)
      expect(next).not.toHaveBeenCalled()
    }
  })
  it('an AccountError becomes its status + message; anything else goes to the error handler', async () => {
    p.updateAccount.mockRejectedValue(new p.AccountError(409, 'this account changed since you opened it — reload and try again'))
    const a = await call('patch', '/:id', { params: { id: ID }, body: {} })
    expect([a.res.statusCode, a.res.body]).toEqual([409, { error: 'this account changed since you opened it — reload and try again' }])
    const boom = new Error('pg internals')
    p.listAccounts.mockRejectedValue(boom)
    const b = await call('get', '/', {})
    expect(b.next).toHaveBeenCalledWith(boom)
    expect(b.res.statusCode).toBeNull()
  })
})
