// GCP backend provider (ADR 0002). Selected only when VITE_BACKEND=gcp: local
// development and the staging candidate (gcp/web/Dockerfile); no production
// deployment sets it.
//
// LIVE here: authentication -- Firebase Authentication (email/password) through
// the modular Web SDK -- administrator account management, and orders (list,
// read, place, update with the optimistic lock, the client's cancel) plus the
// staff roster and client directory they need, all against the Express data API
// in services/api. The portal profile always comes from the API, never from the
// Firebase token. There is no realtime: OrderContext refreshes on focus,
// navigation and after writes.
//
// Order documents (private Cloud Storage behind the API), the typer's
// fulfillment draft, portal messages, the order activity trail and in-app
// notifications are live too -- the last three refreshed like orders (focus,
// navigation, after a write), never pushed.
//
// Client payment reports (ACH / check, confirmed by the billing owner), account
// administration and company contacts are live too.
//
// NOT AVAILABLE (phases B2-B5): message attachments, payment terms and
// statements, vendor payouts and subscriptions, email (no provider: nothing is
// ever emailed, and no screen says it was). The contexts that key on `isSupabaseConfigured` (false here) keep their
// demo behaviour, and App.jsx says what is connected in a banner. Sign-in
// itself never falls back to the demo accounts in this mode.
//
// The API base URL must be configured explicitly and, unless
// VITE_GCP_API_ALLOW_REMOTE=true (a staging build), must be a local address -- a
// GCP-mode build never falls back to the same-origin /api of a deployed
// (Vercel) app; a remote API is https only. A production build never talks to
// the Firebase Auth emulator.
// The Firebase web config is public by design (it names the project; it is not
// a credential). No service-account key is ever read by the browser.

// ── Configuration ─────────────────────────────────────────────────────────────
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

// Pure, so it unit-tests without a build: env (import.meta.env) -> config.
export function resolveGcpConfig(env = {}) {
  const problems = []
  let apiBase = null
  const raw = String(env.VITE_GCP_API_BASE_URL || '').trim()
  if (!raw) {
    problems.push('VITE_GCP_API_BASE_URL is not set')
  } else {
    let u = null
    try { u = new URL(raw) } catch { /* reported below */ }
    if (!u || !/^https?:$/.test(u.protocol) || u.pathname.replace(/\/+$/, '') !== '' || u.search || u.hash || u.username || u.password) {
      problems.push('VITE_GCP_API_BASE_URL must be an origin such as http://localhost:8080')
    } else if (!LOCAL_HOSTS.has(u.hostname) && env.VITE_GCP_API_ALLOW_REMOTE !== 'true') {
      problems.push('VITE_GCP_API_BASE_URL is not a local address (set VITE_GCP_API_ALLOW_REMOTE=true only for a non-production API)')
    } else if (!LOCAL_HOSTS.has(u.hostname) && u.protocol !== 'https:') {
      problems.push('VITE_GCP_API_BASE_URL must use https for a remote API')
    } else {
      apiBase = u.origin
    }
  }
  const firebase = {
    apiKey: env.VITE_FIREBASE_API_KEY || '',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN || '',
    projectId: env.VITE_FIREBASE_PROJECT_ID || '',
    ...(env.VITE_FIREBASE_APP_ID ? { appId: env.VITE_FIREBASE_APP_ID } : {}),
  }
  for (const [name, value] of [['VITE_FIREBASE_API_KEY', firebase.apiKey],
    ['VITE_FIREBASE_AUTH_DOMAIN', firebase.authDomain], ['VITE_FIREBASE_PROJECT_ID', firebase.projectId]]) {
    if (!value) problems.push(`${name} is not set`)
  }
  const emulatorHost = String(env.VITE_FIREBASE_AUTH_EMULATOR_HOST || '').trim() || null
  if (emulatorHost && !/^(localhost|127\.0\.0\.1):\d{2,5}$/.test(emulatorHost)) {
    problems.push('VITE_FIREBASE_AUTH_EMULATOR_HOST must be a local host:port')
  }
  if (emulatorHost && env.PROD) {
    problems.push('VITE_FIREBASE_AUTH_EMULATOR_HOST is for local development only, never a production build')
  }
  return { ok: problems.length === 0, apiBase, firebase, emulatorHost, problems }
}

const CONFIG = resolveGcpConfig(import.meta.env)

export const backendName = 'gcp'
// Data is not wired yet: keep every isSupabaseConfigured guard on demo data.
export const isSupabaseConfigured = false
export const isAuthConfigured = CONFIG.ok
export const authConfigError = CONFIG.ok ? null : `GCP sign-in is not configured: ${CONFIG.problems.join('; ')}.`
export const backendNotice = CONFIG.ok
  ? `GCP development mode — sign-in, user management, orders, order documents, the typing draft, portal messages, activity history, in-app notifications and client payment reports (ACH / check, confirmed by the billing owner) use the API at ${CONFIG.apiBase}${CONFIG.emulatorHost ? ' and the Firebase Auth emulator' : ''}. No live updates: they refresh when you open a page, return to this tab or save. Payment terms and statements, vendor payouts and subscriptions, message attachments and email are not connected — nothing entered there is saved and nobody is emailed.`
  : `GCP development mode — ${authConfigError}`
