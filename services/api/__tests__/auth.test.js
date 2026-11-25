// Firebase identity resolution (services/api/src/auth.js), with Firebase and the
// DB layer mocked. Pins production's verified contract (resolute_live):
//   auth.resolve_app_user(text) RETURNS TABLE(id uuid, role text, status text),
//   SECURITY DEFINER, called directly by the app login -- never service_role --
// then the profile is read under RLS as that user. Everything not provably an
// active, single identity fails closed; revoked tokens are refused.
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => {
  // config.js fails fast without these; nothing connects (db.js is mocked).
  process.env.DB_USER ??= 'test'
  process.env.DB_PASSWORD ??= 'test'
  process.env.DB_NAME ??= 'test'
  return { verifyIdToken: vi.fn(), resolverRows: [], resolverError: null, profile: null, profileError: null, lookups: [], claimed: [] }
})

vi.mock('firebase-admin/app', () => ({ initializeApp: vi.fn(), getApps: () => [] }))
vi.mock('firebase-admin/auth', () => ({ getAuth: () => ({ verifyIdToken: h.verifyIdToken }) }))
vi.mock('../src/db.js', () => ({
  withIdentityLookup: vi.fn(async (fn) => fn({
    query: async (sql, params) => {
      h.lookups.push({ sql, params })
      if (h.resolverError) throw h.resolverError
      return { rows: h.resolverRows }
    },
  })),
  withUserClaims: vi.fn(async (user, fn) => {
    h.claimed.push(user)
    return fn({
      query: async () => {
        if (h.profileError) throw h.profileError
        return { rows: h.profile ? [h.profile] : [] }
      },
    })
  }),
  withServiceRole: vi.fn(async () => { throw new Error('service_role must not be used for sign-in') }),
}))

const { verifyBearer, resolveAppUser, RESOLVE_APP_USER_SQL } = await import('../src/auth.js')
const db = await import('../src/db.js')

const ID = '0a1b2c3d-0000-4000-8000-00000000abcd'
const resolved = { id: ID, role: 'client', status: 'active' }
const active = { id: ID, role: 'client', email: 'c@example.test', status: 'active' }

beforeEach(() => {
  h.verifyIdToken.mockReset()
  Object.assign(h, { resolverRows: [], resolverError: null, profile: null, profileError: null, lookups: [], claimed: [] })
})

describe('verifyBearer', () => {
  it('verifies with checkRevoked = true', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'fbuid' })
    expect(await verifyBearer('Bearer tok')).toEqual({ uid: 'fbuid' })
    expect(h.verifyIdToken).toHaveBeenCalledWith('tok', true)
  })
  it('a revoked, disabled or invalid token is unauthenticated', async () => {
    for (const code of ['auth/id-token-revoked', 'auth/user-disabled', 'auth/argument-error']) {
      h.verifyIdToken.mockRejectedValueOnce(Object.assign(new Error(code), { code }))
      expect(await verifyBearer('Bearer tok')).toBeNull()
    }
  })
  it('no Bearer header never reaches Firebase', async () => {
    expect(await verifyBearer(undefined)).toBeNull()
    expect(await verifyBearer('Basic abc')).toBeNull()
    expect(h.verifyIdToken).not.toHaveBeenCalled()
  })
})

describe('resolveAppUser (production contract)', () => {
  it('runs exactly the verified query with the VERIFIED uid, then reads the profile under RLS as that user', async () => {
    h.resolverRows = [resolved]
    h.profile = active
    expect(await resolveAppUser({ uid: 'fbuid', email: 'c@example.test' }))
      .toEqual({ id: ID, role: 'client', email: 'c@example.test' })
    expect(RESOLVE_APP_USER_SQL).toBe('SELECT id, role, status FROM auth.resolve_app_user($1)')
    expect(h.lookups).toEqual([{ sql: RESOLVE_APP_USER_SQL, params: ['fbuid'] }])
    expect(h.claimed).toEqual([{ id: ID, email: 'c@example.test' }])
    expect(db.withServiceRole).not.toHaveBeenCalled()
  })
  it('a missing user (no row) is refused before any claims transaction', async () => {
    expect(await resolveAppUser({ uid: 'fbuid' })).toBeNull()
    expect(h.claimed).toEqual([])
  })
  it('an inactive user per the resolver is refused before any claims transaction', async () => {
    for (const status of ['disabled', 'pending', null, undefined, 'ACTIVE']) {
      h.resolverRows = [{ ...resolved, status }]
      expect(await resolveAppUser({ uid: 'fbuid' })).toBeNull()
    }
    expect(h.claimed).toEqual([])
  })
  it('a malformed id is refused', async () => {
    for (const id of [null, 'fbuid-not-a-uuid', 42]) {
      h.resolverRows = [{ ...resolved, id }]
      expect(await resolveAppUser({ uid: 'fbuid' })).toBeNull()
    }
    expect(h.claimed).toEqual([])
  })
  it('the RLS read must find the same, active profile', async () => {
    h.resolverRows = [resolved]
    for (const profile of [null, { ...active, status: 'disabled' }, { ...active, id: '11111111-1111-4111-8111-111111111111' }]) {
      h.profile = profile
      expect(await resolveAppUser({ uid: 'fbuid' })).toBeNull()
    }
  })
  it('an ambiguous resolver result is an error, never a pick', async () => {
    h.resolverRows = [resolved, { ...resolved, id: '11111111-1111-4111-8111-111111111111' }]
    await expect(resolveAppUser({ uid: 'fbuid' })).rejects.toThrow(/more than one row/)
  })
  it('database errors propagate (fail closed): resolver and RLS read', async () => {
    h.resolverError = Object.assign(new Error('permission denied for function resolve_app_user'), { code: '42501' })
    await expect(resolveAppUser({ uid: 'fbuid' })).rejects.toThrow(/permission denied/)
    expect(h.claimed).toEqual([])
    h.resolverError = null
    h.resolverRows = [resolved]
    h.profileError = new Error('connection terminated')
    await expect(resolveAppUser({ uid: 'fbuid' })).rejects.toThrow(/connection terminated/)
  })
  it('no verified uid never touches the database', async () => {
    expect(await resolveAppUser(null)).toBeNull()
    expect(await resolveAppUser({})).toBeNull()
    expect(await resolveAppUser({ uid: 123 })).toBeNull()
    expect(h.lookups).toEqual([])
  })
})
