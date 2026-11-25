// GCP Firebase sign-in (gcp.js), with the Firebase SDK and fetch mocked and the
// module loaded under a stubbed VITE_FIREBASE_* config. Pins: email/password
// sign-in, session restore on reload, the portal profile coming only from the
// API (GET /api/me), the ID token on API calls (with one forced refresh on a
// 401), sign-out clearing the session, and every failure reporting failure --
// plus the provider seam's Supabase behaviour.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const h = vi.hoisted(() => ({ auth: null, user: null, signInError: null, listener: null }))
vi.mock('@firebase/app', () => ({ initializeApp: vi.fn((cfg, name) => ({ cfg, name })), getApps: () => [] }))
vi.mock('@firebase/auth', () => ({
  getAuth: vi.fn(() => h.auth),
  connectAuthEmulator: vi.fn(),
  setPersistence: vi.fn(async () => {}),
  browserLocalPersistence: 'LOCAL',
  signInWithEmailAndPassword: vi.fn(async (auth) => {
    if (h.signInError) throw h.signInError
    auth.currentUser = h.user
    return { user: h.user }
  }),
  signOut: vi.fn(async (auth) => { auth.currentUser = null }),
  onAuthStateChanged: vi.fn((_auth, cb) => { h.listener = cb; return () => { h.listener = null } }),
}))

const FIREBASE_ENV = { VITE_FIREBASE_API_KEY: 'test-web-key', VITE_FIREBASE_AUTH_DOMAIN: 'test.firebaseapp.com', VITE_FIREBASE_PROJECT_ID: 'test-project' }
const ME = { id: '0a1b2c3d-0000-4000-8000-0000000000a1', email: 'admin@example.test', role: 'admin', name: 'Ada Admin', avatar: 'AA',
  superAdmin: true, clientCode: null, canConfirmPayments: false, permissions: [], firebaseUid: 'must-not-leak' }

let fetches, routes
function route(path, ...responses) { routes[path] = responses }
async function load(env = FIREBASE_ENV) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('./gcp')
}
const sdk = () => import('@firebase/auth')
const fbUser = (token = 'id-token-1') => ({ uid: 'fb-uid', getIdToken: vi.fn(async (force) => (force ? 'id-token-fresh' : token)) })

beforeEach(async () => {
  fetches = []
  routes = {}
  h.user = fbUser()
  h.auth = { currentUser: null, authStateReady: vi.fn(async () => {}) }
  h.signInError = null
  h.listener = null
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    fetches.push({ url, ...init })
    const queue = routes[url.replace(/\?.*$/, '')] || []
    const next = queue.length > 1 ? queue.shift() : queue[0]
    if (!next) throw new Error(`unexpected fetch ${url}`)
    if (next === 'network') throw new TypeError('Failed to fetch')
    return { ok: next.status >= 200 && next.status < 300, status: next.status,
      json: async () => next.body, text: async () => JSON.stringify(next.body ?? null) }
  }))
  for (const fn of Object.values(await sdk())) if (typeof fn?.mockClear === 'function') fn.mockClear()
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('configuration', () => {
  it('reads the existing VITE_FIREBASE_* config; missing keys and unsafe emulator hosts are refused', async () => {
    const { resolveFirebaseConfig } = await load()
    expect(resolveFirebaseConfig(FIREBASE_ENV)).toMatchObject({ ok: true, firebase: { apiKey: 'test-web-key', projectId: 'test-project' } })
    expect(resolveFirebaseConfig({}).problems).toEqual(['VITE_FIREBASE_API_KEY is not set', 'VITE_FIREBASE_AUTH_DOMAIN is not set', 'VITE_FIREBASE_PROJECT_ID is not set'])
    expect(resolveFirebaseConfig({ ...FIREBASE_ENV, VITE_FIREBASE_AUTH_EMULATOR_HOST: 'evil.example.com:9099' }).ok).toBe(false)
    expect(resolveFirebaseConfig({ ...FIREBASE_ENV, VITE_FIREBASE_AUTH_EMULATOR_HOST: 'localhost:9099', PROD: true }).ok).toBe(false)
  })
  it('unconfigured: sign-in says so, no session, no token -- and Firebase is never loaded', async () => {
    const gcp = await load({})
    const { initializeApp } = await import('@firebase/app')
    initializeApp.mockClear()
    expect(gcp.isAuthConfigured).toBe(false)
    expect(await gcp.signIn('a@example.test', 'pw')).toMatchObject({ success: false, code: 'not_configured', error: expect.stringMatching(/not configured/) })
    expect(await gcp.getCurrentUser()).toBeNull()
    expect(await gcp.getAccessToken()).toBeNull()
    expect(initializeApp).not.toHaveBeenCalled()
  })
})

