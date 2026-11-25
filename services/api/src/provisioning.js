// Account management across Firebase and PostgreSQL, which share no
// transaction. Every partial state is unusable: the gate admits only a token
// from an ENABLED Firebase account whose profile is 'active', so a disabled or
// unmapped Firebase account, or a pending profile, can never sign in. The
// order of steps keeps it that way:
//   create   - a database dry run (authorize, validate, email unused) -> the
//              Firebase account, disabled and marked as this flow's -> the
//              mapping + pending profile, with the caller's rights re-checked.
//              If the database step fails, the Firebase account this request
//              created is deleted only while it is still disabled, ours and
//              unmapped; otherwise it is left disabled for a retry to adopt.
//   activate - the database first (pending -> active, rights re-checked
//              against the account's stored privileges), only then enable the
//              Firebase account and drop the marker. Safe to repeat.
//   edit     - the database only (auth.update_app_user): role, client code,
//              access and permissions live there; nothing in Firebase decides
//              them. On the version the administrator read.
//   deactivate - the database first (active -> inactive): from that commit the
//              gate refuses the account whatever Firebase says. Then its
//              refresh tokens are revoked and the Firebase account disabled; if
//              that fails the account stays locked out and the step is retried.
//   reactivate - a database dry run (authority, state, the mapped UID), then
//              the Firebase account is checked to be this profile's (same UID,
//              same email) and enabled, and only then does the database make
//              the profile active -- the step that grants portal access comes
//              last. If it is refused, the Firebase account is disabled again.
// Authorization is the database's (auth.provision_app_user /
// auth.activate_app_user); this module only orders the steps. The Firebase UID
// never leaves the backend, and nothing here creates a password, an invite or
// a reset link. Dependencies are injectable so the flow unit-tests without
// Firebase or PostgreSQL.
// Ported from the deployed GCP backend; the SQL functions it calls
// (auth.provision_app_user, activate_app_user, update_app_user,
// set_app_user_status, admin_account_uids) exist on resolute_live and are not
// defined in this repository. Never service_role: every database step runs in
// the caller's withUserClaims transaction, the mapping lookup as the login.
import { withUserClaims } from './db.js'
import { getFirebaseAuth, resolveIdentity } from './auth.js'
import {
  getActiveAdmin, listProfiles, preflightProvision, provisionProfile, activateProfile,
  getProfile, listAccountUids, updateProfile, setProfileStatus, previewProfileStatus,
} from './repositories/adminUsers.js'
import { toAdminUser } from './mappers.js'

// Custom claim marking a Firebase account this flow created. Only the Admin
// SDK can set it; the API never authorizes on token claims.
export const PROVISIONING_CLAIM = 'resoluteProvisioning'
const defaults = { withUserClaims, resolveIdentity, getAuth: getFirebaseAuth }

// An expected, client-safe refusal: the status and message go to the client.
export class AccountError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

// The account functions' refusals -> HTTP. Only their own messages (which
// never echo request values) reach the client; any other database error stays
// generic.
const DB_STATUS = { 42501: 403, 22023: 400, 23505: 409, P0002: 404, 55000: 409, 40001: 409 }
const DB_DEFAULT = { 400: 'invalid request', 403: 'forbidden', 404: 'not found', 409: 'conflict' }
export function toAccountError(err) {
  const status = err && DB_STATUS[err.code]
  if (!status) return null
  if (err.code === '40001') return new AccountError(409, 'this account changed since you opened it — reload and try again')
  const m = /^(?:provision_app_user|activate_app_user|update_app_user|set_app_user_status|admin_account_uids): (.+)$/.exec(err.message || '')
  return new AccountError(status, m ? m[1] : DB_DEFAULT[status])
}
async function inDatabase(fn) {
  try {
    return await fn()
  } catch (err) {
    throw toAccountError(err) || err
  }
}

