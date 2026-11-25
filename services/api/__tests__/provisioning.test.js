// Account management (services/api/src/provisioning.js), unit-tested through its
// injectable dependencies: a fake pg client inside a fake withUserClaims, a fake
// mapping lookup and a fake Firebase Admin Auth. The real repository SQL runs
// against the fake client, so the tests pin which auth.* function each step
// calls and in what order relative to Firebase. Nothing here uses service_role.
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../src/db.js', () => ({
  withUserClaims: vi.fn(() => { throw new Error('use injected deps') }),
  withServiceRole: vi.fn(() => { throw new Error('service_role must never be used') }),
}))
vi.mock('../src/auth.js', () => ({ getFirebaseAuth: vi.fn(), resolveIdentity: vi.fn() }))

const {
  AccountError, toAccountError, accountRequest, provablyOurs, editedAccount, PROVISIONING_CLAIM,
  listAccounts, createAccount, activateAccount, updateAccount, deactivateAccount, reactivateAccount,
} = await import('../src/provisioning.js')
const db = await import('../src/db.js')

const ADMIN = { id: '0a1b2c3d-0000-4000-8000-0000000000a1', role: 'admin', email: 'admin@example.test' }
const TARGET = '0a1b2c3d-0000-4000-8000-0000000000b2'
const VERSION = '2026-11-25T10:00:00.123456Z'
const dbErr = (code, message) => Object.assign(new Error(message), { code })

