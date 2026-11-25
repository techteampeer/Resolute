// The Admin Users screen's GCP client (adminUsersApi in gcp.js) against a
// mocked fetch: which endpoint each action uses, what it sends, how records map
// to the screen's user shape, the Firebase ID token, the API's own errors, and
// that deletion / password reset / invitations do not exist on GCP.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { adminUsersApi, setIdTokenSource, toAdminUserRow } from './gcp'

const ID = '0a1b2c3d-0000-4000-8000-0000000000b2'
const V = '2026-11-25T10:00:00.123456Z'
let calls
const reply = (status, body) => {
  globalThis.fetch.mockImplementationOnce(async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }
  })
}

beforeEach(() => {
  calls = []
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('unexpected fetch') }))
  setIdTokenSource(() => 'firebase-id-token')
})
afterEach(() => { vi.unstubAllGlobals(); setIdTokenSource(null) })

describe('authentication', () => {
  it('sends the current Firebase ID token as a Bearer token, uncached', async () => {
    reply(200, { users: [] })
    await adminUsersApi.list()
    expect(calls[0]).toMatchObject({ url: '/api/admin/users', method: 'GET', cache: 'no-store' })
    expect(calls[0].headers.Authorization).toBe('Bearer firebase-id-token')
  })
  it('with no signed-in user there is no token: no Authorization header, and the API 401 surfaces', async () => {
    setIdTokenSource(() => null)
    reply(401, { error: 'unauthenticated' })
    await expect(adminUsersApi.list()).rejects.toMatchObject({ status: 401, message: 'unauthenticated' })
    expect(calls[0].headers.Authorization).toBeUndefined()
  })
  it('a token source that fails sends nothing', async () => {
    setIdTokenSource(async () => { throw new Error('token refresh failed') })
    await expect(adminUsersApi.list()).rejects.toThrow('token refresh failed')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
})

describe('list -> the screen\'s user shape', () => {
  it('maps status, active, joined and keeps updatedAt', async () => {
    reply(200, { users: [
      { id: ID, email: 'p@example.test', name: 'P', role: 'user', clientCode: null, superAdmin: false, canConfirmPayments: false,
        permissions: [{ capability: 'orders.work', effect: 'revoke' }], status: 'pending', active: false, created: '2026-11-20T09:00:00Z', updatedAt: V, signIn: 'disabled' },
      { id: 'b', email: 'c@example.test', name: '', role: 'client', clientCode: 'CL01', status: 'active', updatedAt: V },
      { id: 'c', email: 'i@example.test', role: 'admin', superAdmin: true, canConfirmPayments: true, status: 'inactive', updatedAt: V },
    ] })
    const [p, c, i] = await adminUsersApi.list()
    expect(p).toEqual({ id: ID, name: 'P', email: 'p@example.test', role: 'user', clientCode: null, superAdmin: false, canConfirmPayments: false,
      permissions: [{ capability: 'orders.work', effect: 'revoke' }], status: 'pending', active: false, joined: '2026-11-20T09:00:00Z', updatedAt: V, signIn: 'disabled' })
    expect([c.active, c.clientCode, c.permissions]).toEqual([true, 'CL01', []])
    expect([i.active, i.status, i.superAdmin]).toEqual([false, 'inactive', true])
  })
  it('a malformed body is an empty list, never a crash', async () => {
    reply(200, {})
    expect(await adminUsersApi.list()).toEqual([])
    expect(toAdminUserRow({ id: 'x' })).toMatchObject({ active: false, status: null, permissions: [] })
  })
})

describe('create', () => {
  it('POSTs only the account fields the API accepts and returns the pending account (no invitation)', async () => {
    reply(201, { id: ID, status: 'pending' })
    const out = await adminUsersApi.create({ id: undefined, email: 'n@example.test', name: 'N', role: 'user', clientCode: '',
      permissions: [], superAdmin: undefined, inviteLink: 'x' })
    expect(calls[0]).toMatchObject({ url: '/api/admin/users', method: 'POST' })
    expect(calls[0].body).toEqual({ email: 'n@example.test', name: 'N', role: 'user', clientCode: null, permissions: [] })
    expect(out).toEqual({ id: ID, status: 'pending' })
  })
  it('elevated flags ride only when the form set them', async () => {
    reply(201, { id: ID, status: 'pending' })
    await adminUsersApi.create({ email: 'a@example.test', name: 'A', role: 'admin', clientCode: '', permissions: [], superAdmin: true, canConfirmPayments: false })
    expect(calls[0].body).toMatchObject({ superAdmin: true, canConfirmPayments: false })
  })
})

describe('edit (optimistic locking)', () => {
  it('PATCHes /:id with the version that was read; email is never sent', async () => {
    reply(200, { id: ID, role: 'client', clientCode: 'CL01', status: 'active', updatedAt: '2026-11-25T11:00:00Z' })
    const row = await adminUsersApi.update(ID, { name: 'X', email: 'x@example.test', role: 'client', clientCode: 'CL01', permissions: [] }, V)
    expect(calls[0]).toMatchObject({ url: `/api/admin/users/${ID}`, method: 'PATCH' })
    expect(calls[0].body).toEqual({ updatedAt: V, name: 'X', role: 'client', clientCode: 'CL01', permissions: [] })
    expect(row.updatedAt).toBe('2026-11-25T11:00:00Z')
  })
  it('without the version read, nothing is sent', async () => {
    await expect(adminUsersApi.update(ID, { name: 'X', role: 'user' }, undefined)).rejects.toMatchObject({ status: 409 })
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('a stale version is the API\'s 409, with its message', async () => {
    reply(409, { error: 'this account changed since you opened it — reload and try again' })
    await expect(adminUsersApi.update(ID, { role: 'user' }, V))
      .rejects.toMatchObject({ status: 409, message: 'this account changed since you opened it — reload and try again' })
  })
})

describe('Activate / Deactivate toggle', () => {
  it('pending -> activate, inactive -> reactivate, active -> deactivate', async () => {
    reply(200, { id: ID, status: 'active' })
    await adminUsersApi.setActive({ id: ID, status: 'pending', updatedAt: V })
    reply(200, { id: ID, status: 'active', signIn: 'enabled' })
    await adminUsersApi.setActive({ id: ID, status: 'inactive', updatedAt: V })
    reply(200, { id: ID, status: 'inactive', signIn: 'disabled' })
    await adminUsersApi.setActive({ id: ID, status: 'active', updatedAt: V })
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', `/api/admin/users/${ID}/activate`, undefined],
      ['POST', `/api/admin/users/${ID}/reactivate`, { updatedAt: V }],
      ['POST', `/api/admin/users/${ID}/deactivate`, { updatedAt: V }],
    ])
  })
  it('an unknown status changes nothing', async () => {
    await expect(adminUsersApi.setActive({ id: ID, status: null })).rejects.toThrow(/Cannot change/)
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })
  it('a partial deactivation (502) surfaces the API\'s explanation', async () => {
    reply(502, { error: 'the account is deactivated and can no longer use the portal, but its sign-in account could not be disabled' })
    await expect(adminUsersApi.setActive({ id: ID, status: 'active', updatedAt: V }))
      .rejects.toMatchObject({ status: 502, message: expect.stringMatching(/deactivated/) })
  })
})

describe('errors and unsupported actions', () => {
  it('403 and other statuses keep the API\'s message; a non-JSON body gets a generic one with the status', async () => {
    reply(403, { error: 'administrators only' })
    await expect(adminUsersApi.list()).rejects.toMatchObject({ status: 403, message: 'administrators only' })
    reply(500, '<html>oops</html>')
    await expect(adminUsersApi.list()).rejects.toMatchObject({ status: 500, message: 'request failed (500)' })
  })
  it('there is no delete, password reset or invitation on GCP', () => {
    expect(adminUsersApi.canRemove).toBe(false)
    expect(adminUsersApi.canResetPassword).toBe(false)
    expect(Object.keys(adminUsersApi).sort()).toEqual(['canRemove', 'canResetPassword', 'create', 'list', 'setActive', 'update'])
  })
})

describe('provider seam', () => {
  it('the default (Supabase) build has no adminUsersApi and is unchanged', async () => {
    const backend = await import('../backend')
    expect(backend.adminUsersApi).toBeUndefined()
    expect(backend.isSupabaseConfigured).toBe(false) // no Supabase env in tests
  })
})