// The create request: only these fields, with these types. A Firebase UID,
// profile id or status from the client is refused, never used.
const FIELDS = new Set(['email', 'name', 'role', 'clientCode', 'superAdmin', 'canConfirmPayments', 'permissions'])
export function accountRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountError(400, 'a JSON object is required')
  if (Object.keys(body).some((k) => !FIELDS.has(k))) throw new AccountError(400, 'unexpected fields')
  const { email, name = '', role, clientCode = null, superAdmin = false, canConfirmPayments = false, permissions = [] } = body
  if (typeof email !== 'string' || typeof role !== 'string' || typeof name !== 'string'
      || (clientCode !== null && typeof clientCode !== 'string')
      || typeof superAdmin !== 'boolean' || typeof canConfirmPayments !== 'boolean' || !Array.isArray(permissions)) {
    throw new AccountError(400, 'invalid request')
  }
  return { email: email.trim().toLowerCase(), name, role, clientCode, superAdmin, canConfirmPayments, permissions }
}

// Proof that this flow made a Firebase account and nobody has used it: our
// marker (or creation in this very request), still disabled, never signed in.
export function provablyOurs(rec, createdHere = false) {
  return !!rec && rec.disabled === true && !(rec.metadata && rec.metadata.lastSignInTime)
    && (createdHere || !!(rec.customClaims && rec.customClaims[PROVISIONING_CLAIM] === 1))
}

// Undo the Firebase half after the database step failed: delete the account
// only if this flow provably owns it, it is still disabled, and no profile maps
// to it (checked last, right before the delete). Anything else -- or any error
// while checking -- leaves it as it is: disabled, so unusable, and adoptable
// by a retry when it carries the marker.
async function releaseAccount(auth, uid, createdHere, deps) {
  try {
    const rec = await auth.getUser(uid)
    if (!provablyOurs(rec, createdHere) || await deps.resolveIdentity(uid)) return 'kept'
    await auth.deleteUser(uid)
    return 'deleted'
  } catch (err) {
    console.error('[accounts] disabled sign-in account left for retry or reconciliation:', (err && err.code) || 'unknown', uid)
    return 'left'
  }
}

// Each account's sign-in state in Firebase ('enabled' | 'disabled' |
// 'missing'), or null when Firebase cannot be asked -- the list still loads,
// each account then reads 'unknown'.
async function signInStates(uids, deps) {
  try {
    const auth = await deps.getAuth()
    const byUid = new Map(uids.map((u) => [u.firebase_uid, u.id]))
    const states = new Map()
    for (let i = 0; i < uids.length; i += 100) {
      const res = await auth.getUsers(uids.slice(i, i + 100).map((u) => ({ uid: u.firebase_uid })))
      for (const rec of res.users || []) if (byUid.has(rec.uid)) states.set(byUid.get(rec.uid), rec.disabled ? 'disabled' : 'enabled')
    }
    return states
  } catch (err) {
    console.warn('[accounts] sign-in states unavailable:', (err && err.code) || 'unknown')
    return null
  }
}

export async function listAccounts(user, deps = defaults) {
  const { rows, uids } = await inDatabase(() => deps.withUserClaims(user, async (client) => {
    if (!await getActiveAdmin(client, user.id)) throw new AccountError(403, 'administrators only')
    return { rows: await listProfiles(client), uids: await listAccountUids(client) }
  }))
  const states = await signInStates(uids, deps)
  return rows.map((r) => ({ ...toAdminUser(r), signIn: states ? (states.get(r.id) || 'missing') : 'unknown' }))
}