describe('sign-in', () => {
  it('signs in with email/password, persists the session locally, and takes the profile from GET /api/me only', async () => {
    const gcp = await load()
    route('/api/me', { status: 200, body: ME })
    const r = await gcp.signIn('  admin@example.test ', 'correct horse')
    const s = await sdk()
    expect(s.signInWithEmailAndPassword).toHaveBeenCalledWith(h.auth, 'admin@example.test', 'correct horse')
    expect(s.setPersistence).toHaveBeenCalledWith(h.auth, 'LOCAL')
    expect(fetches[0]).toMatchObject({ url: '/api/me', method: 'GET', credentials: 'omit', cache: 'no-store' })
    expect(fetches[0].headers.authorization).toBe('Bearer id-token-1')
    expect(r).toEqual({ success: true, role: 'admin', user: { id: ME.id, email: ME.email, role: 'admin', name: 'Ada Admin', avatar: 'AA',
      superAdmin: true, clientCode: null, canConfirmPayments: false, permissions: [] } })
  })
  it('wrong password / disabled account / throttling are refusals, with no API call', async () => {
    const gcp = await load()
    for (const [code, mapped] of [['auth/invalid-credential', 'invalid_credentials'], ['auth/user-disabled', 'account_disabled'], ['auth/too-many-requests', 'rate_limited']]) {
      h.signInError = Object.assign(new Error(code), { code })
      expect(await gcp.signIn('a@example.test', 'x')).toMatchObject({ success: false, code: mapped })
    }
    expect(fetches).toEqual([])
  })
  it('a profile the API refuses (403) is NOT a success: the Firebase session is ended', async () => {
    const gcp = await load()
    route('/api/me', { status: 403, body: { error: 'no profile for this account' } })
    expect(await gcp.signIn('a@example.test', 'pw')).toMatchObject({ success: false, code: 'account_inactive' })
    expect((await sdk()).signOut).toHaveBeenCalled()
    expect(h.auth.currentUser).toBeNull()
  })
  it('an expired token is refreshed once; a second 401 is an invalid session, signed out', async () => {
    const gcp = await load()
    route('/api/me', { status: 401, body: null }, { status: 401, body: null })
    expect(await gcp.signIn('a@example.test', 'pw')).toMatchObject({ success: false, code: 'session_invalid' })
    expect(h.user.getIdToken.mock.calls.map((c) => c[0])).toEqual([false, true])
    expect(fetches.map((f) => f.headers.authorization)).toEqual(['Bearer id-token-1', 'Bearer id-token-fresh'])
    expect(h.auth.currentUser).toBeNull()
  })
  it('the API being unreachable is reported as unavailable, never as signed in', async () => {
    const gcp = await load()
    route('/api/me', 'network')
    expect(await gcp.signIn('a@example.test', 'pw')).toMatchObject({ success: false, code: 'api_unavailable' })
    expect(h.auth.currentUser).toBeNull()
  })
})