// What this backend cannot do yet. The screens that would otherwise keep a
// local copy say so instead (never an in-browser success).
// Portal messages, the activity trail and notifications live behind the API;
// message attachments do not yet, and there is no email at all.
export const messagingAvailable = CONFIG.ok
export const messageAttachmentsAvailable = false
export const serverActivity = CONFIG.ok
export const serverNotifications = CONFIG.ok
export const emailDeliveryOffered = false
// An order change and Admin's message about it (or a clarification answer and
// the client's reply) are one request -- stored together or not at all.
export const orderMessagesAtomic = CONFIG.ok
// Order documents live in the API's private Cloud Storage bucket; uploads are
// confirmed by the server (never an in-browser stand-in), a client attachment
// is listed on its order by the server itself, and the typer's draft is saved.
export const documentsAvailable = CONFIG.ok
export const documentsStored = CONFIG.ok
export const serverDocumentRefs = true
export const fulfillmentStored = CONFIG.ok
export const maxDocumentBytes = 25 * 1024 * 1024
export const passwordResetAvailable = CONFIG.ok
// Client payments: the client's report and the billing owner's decision are the
// API's (the two-step check workflow, decided by the database). Payment terms /
// statements, vendor payouts and subscriptions are not connected here yet: the
// billing screens say so instead of keeping browser-only copies.
export const serverPayments = CONFIG.ok
export const billingTermsAvailable = false
export const vendorPayoutsAvailable = false

// ── Firebase (loaded on first use) ────────────────────────────────────────────
const APP_NAME = 'resolute-gcp'
let firebasePromise = null
function firebase() {
  if (!CONFIG.ok) return Promise.reject(new Error(authConfigError))
  firebasePromise ??= (async () => {
    const [{ initializeApp, getApps }, sdk] = await Promise.all([import('firebase/app'), import('firebase/auth')])
    const app = getApps().find((a) => a.name === APP_NAME) || initializeApp(CONFIG.firebase, APP_NAME)
    const auth = sdk.getAuth(app)
    if (CONFIG.emulatorHost) sdk.connectAuthEmulator(auth, `http://${CONFIG.emulatorHost}`, { disableWarnings: true })
    await sdk.setPersistence(auth, sdk.browserLocalPersistence)
    return { auth, sdk }
  })().catch((err) => { firebasePromise = null; throw err })
  return firebasePromise
}
const safeSignOut = async (fb) => { try { await fb.sdk.signOut(fb.auth) } catch { /* already signed out */ } }

const MSG = {
  invalid: 'Invalid email or password. Please try again.',
  disabled: 'This account is not active yet. An administrator must activate it before you can sign in.',
  notActive: 'This account is not active in the portal. Ask an administrator to activate it.',
  session: 'Your sign-in could not be verified. Please sign in again.',
  apiDown: 'The Resolute service is unavailable right now. Your password was accepted — please try again shortly.',
  apiDownSession: 'The Resolute service is unavailable right now, so your session could not be restored. Please try again shortly.',
  dataDown: 'the Resolute service could not be reached — nothing was confirmed; try again shortly',
  authDown: 'The sign-in service could not be reached. Check your connection and try again.',
  tooMany: 'Too many attempts. Wait a moment and try again, or reset your password.',
  failed: 'Sign-in failed. Please try again.',
}
const INVALID_CREDENTIALS = new Set(['auth/invalid-credential', 'auth/invalid-login-credentials', 'auth/wrong-password',
  'auth/user-not-found', 'auth/invalid-email', 'auth/missing-password', 'auth/missing-email'])
function signInFailure(err) {
  const code = err && err.code
  if (INVALID_CREDENTIALS.has(code)) return { error: MSG.invalid, code: 'invalid_credentials' }
  if (code === 'auth/user-disabled') return { error: MSG.disabled, code: 'account_disabled' }
  if (code === 'auth/too-many-requests') return { error: MSG.tooMany, code: 'rate_limited' }
  if (code === 'auth/network-request-failed') return { error: MSG.authDown, code: 'auth_unavailable' }
  return { error: MSG.failed, code: 'auth_error' }
}
const unavailable = (message = MSG.apiDown) => Object.assign(new Error(message), { code: 'api_unavailable' })