export async function createAccount(user, body, deps = defaults) {
  const attrs = accountRequest(body)
  // 1. The database decides before anything exists: the caller's rights, the
  //    rules, the input and an unused email -- in a dry run that writes nothing.
  await inDatabase(() => deps.withUserClaims(user, (client) => preflightProvision(client, attrs)))

  // 2. The Firebase account: disabled, no password, marked as this flow's.
  const auth = await deps.getAuth()
  let uid
  let createdHere = false
  try {
    uid = (await auth.createUser({ email: attrs.email, disabled: true, emailVerified: false })).uid
    createdHere = true
    await auth.setCustomUserClaims(uid, { [PROVISIONING_CLAIM]: 1 })
  } catch (err) {
    if (createdHere) {
      const outcome = await releaseAccount(auth, uid, true, deps)
      throw new AccountError(502, outcome === 'deleted'
        ? 'the sign-in provider failed; nothing was created'
        : 'the sign-in provider failed; a disabled sign-in account remains for reconciliation')
    }
    if (!err || err.code !== 'auth/email-already-exists') {
      throw new AccountError(502, 'the sign-in provider is unavailable; nothing was created')
    }
    // An account with this email exists. Adopt it only when this flow made it
    // (an earlier attempt that stopped before the database step) and nothing
    // maps to it; never take over, change or delete anyone else's.
    let rec
    try {
      rec = await auth.getUserByEmail(attrs.email)
    } catch {
      throw new AccountError(502, 'the sign-in provider is unavailable; nothing was created')
    }
    if (!provablyOurs(rec) || await deps.resolveIdentity(rec.uid)) {
      throw new AccountError(409, 'a sign-in account with this email already exists')
    }
    uid = rec.uid
  }

  // 3. Mapping + pending profile; the database re-checks the caller's rights.
  try {
    const id = await deps.withUserClaims(user, (client) => provisionProfile(client, uid, attrs))
    return { id, status: 'pending' }
  } catch (err) {
    const refusal = toAccountError(err)
    if (!refusal) {
      console.error('[accounts] database step failed:', (err && err.code) || 'unknown')
      // Outcome unknown (e.g. the connection dropped at COMMIT): if the
      // mapping exists, the account was provisioned.
      const row = await deps.resolveIdentity(uid).catch(() => null)
      if (row) return { id: row.id, status: row.status }
    }
    if (createdHere) await releaseAccount(auth, uid, true, deps)
    throw refusal || new AccountError(503, 'the database is unavailable; the request is safe to retry')
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export async function activateAccount(user, id, deps = defaults) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new AccountError(400, 'invalid account id')
  // 1. The database: the caller's current rights against the account's stored
  //    privileges, then pending -> active (a no-op if already active).
  const row = await inDatabase(() => deps.withUserClaims(user, (client) => activateProfile(client, id)))

  // 2. Only now may the account sign in.
  const auth = await deps.getAuth()
  let rec
  try {
    rec = await auth.getUser(row.firebase_uid)
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') {
      throw new AccountError(409, 'the sign-in account is missing; the profile is active but cannot sign in')
    }
    throw new AccountError(502, 'the sign-in provider is unavailable; activation is safe to retry')
  }
  if (String(rec.email || '').toLowerCase() !== row.email) {
    throw new AccountError(409, 'the sign-in account does not match this profile; it was not enabled')
  }
  if (rec.disabled) {
    try {
      await auth.updateUser(rec.uid, { disabled: false })
    } catch {
      throw new AccountError(502, 'the sign-in provider is unavailable; activation is safe to retry')
    }
  }
  if (rec.customClaims && PROVISIONING_CLAIM in rec.customClaims) {
    const { [PROVISIONING_CLAIM]: _marker, ...rest } = rec.customClaims
    try {
      await auth.setCustomUserClaims(rec.uid, Object.keys(rest).length ? rest : null)
    } catch (err) {
      console.warn('[accounts] provisioning marker not cleared:', (err && err.code) || 'unknown')
    }
  }
  return { id, status: 'active' }
}

// ── Edit, deactivate, reactivate ──────────────────────────────────────────────
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/
const version = (body) => {
  const v = body && typeof body === 'object' && !Array.isArray(body) ? body.updatedAt : undefined
  if (typeof v !== 'string' || !TIMESTAMP.test(v)) throw new AccountError(400, 'updatedAt (the version you read) is required')
  return v
}
const accountId = (id) => { if (typeof id !== 'string' || !UUID.test(id)) throw new AccountError(400, 'invalid account id') }

// The edit request: only these fields, with these types. Email, status, ids
// and the Firebase mapping are not editable here at all.
const EDIT_FIELDS = new Set(['updatedAt', 'name', 'role', 'clientCode', 'superAdmin', 'canConfirmPayments', 'permissions'])
export function editRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new AccountError(400, 'a JSON object is required')
  if (Object.keys(body).some((k) => !EDIT_FIELDS.has(k))) throw new AccountError(400, 'unexpected fields')
  const { name, role, clientCode, superAdmin, canConfirmPayments, permissions } = body
  if ((name !== undefined && typeof name !== 'string') || (role !== undefined && typeof role !== 'string')
      || (clientCode !== undefined && clientCode !== null && typeof clientCode !== 'string')
      || (superAdmin !== undefined && typeof superAdmin !== 'boolean')
      || (canConfirmPayments !== undefined && typeof canConfirmPayments !== 'boolean')
      || (permissions !== undefined && !Array.isArray(permissions))) {
    throw new AccountError(400, 'invalid request')
  }
  return { updatedAt: version(body), name, role, clientCode: clientCode === '' ? null : clientCode, superAdmin, canConfirmPayments, permissions }
}