// ── fakes ───────────────────────────────────────────────────────────────────
let log, state
function fakeClient() {
  return {
    async query(sql, params = []) {
      log.push(['sql', sql.replace(/\s+/g, ' ').trim(), params])
      if (/^(SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return { rows: [] }
      if (/select role, status, super_admin/.test(sql)) return { rows: state.caller ? [state.caller] : [] }
      if (/auth\.provision_app_user/.test(sql)) {
        const preflight = String(params[0]).startsWith('preflight-')
        const err = preflight ? state.preflightError : state.provisionError
        if (err) throw err
        return { rows: [{ id: TARGET }] }
      }
      if (/auth\.activate_app_user/.test(sql)) {
        if (state.activateError) throw state.activateError
        return { rows: [{ firebase_uid: 'fb-uid', email: 'new@example.test', activated: true }] }
      }
      if (/auth\.update_app_user/.test(sql)) { if (state.updateError) throw state.updateError; return { rows: [] } }
      if (/auth\.set_app_user_status/.test(sql)) {
        const err = state.statusErrors.shift()
        if (err) throw err
        return { rows: [{ firebase_uid: 'fb-uid', email: 'new@example.test', status: params[1] ? 'active' : 'inactive', changed: true }] }
      }
      if (/auth\.admin_account_uids/.test(sql)) return { rows: [{ id: TARGET, firebase_uid: 'fb-uid' }] }
      if (/from public\.profiles order by/.test(sql)) return { rows: [state.profile] }
      if (/from public\.profiles where id = \$1/.test(sql)) return { rows: state.profile ? [state.profile] : [] }
      throw new Error(`unexpected SQL: ${sql}`)
    },
  }
}
function fakeAuth() {
  const call = (name, impl) => vi.fn(async (...a) => { log.push(['fb', name, a]); return impl(...a) })
  return {
    createUser: call('createUser', () => { if (state.createError) throw state.createError; return { uid: 'fb-new' } }),
    setCustomUserClaims: call('setCustomUserClaims', () => { if (state.claimsError) throw state.claimsError }),
    getUser: call('getUser', (uid) => { if (state.getUserError) throw state.getUserError; return { uid, ...state.fbUser } }),
    getUserByEmail: call('getUserByEmail', () => state.existing),
    getUsers: call('getUsers', () => { if (state.getUsersError) throw state.getUsersError; return { users: [{ uid: 'fb-uid', disabled: false }] } }),
    updateUser: call('updateUser', () => { if (state.updateUserError) throw state.updateUserError }),
    deleteUser: call('deleteUser', () => {}),
    revokeRefreshTokens: call('revokeRefreshTokens', () => { if (state.revokeError) throw state.revokeError }),
  }
}
let auth
const deps = () => ({
  withUserClaims: vi.fn(async (user, fn) => { log.push(['tx', user.id]); return fn(fakeClient()) }),
  resolveIdentity: vi.fn(async (uid) => { log.push(['resolve', uid]); return state.mapped }),
  getAuth: async () => auth,
})
const fb = (name) => log.filter((e) => e[0] === 'fb' && e[1] === name)
const sqlCalls = (re) => log.filter((e) => e[0] === 'sql' && re.test(e[1]))
const statusOf = (p) => p.then(() => 'ok', (e) => (e instanceof AccountError ? e.status : `raw:${e.message}`))

beforeEach(() => {
  log = []
  state = {
    caller: { role: 'admin', status: 'active', super_admin: false },
    profile: { id: TARGET, name: 'New Person', email: 'new@example.test', role: 'user', client_code: null, super_admin: false,
      can_confirm_payments: false, permissions: [], status: 'active', created_at: '2026-11-01', updated_at: VERSION },
    fbUser: { email: 'new@example.test', disabled: true, customClaims: { [PROVISIONING_CLAIM]: 1 }, metadata: {} },
    mapped: null, statusErrors: [],
  }
  auth = fakeAuth()
})

// ── pure pieces ─────────────────────────────────────────────────────────────
describe('request shapes and refusals', () => {
  it('create accepts only the documented fields and normalises the email', () => {
    expect(accountRequest({ email: ' New@Example.TEST ', role: 'user' }))
      .toEqual({ email: 'new@example.test', name: '', role: 'user', clientCode: null, superAdmin: false, canConfirmPayments: false, permissions: [] })
    for (const body of [{ email: 'a@b.c', role: 'user', firebaseUid: 'x' }, { email: 'a@b.c', role: 'user', status: 'active' },
      { email: 'a@b.c', role: 'user', id: TARGET }, { email: 1, role: 'user' }, { email: 'a@b.c', role: 'user', superAdmin: 'yes' }, [], null]) {
      expect(() => accountRequest(body)).toThrow(AccountError)
    }
  })
  it('an edit keeps a client code only for a client, super admin/billing only for an admin', () => {
    const cur = { name: 'A', role: 'admin', client_code: null, super_admin: true, can_confirm_payments: true, permissions: [] }
    expect(editedAccount(cur, { role: 'user' })).toMatchObject({ role: 'user', clientCode: null, superAdmin: false, canConfirmPayments: false })
    expect(editedAccount(cur, { role: 'client', clientCode: 'CL01' })).toMatchObject({ clientCode: 'CL01', superAdmin: false })
    expect(editedAccount(cur, { name: 'B' })).toMatchObject({ name: 'B', role: 'admin', superAdmin: true, canConfirmPayments: true })
  })
  it('maps only the account functions\' own refusals to client-safe HTTP errors', () => {
    expect(toAccountError(dbErr('42501', 'provision_app_user: administrators only'))).toMatchObject({ status: 403, message: 'administrators only' })
    expect(toAccountError(dbErr('22023', 'some other function: secret detail'))).toMatchObject({ status: 400, message: 'invalid request' })
    expect(toAccountError(dbErr('40001', 'update_app_user: stale'))).toMatchObject({ status: 409, message: expect.stringMatching(/changed since/) })
    expect(toAccountError(dbErr('08006', 'connection lost'))).toBeNull()
  })
  it('a Firebase account is provably ours only while disabled, never used, and marked (or made here)', () => {
    const rec = { disabled: true, metadata: {}, customClaims: { [PROVISIONING_CLAIM]: 1 } }
    expect(provablyOurs(rec)).toBe(true)
    expect(provablyOurs({ ...rec, disabled: false })).toBe(false)
    expect(provablyOurs({ ...rec, metadata: { lastSignInTime: 'x' } })).toBe(false)
    expect(provablyOurs({ ...rec, customClaims: {} })).toBe(false)
    expect(provablyOurs({ ...rec, customClaims: {} }, true)).toBe(true)
  })
})

// ── create ──────────────────────────────────────────────────────────────────
describe('createAccount', () => {
  const body = { email: 'new@example.test', role: 'user', name: 'New Person' }

  it('database dry run, then a DISABLED marked Firebase account, then the pending profile', async () => {
    const d = deps()
    expect(await createAccount(ADMIN, body, d)).toEqual({ id: TARGET, status: 'pending' })
    const order = log.filter((e) => e[0] === 'fb' || (e[0] === 'sql' && /provision_app_user/.test(e[1])))
      .map((e) => (e[0] === 'fb' ? e[1] : String(e[2][0]).startsWith('preflight-') ? 'preflight' : 'provision'))
    expect(order).toEqual(['preflight', 'createUser', 'setCustomUserClaims', 'provision'])
    expect(fb('createUser')[0][2][0]).toEqual({ email: 'new@example.test', disabled: true, emailVerified: false })
    expect(fb('setCustomUserClaims')[0][2]).toEqual(['fb-new', { [PROVISIONING_CLAIM]: 1 }])
    expect(sqlCalls(/ROLLBACK TO SAVEPOINT provision_preflight/)).toHaveLength(1)
    expect(fb('deleteUser')).toHaveLength(0)
    expect(db.withServiceRole).not.toHaveBeenCalled()
  })
  it('a database refusal in the dry run creates nothing in Firebase', async () => {
    state.preflightError = dbErr('42501', 'provision_app_user: only a super admin can grant elevated access')
    await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 403, message: 'only a super admin can grant elevated access' })
    expect(fb('createUser')).toHaveLength(0)
  })
  it('a refusal after the Firebase account exists deletes it (ours, disabled, unmapped)', async () => {
    state.provisionError = dbErr('23505', 'provision_app_user: email already in use')
    await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 409 })
    expect(fb('deleteUser').map((e) => e[2][0])).toEqual(['fb-new'])
  })
  it('a Firebase account that got mapped meanwhile is never deleted', async () => {
    state.provisionError = dbErr('23505', 'provision_app_user: email already in use')
    state.mapped = { id: TARGET, status: 'pending' }
    await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 409 })
    expect(fb('deleteUser')).toHaveLength(0)
  })
  it('an unknown database outcome with the mapping present is reported as provisioned', async () => {
    state.provisionError = new Error('connection terminated at COMMIT')
    state.mapped = { id: TARGET, status: 'pending' }
    expect(await createAccount(ADMIN, body, deps())).toEqual({ id: TARGET, status: 'pending' })
    expect(fb('deleteUser')).toHaveLength(0)
  })
  it('an unknown database outcome without a mapping cleans up and is safe to retry (503)', async () => {
    state.provisionError = new Error('connection terminated')
    await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 503 })
    expect(fb('deleteUser')).toHaveLength(1)
  })
  it('the provider being down creates nothing (502)', async () => {
    state.createError = Object.assign(new Error('unavailable'), { code: 'auth/internal-error' })
    await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 502 })
    expect(sqlCalls(/provision_app_user/).filter((e) => !String(e[2][0]).startsWith('preflight-'))).toHaveLength(0)
  })
  it('an existing email is adopted only when this flow provably made it and nothing maps to it', async () => {
    state.createError = Object.assign(new Error('exists'), { code: 'auth/email-already-exists' })
    state.existing = { uid: 'fb-orphan', disabled: true, metadata: {}, customClaims: { [PROVISIONING_CLAIM]: 1 } }
    expect(await createAccount(ADMIN, body, deps())).toEqual({ id: TARGET, status: 'pending' })
    expect(sqlCalls(/provision_app_user/).at(-1)[2][0]).toBe('fb-orphan')
  })
  it('someone else\'s Firebase account with that email is never taken over (409)', async () => {
    state.createError = Object.assign(new Error('exists'), { code: 'auth/email-already-exists' })
    for (const existing of [{ uid: 'fb-x', disabled: false, metadata: {}, customClaims: {} },
      { uid: 'fb-y', disabled: true, metadata: { lastSignInTime: 't' }, customClaims: { [PROVISIONING_CLAIM]: 1 } }]) {
      state.existing = existing
      await expect(createAccount(ADMIN, body, deps())).rejects.toMatchObject({ status: 409 })
    }
    expect(fb('deleteUser')).toHaveLength(0)
  })
})