describe('session restore, sign-out, auth changes', () => {
  it('restores the persisted session on reload (after Firebase has loaded it)', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    route('/api/me', { status: 200, body: ME })
    expect(await gcp.getCurrentUser()).toMatchObject({ id: ME.id, role: 'admin' })
    expect(h.auth.authStateReady).toHaveBeenCalled()
  })
  it('no session -> null with no API call; a refused profile clears the stale session', async () => {
    const gcp = await load()
    expect(await gcp.getCurrentUser()).toBeNull()
    expect(fetches).toEqual([])
    h.auth.currentUser = h.user
    route('/api/me', { status: 403, body: { error: 'inactive' } })
    expect(await gcp.getCurrentUser()).toBeNull()
    expect(h.auth.currentUser).toBeNull()
  })
  it('an API outage while restoring throws (no false "signed out") and keeps the Firebase session', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    route('/api/me', { status: 503, body: null })
    await expect(gcp.getCurrentUser()).rejects.toThrow(/session could not be restored/)
    expect(h.auth.currentUser).toBe(h.user)
  })
  it('sign-out ends the Firebase session, after which no token is sent', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    await gcp.signOut()
    expect((await sdk()).signOut).toHaveBeenCalledWith(h.auth)
    expect(await gcp.getAccessToken()).toBeNull()
    route('/api/admin/users', { status: 401, body: { error: 'unauthenticated' } })
    await expect(gcp.adminUsersApi.list()).rejects.toMatchObject({ status: 401 })
    expect(fetches.at(-1).headers.Authorization).toBeUndefined()
  })
  it('onAuthChange reports the API profile, or null when signed out or refused', async () => {
    const gcp = await load()
    const seen = []
    const stop = gcp.onAuthChange((u) => seen.push(u && u.role))
    await vi.waitFor(() => expect(h.listener).toBeTypeOf('function'))
    route('/api/me', { status: 200, body: ME })
    await h.listener(h.user)
    await h.listener(null)
    route('/api/me', { status: 403, body: null })
    await h.listener(h.user)
    expect(seen).toEqual(['admin', null, null])
    stop()
    expect(h.listener).toBeNull()
  })
})

describe('the ID token on Admin Users API calls', () => {
  it('sends the signed-in user\'s Firebase ID token', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    route('/api/admin/users', { status: 200, body: { users: [] } })
    await gcp.adminUsersApi.list()
    expect(fetches[0].headers.Authorization).toBe('Bearer id-token-1')
  })
  it('an expired token (401) is retried once with a forced refresh', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    route('/api/admin/users', { status: 401, body: { error: 'unauthenticated' } }, { status: 200, body: { users: [] } })
    expect(await gcp.adminUsersApi.list()).toEqual([])
    expect(fetches.map((f) => f.headers.Authorization)).toEqual(['Bearer id-token-1', 'Bearer id-token-fresh'])
  })
  it('a second 401, and a 403, are reported with the API\'s message -- never success', async () => {
    const gcp = await load()
    h.auth.currentUser = h.user
    route('/api/admin/users', { status: 401, body: { error: 'unauthenticated' } })
    await expect(gcp.adminUsersApi.list()).rejects.toMatchObject({ status: 401, message: 'unauthenticated' })
    route('/api/admin/users', { status: 403, body: { error: 'administrators only' } })
    await expect(gcp.adminUsersApi.list()).rejects.toMatchObject({ status: 403, message: 'administrators only' })
  })
})

describe('provider seam', () => {
  it('Supabase build: sign-in mode follows isSupabaseConfigured exactly as before; no Admin Users REST client', async () => {
    vi.resetModules()
    const backend = await import('../backend')
    expect(backend.hasRealAuth).toBe(backend.isSupabaseConfigured)
    expect(backend.adminUsersApi).toBeUndefined()
  })
  it('GCP build: always real (Firebase) sign-in, isSupabaseConfigured still false', async () => {
    vi.resetModules()
    vi.stubEnv('VITE_BACKEND', 'gcp')
    const backend = await import('../backend')
    expect(backend.hasRealAuth).toBe(true)
    expect(backend.isSupabaseConfigured).toBe(false)
    expect(backend.adminUsersApi).toBeTypeOf('object')
  })
})