// The account as it will be: what the request sets, the stored value for what
// it leaves out; a client code only for a client, super admin and billing only
// for an admin. The database re-checks all of it under its own lock.
export function editedAccount(cur, req) {
  const role = req.role ?? cur.role
  return {
    name: req.name ?? cur.name ?? '',
    role,
    clientCode: role === 'client' ? (req.clientCode !== undefined ? req.clientCode : cur.client_code) ?? null : null,
    superAdmin: role === 'admin' ? (req.superAdmin ?? !!cur.super_admin) : false,
    canConfirmPayments: role === 'admin' ? (req.canConfirmPayments ?? !!cur.can_confirm_payments) : false,
    permissions: req.permissions ?? (Array.isArray(cur.permissions) ? cur.permissions : []),
  }
}

export async function updateAccount(user, id, body, deps = defaults) {
  accountId(id)
  const req = editRequest(body)
  return inDatabase(() => deps.withUserClaims(user, async (client) => {
    if (!await getActiveAdmin(client, user.id)) throw new AccountError(403, 'administrators only')
    const cur = await getProfile(client, id)
    if (!cur) throw new AccountError(404, 'not found')
    await updateProfile(client, id, req.updatedAt, editedAccount(cur, req))
    return toAdminUser(await getProfile(client, id))
  }))
}

export async function deactivateAccount(user, id, body, deps = defaults) {
  accountId(id)
  const expected = version(body)
  // 1. The database: from this commit the account cannot use the portal.
  const row = await inDatabase(() => deps.withUserClaims(user, (client) => setProfileStatus(client, id, false, expected)))
  // 2. Firebase: its sessions end and it can no longer sign in.
  const auth = await deps.getAuth()
  try {
    await auth.revokeRefreshTokens(row.firebase_uid)
    await auth.updateUser(row.firebase_uid, { disabled: true })
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return { id, status: 'inactive', signIn: 'missing' }
    console.error('[accounts] deactivated, sign-in account not disabled yet:', (err && err.code) || 'unknown')
    throw new AccountError(502, 'the account is deactivated and can no longer use the portal, but its sign-in account '
      + 'could not be disabled — use “Finish deactivation” to retry')
  }
  return { id, status: 'inactive', signIn: 'disabled' }
}

export async function reactivateAccount(user, id, body, deps = defaults) {
  accountId(id)
  const expected = version(body)
  // 1. The database, as a dry run: the caller's authority, the account's state
  //    and its mapped sign-in identity. Nothing is written.
  const ident = await inDatabase(() => deps.withUserClaims(user, (client) => previewProfileStatus(client, id, true, expected)))
  // 2. The Firebase account must be this profile's: the mapped UID, the same email.
  const auth = await deps.getAuth()
  let rec
  try {
    rec = await auth.getUser(ident.firebase_uid)
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') throw new AccountError(409, 'the sign-in account is missing; the account was not reactivated')
    throw new AccountError(502, 'the sign-in provider is unavailable; nothing was changed')
  }
  if (rec.uid !== ident.firebase_uid || String(rec.email || '').toLowerCase() !== String(ident.email || '').toLowerCase()) {
    throw new AccountError(409, 'the sign-in account does not match this profile; the account was not reactivated')
  }
  // 3. Sign-in on -- the profile is still inactive, so the gate still refuses it.
  let enabledHere = false
  if (rec.disabled) {
    try {
      await auth.updateUser(rec.uid, { disabled: false })
      enabledHere = true
    } catch {
      throw new AccountError(502, 'the sign-in provider is unavailable; nothing was changed')
    }
  }
  // 4. Portal access, last: the database re-checks authority, state and version.
  try {
    await inDatabase(() => deps.withUserClaims(user, (client) => setProfileStatus(client, id, true, expected)))
  } catch (err) {
    if (enabledHere) {
      try {
        await auth.updateUser(rec.uid, { disabled: true })
      } catch (e) {
        console.error('[accounts] sign-in left enabled for an inactive profile (portal access still refused):', (e && e.code) || 'unknown')
      }
    }
    throw err
  }
  return { id, status: 'active', signIn: 'enabled' }
}