// ── activate / edit / deactivate / reactivate ───────────────────────────────
describe('activateAccount', () => {
  it('database first, then enable sign-in and drop the provisioning marker', async () => {
    expect(await activateAccount(ADMIN, TARGET, deps())).toEqual({ id: TARGET, status: 'active' })
    const order = log.filter((e) => e[0] === 'fb' || (e[0] === 'sql' && /activate_app_user/.test(e[1]))).map((e) => (e[0] === 'fb' ? e[1] : 'db'))
    expect(order).toEqual(['db', 'getUser', 'updateUser', 'setCustomUserClaims'])
    expect(fb('updateUser')[0][2]).toEqual(['fb-uid', { disabled: false }])
    expect(fb('setCustomUserClaims')[0][2]).toEqual(['fb-uid', null])
  })
  it('a Firebase account that does not match the profile is not enabled', async () => {
    state.fbUser = { ...state.fbUser, email: 'someone.else@example.test' }
    await expect(activateAccount(ADMIN, TARGET, deps())).rejects.toMatchObject({ status: 409 })
    expect(fb('updateUser')).toHaveLength(0)
  })
  it('refusals: bad id never reaches the database; the database decides authority', async () => {
    expect(await statusOf(activateAccount(ADMIN, 'not-a-uuid', deps()))).toBe(400)
    expect(log).toEqual([])
    state.activateError = dbErr('42501', 'activate_app_user: administrators only')
    expect(await statusOf(activateAccount(ADMIN, TARGET, deps()))).toBe(403)
    expect(fb('updateUser')).toHaveLength(0)
  })
})