// ── The data API ──────────────────────────────────────────────────────────────
// One call with the user's Firebase ID token (refreshed by the SDK when it has
// expired). A 401 is retried once with a forced refresh. A network failure is
// "unavailable" (never "invalid credentials"); HTTP responses are returned.
async function api(path, fbUser, { method = 'GET', body } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let token
    try {
      token = await fbUser.getIdToken(attempt === 1)
    } catch (err) {
      if (err && err.code === 'auth/network-request-failed') throw unavailable()
      return { status: 401, ok: false, json: null }
    }
    let res
    try {
      res = await fetch(`${CONFIG.apiBase}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
      })
    } catch {
      throw unavailable()
    }
    if (res.status === 401 && attempt === 0) continue
    const json = await res.json().catch(() => null)
    return { status: res.status, ok: res.ok, json }
  }
  return { status: 401, ok: false, json: null }
}

// The portal user, from GET /api/me only -- the same shape the Supabase
// provider's mapUser() returns. Anything but an active profile is refused.
const USER_FIELDS = ['id', 'email', 'role', 'name', 'avatar', 'superAdmin', 'clientCode', 'canConfirmPayments', 'permissions']
async function portalUser(fbUser) {
  const r = await api('/api/me', fbUser)
  if (r.status >= 500) throw unavailable()
  if (r.status === 200 && r.json && typeof r.json.role === 'string' && r.json.role && r.json.id) {
    const user = Object.fromEntries(USER_FIELDS.map((k) => [k, r.json[k] ?? null]))
    user.superAdmin = !!user.superAdmin
    user.canConfirmPayments = !!user.canConfirmPayments
    user.permissions = Array.isArray(user.permissions) ? user.permissions : []
    return { user }
  }
  if (r.status === 403) return { error: MSG.notActive, code: 'account_inactive' }
  return { error: MSG.session, code: 'session_invalid' }
}

// ── Auth ──────────────────────────────────────────────────────────────────────
export async function getCurrentUser() {
  if (!CONFIG.ok) return null
  const fb = await firebase()
  if (typeof fb.auth.authStateReady === 'function') await fb.auth.authStateReady()
  const current = fb.auth.currentUser
  if (!current) return null
  let p
  try {
    p = await portalUser(current)
  } catch (err) {
    // Keep the Firebase session: the next load can restore it once the API is back.
    throw err && err.code === 'api_unavailable' ? unavailable(MSG.apiDownSession) : err
  }
  if (!p.user) { await safeSignOut(fb); return null }
  return p.user
}

export async function getAccessToken() {
  if (!CONFIG.ok) return null
  const fb = await firebase()
  return fb.auth.currentUser ? fb.auth.currentUser.getIdToken() : null
}

export async function signIn(email, password) {
  if (!CONFIG.ok) return { success: false, error: authConfigError, code: 'not_configured' }
  let fb
  try { fb = await firebase() } catch { return { success: false, error: MSG.authDown, code: 'auth_unavailable' } }
  let cred
  try {
    cred = await fb.sdk.signInWithEmailAndPassword(fb.auth, String(email || '').trim(), String(password || ''))
  } catch (err) {
    return { success: false, ...signInFailure(err) }
  }
  let p
  try {
    p = await portalUser(cred.user)
  } catch {
    await safeSignOut(fb)
    return { success: false, error: MSG.apiDown, code: 'api_unavailable' }
  }
  if (!p.user) {
    await safeSignOut(fb)
    return { success: false, error: p.error, code: p.code }
  }
  return { success: true, role: p.user.role, user: p.user }
}

export async function signOut() {
  if (!CONFIG.ok) return
  const fb = await firebase()
  await fb.sdk.signOut(fb.auth)
}

// Calls cb(user | null) when the Firebase session changes. A session whose
// profile is refused reports null; an unreachable API leaves the state alone.
export function onAuthChange(cb) {
  if (!CONFIG.ok) return () => {}
  let stop = null
  let cancelled = false
  firebase().then(({ auth, sdk }) => {
    if (cancelled) return
    stop = sdk.onAuthStateChanged(auth, async (fbUser) => {
      if (!fbUser) { cb(null); return }
      try {
        const p = await portalUser(fbUser)
        cb(p.user || null)
      } catch { /* API unavailable: keep the current state */ }
    })
  }).catch(() => {})
  return () => { cancelled = true; if (stop) stop() }
}

// Passwords are set through Firebase's own emailed link and its hosted page, not
// an in-app recovery session, so there is nothing to update in place.
export async function updatePassword() {
  return { success: false, error: 'In this mode, passwords are set through the link Firebase emails you.' }
}
export function onPasswordRecovery() { return () => {} }

// Ask Firebase to email a password-setup / reset link to `email`. Firebase sends
// it from its own templates; the link never passes through this app or the API.
// The answer never says whether the address has an account.
export async function requestPasswordReset(email) {
  if (!CONFIG.ok) return { success: false, error: authConfigError }
  const address = String(email || '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) return { success: false, error: 'Enter a valid email address.' }
  try {
    const fb = await firebase()
    await fb.sdk.sendPasswordResetEmail(fb.auth, address)
  } catch (err) {
    const code = err && err.code
    if (code === 'auth/network-request-failed') return { success: false, error: MSG.authDown }
    if (code === 'auth/too-many-requests') return { success: false, error: MSG.tooMany }
    // anything else (e.g. no such user): same answer, so accounts cannot be probed
  }
  return { success: true }
}

// ── Administrator account management (/api/admin/users) ──────────────────────
// What this backend supports, for the Admin Users screen: create, activate,
// edit, deactivate and reactivate are live, each sign-in state is reported, and
// an administrator edits only their own name. Accounts are never removed here
// (deactivate instead); there are no in-app reset links (Firebase emails them).
export const userAdmin = {
  live: CONFIG.ok,
  activate: true,
  edit: CONFIG.ok,
  setActive: CONFIG.ok,
  signInState: CONFIG.ok,
  selfEditNameOnly: true,
  resetPassword: false,
  remove: false,
  sendPasswordEmail: CONFIG.ok,
  inviteLinks: false,
  adminRequiresSuper: true,            // only a super admin creates admin accounts
  billingRequiresBillingOwner: true,   // only the billing owner grants billing
}

function adminError(r, verb = 'Not created') {
  const reason = r.json && typeof r.json.error === 'string' ? r.json.error : null
  if (r.status === 401) return MSG.session
  if (r.status === 403) return `Not allowed: ${reason || 'you do not have permission for this'}.`
  if (r.status === 409) return `${verb}: ${reason || 'this account already exists'}.`
  if (r.status === 400) return `Invalid request: ${reason || 'check the form'}.`
  if (r.status === 404) return 'That account no longer exists.'
  if (r.status >= 500) return reason ? `Not completed: ${reason}.` : `The service failed (HTTP ${r.status}); nothing was confirmed — try again.`
  return reason ? `Request failed: ${reason}.` : `Request failed (HTTP ${r.status}).`
}
async function adminApi(path, options, verb) {
  const fb = await firebase()
  if (!fb.auth.currentUser) throw new Error(MSG.session)
  const r = await api(path, fb.auth.currentUser, options)   // unavailable -> throws
  if (!r.ok) throw new Error(adminError(r, verb))
  return r.json || {}
}

export async function listUsers() {
  const j = await adminApi('/api/admin/users')
  return Array.isArray(j.users) ? j.users : []
}

// Only the fields the API accepts; flags only for admin accounts, a client code
// only for client accounts. The server decides whether the caller may.
export async function createUser(input) {
  const body = {
    email: String(input.email || '').trim(),
    name: String(input.name || ''),
    role: input.role,
    permissions: Array.isArray(input.permissions) ? input.permissions : [],
  }
  if (input.role === 'client') body.clientCode = String(input.clientCode || '').trim() || null
  if (input.role === 'admin') {
    if (input.superAdmin) body.superAdmin = true
    if (input.canConfirmPayments) body.canConfirmPayments = true
  }
  const j = await adminApi('/api/admin/users', { method: 'POST', body })
  return { id: j.id, status: j.status }
}

export async function activateUser(id) {
  return adminApi(`/api/admin/users/${encodeURIComponent(id)}/activate`, { method: 'POST' })
}

// Edit on the version last read (`updatedAt`). Only the fields given are sent;
// the server fills the rest from the stored account and decides who may.
export async function updateUser({ id, updatedAt, ...input }) {
  const body = { updatedAt: updatedAt || null }
  for (const k of ['name', 'role', 'permissions']) if (k in input) body[k] = input[k]
  if ('clientCode' in input) body.clientCode = input.role === 'client' ? (String(input.clientCode || '').trim() || null) : null
  if (input.role === 'admin') {
    if ('superAdmin' in input) body.superAdmin = !!input.superAdmin
    if ('canConfirmPayments' in input) body.canConfirmPayments = !!input.canConfirmPayments
  }
  return adminApi(`/api/admin/users/${encodeURIComponent(id)}`, { method: 'PATCH', body }, 'Not saved')
}
// Deactivate (portal access ends at once, then sign-in is disabled) or
// reactivate (the sign-in account is verified and enabled, then portal access).
export async function setUserActive(id, active, updatedAt) {
  return adminApi(`/api/admin/users/${encodeURIComponent(id)}/${active ? 'reactivate' : 'deactivate'}`,
    { method: 'POST', body: { updatedAt: updatedAt || null } }, 'Not completed')
}
const notAvailable = (what) => async () => { throw new Error(`${what} is not available in GCP mode yet.`) }
export const resetUserPassword = notAvailable('Generating a reset link')
export const removeUser = notAvailable('Removing an account')

// ── Data: not wired yet (B2+) ─────────────────────────────────────────────────
// Semantics while unwired: reads resolve empty, writes report a clear not-wired
// error, realtime subscriptions are inert, and the handful of functions the app
// calls for their side effect only are no-ops.
const writeErr = (phase) => ({ ok: false, error: `GCP backend not wired yet (ADR 0002, ${phase})` })
const inertUnsub = () => () => {}

// ── Orders (/api/orders) ──────────────────────────────────────────────────────
// Same contract as the Supabase provider: reads return null / { error } on a
// failure (never demo data), saveOrder returns { ok } or { ok: false, stale?,
// error }. Differences, both deliberate: saveOrder also returns the stored row
// (`row`, the server's version after the write or the current one on a
// conflict), and insertOrder sends only the placement fields and returns the
// stored order -- its id, status and initial state are the server's.
async function dataApi(path, options) {
  const fb = await firebase()
  if (!fb.auth.currentUser) throw new Error(MSG.session)
  try {
    return await api(path, fb.auth.currentUser, options)
  } catch (err) {
    if (err && err.code === 'api_unavailable') throw unavailable(MSG.dataDown)
    throw err
  }
}
const reasonOf = (r) => (r.json && typeof r.json.error === 'string' ? r.json.error : null)
function orderError(r, verb) {
  const reason = reasonOf(r)
  if (r.status === 401) return MSG.session
  if (r.status === 403) return `${verb}: ${reason || 'not allowed'}.`
  if (r.status === 400) return `${verb}: ${reason || 'invalid request'}.`
  if (r.status === 404) return `${verb}: this order no longer exists or is not visible to you.`
  if (r.status === 409) return `${verb}: ${reason || 'conflict'}.`
  return `${verb}: the service failed (HTTP ${r.status}); nothing was confirmed — try again.`
}

export async function fetchOrders() {
  try {
    const r = await dataApi('/api/orders')
    if (r.ok && Array.isArray(r.json)) return r.json
    console.error('[orders]', r.status, reasonOf(r))
  } catch (err) { console.error('[orders]', err.message) }
  return null
}

export async function fetchOrderById(id) {
  try {
    const r = await dataApi(`/api/orders/${encodeURIComponent(id)}`)
    if (r.status === 404) return { row: null }
    if (r.ok && r.json && r.json.id) return { row: r.json }
    return { error: reasonOf(r) || `HTTP ${r.status}` }
  } catch (err) { return { error: err.message } }
}

// The writable fields (the API's UPDATE_COLUMNS, as toOrderRow sends them) and
// the version this browser last saw. Placement fields are never sent.
const WRITABLE = ['status', 'priority', 'payment', 'clarification', 'clientFileNo', 'assignedTo', 'assignedUserId',
  'screener', 'examiner', 'typer', 'delivery', 'progress', 'eta', 'completed', 'completedDates', 'completedBy', 'workflow']
export function orderPatch(order) {
  const body = { updatedAt: order.updatedAt || null }
  for (const k of WRITABLE) body[k] = order[k] ?? null
  body.clientFileNo = order.clientFileNo || null
  body.eta = order.eta || null
  body.completed = order.completed || null
  body.progress = Number.isInteger(order.progress) ? order.progress : 0
  body.completedDates = order.completedDates || {}
  body.completedBy = order.completedBy || {}
  body.workflow = order.workflow || {}
  return body
}

// `clientMessage`: Admin's message to the client about this change, stored by
// the API in the same transaction as the change (both or neither).
export async function saveOrder(order, { clientMessage = null } = {}) {
  let r
  try {
    r = await dataApi(`/api/orders/${encodeURIComponent(order.id)}`, { method: 'PATCH', body: { ...orderPatch(order), ...(clientMessage ? { clientMessage } : {}) } })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (r.ok && r.json && r.json.id) return { ok: true, updatedAt: r.json.updatedAt || null, row: r.json }
  if (r.status === 409) return { ok: false, stale: true, error: reasonOf(r) || 'this order changed elsewhere — reloading the latest version', row: (r.json && r.json.order) || null }
  return { ok: false, error: orderError(r, 'the change was refused').replace(/\.$/, '') }
}

const PLACEMENT = ['clientCode', 'state', 'county', 'type', 'priority', 'payment', 'clientFileNo', 'intake']
export async function insertOrder(data) {
  const body = {}
  for (const k of PLACEMENT) if (data[k] !== undefined && data[k] !== null && data[k] !== '') body[k] = data[k]
  const r = await dataApi('/api/orders', { method: 'POST', body })   // unavailable -> throws
  if (r.status === 201 && r.json && r.json.id) return r.json
  throw new Error(orderError(r, 'Not placed'))
}

// No realtime in this mode: OrderContext refreshes instead.
export function subscribeOrders() { return inertUnsub() }

// ── Portal messages (/api/messages) ──────────────────────────────────────────
// The same shape as the Supabase provider's rows. The server decides the sender,
// author and client code; a message exists here only once the API stored it.
const timeLabel = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const toSupportMsg = (m) => ({
  id: m.id, clientCode: m.clientCode, orderId: m.orderId || null, from: m.from, body: m.text, author: m.author || null,
  attachment: null, visibility: m.visibility, mine: !!m.mine, time: timeLabel(m.createdAt), at: Date.parse(m.createdAt),
})
export async function fetchSupportMessages() {
  try {
    const r = await dataApi('/api/messages')
    if (r.ok && r.json && Array.isArray(r.json.messages)) return r.json.messages.map(toSupportMsg)
    console.error('[messages]', r.status, reasonOf(r))
  } catch (err) { console.error('[messages]', err.message) }
  return null
}
// -> the stored message. A refusal or an unreachable API throws with the reason;
// `requestId` makes a retry of the same send return the message already stored.
export async function insertSupportMessage({ clientCode, body, orderId = null, attachment = null, visibility = 'client', requestId }) {
  if (attachment) throw new Error('Not sent: message attachments are not available in GCP mode yet.')
  const r = await dataApi('/api/messages', { method: 'POST', body: {
    ...(orderId ? { orderId } : clientCode ? { clientCode } : {}), text: body, visibility, ...(requestId ? { requestId } : {}),
  } })
  if ((r.status === 201 || r.status === 200) && r.json && r.json.id) return toSupportMsg(r.json)
  throw new Error(orderError(r, 'Not sent'))
}
export async function markOrderPayment() { throw new Error('Not recorded: report a payment through reportPayment on this service.') }

// ── Client payments (/api/orders/:id/payment[/verify]) ───────────────────────
// The client's report ('marked': awaiting verification -- never payment) and
// the billing owner's decision ('confirmed' / 'bounced') on the version of the
// order reviewed. Each answers with the order as stored; nothing is shown before.
export async function reportPayment(orderId, { method, reference, checkDocumentId = null }) {
  const r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/payment`,
    { method: 'POST', body: { method, reference, checkDocumentId } })   // unavailable -> throws
  if (r.ok && r.json && r.json.id) return r.json
  throw new Error(orderError(r, 'Not reported'))
}
export async function verifyPayment(orderId, { decision, updatedAt, reason = null }) {
  let r
  try {
    r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/payment/verify`,
      { method: 'POST', body: { decision, updatedAt: updatedAt || null, ...(reason ? { reason } : {}) } })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  if (r.ok && r.json && r.json.id) return { ok: true, order: r.json }
  if (r.status === 409 && r.json && r.json.stale) return { ok: false, stale: true, order: r.json.order || null, error: reasonOf(r) }
  return { ok: false, error: orderError(r, 'Not recorded').replace(/\.$/, '') }
}
// The client's own cancel: { mode: 'cancelled' | 'requested', order }.
export async function cancelOrderRpc(orderId) {
  const r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' })
  if (r.ok && r.json && r.json.mode) return r.json
  throw new Error(orderError(r, 'Not cancelled'))
}
// The client tells Admin a clarification is answered -- with its reply, stored
// in the same transaction when given -> the stored order.
export async function respondClarificationRpc(orderId, text = null) {
  const r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/clarification-response`, { method: 'POST', ...(text ? { body: { text } } : {}) })
  if (r.ok && r.json && r.json.id) return r.json
  throw new Error(orderError(r, 'Not recorded'))
}
export function subscribeSupport() { return inertUnsub() }

// ── Fulfillment (/api/orders/:id/fulfillment) ────────────────────────────────
// The typer's draft. A failed read THROWS rather than answering "no draft yet",
// so a network blip can never be mistaken for an empty draft and overwrite one.
export async function fetchFulfillment(orderId) {
  const r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/fulfillment`)
  if (r.ok && r.json && 'data' in r.json) return r.json.data
  throw new Error(orderError(r, 'The draft could not be loaded'))
}
export async function saveFulfillment(orderId, data) {
  let r
  try {
    r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/fulfillment`, { method: 'PUT', body: { data } })
  } catch (err) {
    return { ok: false, error: err.message }
  }
  return r.ok ? { ok: true } : { ok: false, error: orderError(r, 'the draft was refused').replace(/\.$/, '') }
}

// ── Notification preferences ──────────────────────────────────────────────────
export async function fetchNotificationTypes() { return null }
export async function fetchNotificationPreferences() { return null }
export async function saveNotificationPreference() { return writeErr('B2') }
export async function clearNotificationPreference() { return writeErr('B2') }

// ── Clients ───────────────────────────────────────────────────────────────────
export async function fetchClients() {
  try {
    const r = await dataApi('/api/clients')
    if (r.ok && r.json && Array.isArray(r.json.clients)) return r.json.clients
    console.error('[fetchClients]', r.status, reasonOf(r))
  } catch (err) { console.error('[fetchClients]', err.message) }
  return null
}
export async function fetchClientTerms() { return null }
export async function saveClientTerms() { /* side-effect write; no-op until B2 */ }

// ── Client contacts ───────────────────────────────────────────────────────────
// ── Client contacts (/api/clients/:code/contacts, /api/contacts/:id) ─────────
// The company's live directory, as stored. A refused or unreachable write is
// { ok: false, error } -- never a local stand-in. "Remove" archives the
// contact; orders placed by them keep the snapshot they were placed with.
const contactPath = (code) => `/api/clients/${encodeURIComponent(code)}/contacts`
export async function fetchContacts(clientCode = null) {
  if (!clientCode) return null
  try {
    const r = await dataApi(contactPath(clientCode))
    if (r.ok && r.json && Array.isArray(r.json.contacts)) return r.json.contacts
    console.error('[contacts]', r.status, reasonOf(r))
  } catch (err) { console.error('[contacts]', err.message) }
  return null
}
export async function saveContact(contact) {
  const body = { name: contact.name, email: contact.email || null, phone: contact.phone || null, title: contact.title || null,
    marketingOptIn: !!contact.marketingOptIn }
  let r
  try {
    r = contact.id
      ? await dataApi(`/api/contacts/${encodeURIComponent(contact.id)}`, { method: 'PATCH', body: { ...body, updatedAt: contact.updatedAt || null } })
      : await dataApi(contactPath(contact.clientCode), { method: 'POST', body })
  } catch (err) { return { ok: false, error: err.message } }
  if (r.ok && r.json && r.json.id) return { ok: true, contact: r.json }
  return { ok: false, stale: r.status === 409, error: orderError(r, 'Not saved').replace(/\.$/, '') }
}
export async function deleteContact(id) {
  let r
  try { r = await dataApi(`/api/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch (err) { return { ok: false, error: err.message } }
  if (r.ok) return { ok: true }
  return { ok: false, error: orderError(r, 'Not removed').replace(/\.$/, '') }
}

// ── Client company profile ────────────────────────────────────────────────────
// ── Company profile (/api/clients/:code/profile) ─────────────────────────────
// null = none saved yet; an unreadable profile throws (never an empty form that
// could be saved over the real one -- the save is on the version read anyway).
export async function fetchClientProfile(clientCode) {
  if (!clientCode) return null
  const r = await dataApi(`/api/clients/${encodeURIComponent(clientCode)}/profile`)   // unavailable -> throws
  if (r.ok && r.json && 'profile' in r.json) return r.json.profile
  throw new Error(orderError(r, 'The company profile could not be loaded'))
}
export async function saveClientProfile(clientCode, profile) {
  const body = { updatedAt: profile.updatedAt || null }
  for (const k of ['address', 'city', 'state', 'zip', 'phone', 'website', 'logoUrl']) body[k] = profile[k] || null
  let r
  try { r = await dataApi(`/api/clients/${encodeURIComponent(clientCode)}/profile`, { method: 'PUT', body }) } catch (err) { return { ok: false, error: err.message } }
  if (r.ok && r.json && r.json.profile) return { ok: true, profile: r.json.profile }
  return { ok: false, stale: r.status === 409, profile: (r.json && r.json.profile) || null, error: orderError(r, 'Not saved').replace(/\.$/, '') }
}

// ── Vendors & payouts ─────────────────────────────────────────────────────────
export async function fetchVendors() { return null }
export async function saveVendorCycle() { /* side-effect write; no-op until B2 */ }
export async function savePayoutLedger() { /* side-effect write; no-op until B2 */ }

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function fetchSubscriptions() { return null }
export async function saveSubscription() { /* side-effect write; no-op until B2 */ }

// ── Activity trail (/api/activity, /api/orders/:id/activity) ─────────────────
// Read-only: the database records every event from the change itself, so the
// browser never claims one (logEvent writes nothing here).
const toActivity = (e) => ({ id: e.id, orderId: e.orderId, kind: e.kind, type: e.type, action: e.action, actor: e.actor,
  meta: e.meta || {}, time: timeLabel(e.createdAt), at: Date.parse(e.createdAt) })
export async function fetchActivity(limit = 100) {
  try {
    const r = await dataApi(`/api/activity?limit=${limit}`)
    if (r.ok && r.json && Array.isArray(r.json.events)) return r.json.events.map(toActivity)
    console.error('[activity]', r.status, reasonOf(r))
  } catch (err) { console.error('[activity]', err.message) }
  return null
}
export async function fetchOrderActivity(orderId) {
  try {
    const r = await dataApi(`/api/orders/${encodeURIComponent(orderId)}/activity`)
    if (r.ok && r.json && Array.isArray(r.json.events)) return r.json.events.map(toActivity)
  } catch { /* unavailable */ }
  return null
}
export async function logEvent() { /* the database records activity itself */ }

// ── In-app notifications (/api/notifications) ────────────────────────────────
// -> { notifications, unread } or null when they cannot be read.
export async function fetchNotifications() {
  try {
    const r = await dataApi('/api/notifications?limit=50')
    if (r.ok && r.json && Array.isArray(r.json.notifications)) {
      return { unread: r.json.unread, notifications: r.json.notifications.map((n) => ({ ...n, time: timeLabel(n.createdAt) })) }
    }
    console.error('[notifications]', r.status, reasonOf(r))
  } catch (err) { console.error('[notifications]', err.message) }
  return null
}
// -> how many of the caller's own notifications changed; throws when refused.
export async function markNotificationsRead(ids) {
  const r = await dataApi('/api/notifications/read', { method: 'POST', body: { ids } })
  if (r.ok && r.json) return r.json.updated
  throw new Error(orderError(r, 'Not marked read'))
}
export async function markAllNotificationsRead() {
  const r = await dataApi('/api/notifications/read-all', { method: 'POST' })
  if (r.ok && r.json) return r.json.updated
  throw new Error(orderError(r, 'Not marked read'))
}

// ── Staff roster (/api/profiles: active admins) ──────────────────────────────
// { id, name, role, status } per profile -- what the assign picker and the
// owner names need.
export async function fetchProfiles() {
  try {
    const r = await dataApi('/api/profiles')
    if (r.ok && r.json && Array.isArray(r.json.profiles)) return r.json.profiles
    console.error('[fetchProfiles]', r.status, reasonOf(r))
  } catch (err) { console.error('[fetchProfiles]', err.message) }
  return null
}

// ── Server-generated order IDs ────────────────────────────────────────────────
// The API assigns the id inside the insert; there is nothing to reserve.
export async function nextOrderId() { return null }

// ── Documents (/api/orders/:id/documents, /api/documents/:id) ────────────────
// Files go to the API, which validates them and stores them in a PRIVATE bucket;
// a reference carries the server's documentId -- never a storage path or URL.
// Downloads are fetched with the ID token and opened from a local blob, so no
// credential or bucket address ever appears in a URL.
async function rawApi(path, { method = 'GET', body, contentType } = {}) {
  const fb = await firebase()
  const fbUser = fb.auth.currentUser
  if (!fbUser) throw new Error(MSG.session)
  for (let attempt = 0; attempt < 2; attempt++) {
    let token
    try {
      token = await fbUser.getIdToken(attempt === 1)
    } catch (err) {
      if (err && err.code === 'auth/network-request-failed') throw unavailable(MSG.dataDown)
      return { status: 401, ok: false, json: async () => null }
    }
    let res
    try {
      res = await fetch(`${CONFIG.apiBase}${path}`, {
        method, body, credentials: 'omit', cache: 'no-store',
        headers: { authorization: `Bearer ${token}`, ...(contentType ? { 'content-type': contentType } : {}) },
      })
    } catch {
      throw unavailable(MSG.dataDown)
    }
    if (res.status === 401 && attempt === 0) continue
    return res
  }
  return { status: 401, ok: false, json: async () => null }
}
const reasonFrom = async (res) => { const j = await res.json().catch(() => null); return j && typeof j.error === 'string' ? j.error : null }
function documentError(status, reason, verb) {
  if (status === 401) return MSG.session
  if (status === 404) return `${verb}: this document or order no longer exists or is not visible to you.`
  if (status === 413) return `${verb}: the file is larger than 25 MB.`
  if ([400, 403, 409, 415].includes(status)) return `${verb}: ${reason || 'not allowed'}.`
  if (status === 502 || status === 503) return `${verb}: ${reason || 'document storage is unavailable'}.`
  return `${verb}: the service failed (HTTP ${status}); nothing was confirmed — try again.`
}
const DOC_RE = /\.(pdf|docx?|jpe?g|png|tiff?)$/i

// -> { documentId, name, type, size } once the server has stored the file.
export async function uploadDocument(orderId, file, kind) {
  if (!kind) throw new Error('Not uploaded: the document kind is missing.')
  if (!file || !DOC_RE.test(file.name || '')) throw new Error('Not uploaded: unsupported file type.')
  if (file.size > maxDocumentBytes) throw new Error('Not uploaded: the file is larger than 25 MB.')
  if (!file.size) throw new Error('Not uploaded: the file is empty.')
  const res = await rawApi(`/api/orders/${encodeURIComponent(orderId)}/documents?${new URLSearchParams({ kind, filename: file.name })}`,
    { method: 'POST', body: file, contentType: 'application/octet-stream' })
  if (res.status === 201) {
    const d = await res.json().catch(() => null)
    if (d && d.documentId) return { documentId: d.documentId, name: d.name, type: d.type, size: d.size, url: null, path: null }
  }
  throw new Error(documentError(res.status, await reasonFrom(res), 'Not uploaded'))
}

// Remove an upload that is no longer wanted (the server decides whether it may
// still be removed). Already gone is fine.
export async function discardDocument(ref) {
  if (!ref || !ref.documentId) return
  const res = await rawApi(`/api/documents/${encodeURIComponent(ref.documentId)}`, { method: 'DELETE' })
  if (res.ok || res.status === 404) return
  throw new Error(documentError(res.status, await reasonFrom(res), 'Not removed'))
}
export async function removeDocument(ref) { return discardDocument(typeof ref === 'object' ? ref : null) }

// The documents of an order the caller may see, or null when they cannot be read.
export async function listOrderDocuments(orderId) {
  try {
    const res = await rawApi(`/api/orders/${encodeURIComponent(orderId)}/documents`)
    if (res.ok) { const j = await res.json(); return Array.isArray(j.documents) ? j.documents : null }
  } catch { /* unavailable */ }
  return null
}

// Open a stored document: PDFs and images in the reusable pop-out window, Word
// files as a download. Anything not stored by the server cannot be opened.
const DOC_WINDOW = 'resolute-doc-viewer'
export async function openDocument(ref) {
  if (!ref || !ref.documentId) {
    alert('This document has not been stored — it may still be uploading, or its upload failed.')
    return null
  }
  const inline = ref.type === 'pdf' || ref.type === 'other'
  const win = inline ? window.open('about:blank', DOC_WINDOW, 'popup,width=1000,height=800') : null
  try {
    const res = await rawApi(`/api/documents/${encodeURIComponent(ref.documentId)}/content`)
    if (!res.ok) throw new Error(documentError(res.status, await reasonFrom(res), 'The document cannot be opened'))
    const url = URL.createObjectURL(await res.blob())
    setTimeout(() => URL.revokeObjectURL(url), 120000)
    if (win) {
      win.location.href = url
    } else {
      const a = document.createElement('a')
      a.href = url; a.download = ref.name || 'document'; a.rel = 'noopener'
      document.body.appendChild(a); a.click(); a.remove()
    }
    return url
  } catch (err) {
    if (win) win.close()
    alert(err.message)
    return null
  }
}