describe('updateAccount (optimistic locking)', () => {
  it('needs the version that was read and refuses fields it does not edit', async () => {
    expect(await statusOf(updateAccount(ADMIN, TARGET, { name: 'x' }, deps()))).toBe(400)
    for (const extra of [{ email: 'x@y.z' }, { status: 'active' }, { firebaseUid: 'u' }]) {
      expect(await statusOf(updateAccount(ADMIN, TARGET, { updatedAt: VERSION, ...extra }, deps()))).toBe(400)
    }
    expect(sqlCalls(/update_app_user/)).toHaveLength(0)
  })
  it('passes the read version and the resulting account to auth.update_app_user and returns the fresh row', async () => {
    const out = await updateAccount(ADMIN, TARGET, { updatedAt: VERSION, role: 'client', clientCode: 'CL01' }, deps())
    expect(sqlCalls(/update_app_user/)[0][2]).toEqual([TARGET, VERSION, 'New Person', 'client', 'CL01', false, false, '[]'])
    expect(out).toMatchObject({ id: TARGET, updatedAt: VERSION })
    expect(JSON.stringify(out)).not.toMatch(/fb-uid|firebase/)
  })
  it('a stale version is a 409; a non-admin caller is a 403', async () => {
    state.updateError = dbErr('40001', 'update_app_user: version mismatch')
    await expect(updateAccount(ADMIN, TARGET, { updatedAt: VERSION, name: 'x' }, deps())).rejects.toMatchObject({ status: 409 })
    state.updateError = null
    state.caller = { role: 'user', status: 'active', super_admin: false }
    expect(await statusOf(updateAccount(ADMIN, TARGET, { updatedAt: VERSION, name: 'x' }, deps()))).toBe(403)
  })
})

describe('deactivate / reactivate', () => {
  it('deactivate: the database first, then sessions revoked and sign-in disabled', async () => {
    expect(await deactivateAccount(ADMIN, TARGET, { updatedAt: VERSION }, deps())).toEqual({ id: TARGET, status: 'inactive', signIn: 'disabled' })
    const order = log.filter((e) => e[0] === 'fb' || (e[0] === 'sql' && /set_app_user_status/.test(e[1]))).map((e) => (e[0] === 'fb' ? e[1] : 'db'))
    expect(order).toEqual(['db', 'revokeRefreshTokens', 'updateUser'])
    expect(sqlCalls(/set_app_user_status/)[0][2]).toEqual([TARGET, false, VERSION])
  })
  it('deactivate: if Firebase fails the account stays locked out and the error says so (502)', async () => {
    state.revokeError = Object.assign(new Error('down'), { code: 'auth/internal-error' })
    await expect(deactivateAccount(ADMIN, TARGET, { updatedAt: VERSION }, deps())).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/deactivated/) })
  })
  it('reactivate: dry run, identity match, enable sign-in, THEN portal access', async () => {
    expect(await reactivateAccount(ADMIN, TARGET, { updatedAt: VERSION }, deps())).toEqual({ id: TARGET, status: 'active', signIn: 'enabled' })
    const order = log.filter((e) => e[0] === 'fb' || (e[0] === 'sql' && /(set_app_user_status|SAVEPOINT status_preflight)/.test(e[1])))
      .map((e) => (e[0] === 'fb' ? e[1] : e[1].startsWith('SAVEPOINT') ? 'savepoint' : e[1].startsWith('ROLLBACK') ? 'rollback' : 'db'))
    expect(order).toEqual(['savepoint', 'db', 'rollback', 'getUser', 'updateUser', 'db'])
  })
  it('reactivate: a refusal at the last step disables sign-in again', async () => {
    state.statusErrors = [null, dbErr('40001', 'set_app_user_status: version mismatch')]
    await expect(reactivateAccount(ADMIN, TARGET, { updatedAt: VERSION }, deps())).rejects.toMatchObject({ status: 409 })
    expect(fb('updateUser').map((e) => e[2][1])).toEqual([{ disabled: false }, { disabled: true }])
  })
  it('reactivate: a mismatched Firebase account is never enabled', async () => {
    state.fbUser = { ...state.fbUser, email: 'other@example.test' }
    await expect(reactivateAccount(ADMIN, TARGET, { updatedAt: VERSION }, deps())).rejects.toMatchObject({ status: 409 })
    expect(fb('updateUser')).toHaveLength(0)
  })
})

describe('listAccounts', () => {
  it('administrators only', async () => {
    state.caller = { role: 'client', status: 'active', super_admin: false }
    expect(await statusOf(listAccounts(ADMIN, deps()))).toBe(403)
  })
  it('returns the admin shape with sign-in state, never the Firebase UID; Firebase down reads "unknown"', async () => {
    const [u] = await listAccounts(ADMIN, deps())
    expect(u).toMatchObject({ id: TARGET, active: true, signIn: 'enabled', updatedAt: VERSION })
    expect(JSON.stringify(u)).not.toMatch(/fb-uid/)
    state.getUsersError = new Error('down')
    expect((await listAccounts(ADMIN, deps()))[0].signIn).toBe('unknown')
  })
})
