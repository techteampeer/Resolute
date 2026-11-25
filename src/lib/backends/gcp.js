// GCP backend provider (ADR 0002, phases B2–B5) — partly wired.
//
// Selected only when VITE_BACKEND=gcp. LIVE: Firebase Authentication
// (email/password, session restore, sign-out; the portal profile comes from the
// API's GET /api/me, never from the token) and the Admin Users screen
// (adminUsersApi). Everything else is still the stub described below, replaced
// one function at a time behind this same surface.
//
// Semantics while unwired: `isSupabaseConfigured` is false, so selecting this
// provider makes the app behave exactly like "no backend connected" (mock
// data) rather than white-screening. Reads resolve empty, writes report a
// clear not-wired error, realtime subscriptions are inert, and the handful of
// functions the app calls for their side effect only are no-ops.

const writeErr = (phase) => ({ ok: false, error: `GCP backend not wired yet (ADR 0002, ${phase})` })
const notImpl = (fn) => { throw new Error(`GCP backend not implemented yet: ${fn} — see docs/adr/0002 (B2+)`) }
const inertUnsub = () => () => {}

// The Cloud Run data API base (B2). Unset in a mock build, so apiFetch has no
// host and every call fails safe (ADR 0003 §3) rather than silently succeeding.
const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '')

// A fetch to the data API that fails SAFE: it attaches the Firebase token when
// one exists (getAccessToken is null until B3, so the request goes out
// unauthenticated and the API answers 401 — never a fake success), and throws
// the server's own error message on any non-2xx so the caller rolls back.
async function apiFetch(path, { method = 'GET', body } = {}) {
  const token = await getAccessToken()
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
  if (!res.ok) throw new Error((json && json.error) || `request failed (${res.status})`)
  return json
}

// Mirrors supabase.js's flag. False here means "the active (GCP) backend is not
// configured", so every isSupabaseConfigured guard in the app falls back to mock
// until the real provider lands. (Renaming this to isBackendConfigured app-wide
// is a later, separate cleanup — kept as-is now to stay non-breaking.)
// Sign-in does NOT key on it: on GCP authentication is always Firebase, never the
// demo accounts (backend.js hasRealAuth).
export const isSupabaseConfigured = false

// ── Firebase configuration (ported from the deployed GCP provider) ────────────
// The Firebase web config is public by design (it names the project; it is not
// a credential). No service-account key is ever read by the browser. Pure, so it
// unit-tests without a build: env (import.meta.env) -> config.
export function resolveFirebaseConfig(env = {}) {
  const problems = []
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
  return { ok: problems.length === 0, firebase, emulatorHost, problems }
}

const FB = resolveFirebaseConfig(import.meta.env)
export const isAuthConfigured = FB.ok
export const authConfigError = FB.ok ? null : `GCP sign-in is not configured: ${FB.problems.join('; ')}.`

// ── Firebase (loaded on first use) ────────────────────────────────────────────
// @firebase/app + @firebase/auth directly (what firebase/app and firebase/auth
// re-export), so the umbrella package -- and the AI SDK it bundles -- is not a
// dependency.
const APP_NAME = 'resolute-gcp'
let firebasePromise = null
function firebase() {
  if (!FB.ok) return Promise.reject(new Error(authConfigError))
  firebasePromise ??= (async () => {
    const [{ initializeApp, getApps }, sdk] = await Promise.all([import('@firebase/app'), import('@firebase/auth')])
    const app = getApps().find((a) => a.name === APP_NAME) || initializeApp(FB.firebase, APP_NAME)
    const auth = sdk.getAuth(app)
    if (FB.emulatorHost) sdk.connectAuthEmulator(auth, `http://${FB.emulatorHost}`, { disableWarnings: true })
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
      res = await fetch(`${API_BASE}${path}`, {
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
// provider's mapUser() returns. Anything but an active profile is refused; the
// role never comes from the Firebase token.
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
// The data API authenticates with the signed-in Firebase user's ID token. When
// Firebase is configured it is the token source; setIdTokenSource replaces it
// (tests, or another owner of the session). No session -> no token -> the API
// answers 401, never a fake session.
let idTokenSource = FB.ok
  ? async (forceRefresh = false) => {
    const fb = await firebase()
    return fb.auth.currentUser ? fb.auth.currentUser.getIdToken(forceRefresh) : null
  }
  : null
export function setIdTokenSource(fn) { idTokenSource = typeof fn === 'function' ? fn : null }
export async function getAccessToken(forceRefresh = false) {
  return idTokenSource ? (await idTokenSource(forceRefresh)) || null : null
}

export async function getCurrentUser() {
  if (!FB.ok) return null
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

export async function signIn(email, password) {
  if (!FB.ok) return { success: false, error: authConfigError, code: 'not_configured' }
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
  if (!FB.ok) return
  const fb = await firebase()
  await fb.sdk.signOut(fb.auth)
}

// Calls cb(user | null) when the Firebase session changes. A session whose
// profile is refused reports null; an unreachable API leaves the state alone.
export function onAuthChange(cb) {
  if (!FB.ok) return inertUnsub()
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
export function onPasswordRecovery() { return inertUnsub() }

// ── Orders ──────────────────────────────────────────────────────────────────
export async function fetchOrders() { return null }
export async function fetchOrderById() { return { row: null } }
export async function saveOrder() { return writeErr('B2') }
export async function insertOrder() { notImpl('insertOrder') }
export function subscribeOrders() { return inertUnsub() }

// ── Support messages ──────────────────────────────────────────────────────────
export async function fetchSupportMessages() { return null }
export async function insertSupportMessage() { notImpl('insertSupportMessage') }
export async function markOrderPayment() { notImpl('markOrderPayment') }
export async function cancelOrderRpc() { notImpl('cancelOrderRpc') }
export async function respondClarificationRpc() { notImpl('respondClarificationRpc') }
// B1 (wired). The owning client approves/declines a pending charge; the server
// re-checks ownership under RLS and reuses resolve_order_charge. Returns the
// fresh, app-shaped order so OrderContext replaces local state. Inert on a mock
// build (OrderContext only calls this when isSupabaseConfigured) and fail-safe
// (apiFetch throws the server's error) once B3 activates this provider.
export async function resolveOrderCharge(orderId, chargeId, decision) {
  return apiFetch(
    `/api/orders/${encodeURIComponent(orderId)}/charges/${encodeURIComponent(chargeId)}/resolve`,
    { method: 'POST', body: { decision } },
  )
}
// B1 (wired). Admin / the owning production user raises a fee for approval. The
// server generates the id and stamps raisedBy/At, so only label + amount go out.
// Not yet in the backend.js contract or OrderContext's raise path — that wiring
// lands with the B3 provider cutover (see docs/specs/B1 §9); exported now so the
// route has its client the moment the provider goes live.
export async function raiseOrderCharge(orderId, charge) {
  return apiFetch(
    `/api/orders/${encodeURIComponent(orderId)}/charges`,
    { method: 'POST', body: { label: charge?.label, amount: charge?.amount } },
  )
}
export function subscribeSupport() { return inertUnsub() }

// ── Fulfillment ───────────────────────────────────────────────────────────────
export async function fetchFulfillment() { return null }
export async function saveFulfillment() { return writeErr('B2') }

// ── Notification preferences ──────────────────────────────────────────────────
export async function fetchNotificationTypes() { return null }
export async function fetchNotificationPreferences() { return null }
export async function saveNotificationPreference() { return writeErr('B2') }
export async function clearNotificationPreference() { return writeErr('B2') }

// ── Admin users (/api/admin/users — services/api routes/adminUsers.js) ───────
// The Admin Users screen's GCP client. Accounts are created PENDING and cannot
// sign in until activated; there is no invitation, password reset or deletion
// on GCP. Every call carries the Firebase ID token; every non-2xx throws an
// Error whose .status and message are the API's own (401/403/409/502...).
// An expired ID token is the API's 401: retried ONCE with a forced token refresh;
// a second 401 (or none to refresh) is reported, never treated as success.
async function adminUsersRequest(path, { method = 'GET', body } = {}) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken(attempt === 1)
    const res = await fetch(`${API_BASE}/api/admin/users${path}`, {
      method,
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (res.status === 401 && attempt === 0 && token) continue
    const text = await res.text()
    let json = null
    try { json = text ? JSON.parse(text) : null } catch { /* non-JSON body */ }
    if (!res.ok) {
      const err = new Error((json && typeof json.error === 'string' && json.error) || `request failed (${res.status})`)
      err.status = res.status
      throw err
    }
    return json
  }
}

// API record -> the shape the Admin Users screen renders (the Supabase list
// shape: active, joined) plus status and the optimistic-lock version.
export function toAdminUserRow(r) {
  return {
    id: r.id,
    name: r.name || '',
    email: r.email || '',
    role: r.role || null,
    clientCode: r.clientCode || null,
    superAdmin: !!r.superAdmin,
    canConfirmPayments: !!r.canConfirmPayments,
    permissions: Array.isArray(r.permissions) ? r.permissions : [],
    status: r.status || null,
    active: r.status === 'active',
    joined: r.created || null,
    updatedAt: r.updatedAt || null,
    signIn: r.signIn || null,
  }
}

// The editable account fields, typed the way the API validates them. A client
// code rides only as a string or null; elevated flags only when the form set them.
function accountFields(form) {
  const out = { name: form.name || '', role: form.role, clientCode: form.clientCode ? form.clientCode : null }
  if (Array.isArray(form.permissions)) out.permissions = form.permissions
  if (typeof form.superAdmin === 'boolean') out.superAdmin = form.superAdmin
  if (typeof form.canConfirmPayments === 'boolean') out.canConfirmPayments = form.canConfirmPayments
  return out
}

const userPath = (id) => `/${encodeURIComponent(id)}`
export const adminUsersApi = {
  canRemove: false,
  canResetPassword: false,
  async list() {
    const j = await adminUsersRequest('')
    return (Array.isArray(j?.users) ? j.users : []).map(toAdminUserRow)
  },
  // -> { id, status: 'pending' }
  async create(form) {
    return adminUsersRequest('', { method: 'POST', body: { email: form.email, ...accountFields(form) } })
  },
  // Saves on the version the admin read; a stale version is the API's 409.
  async update(id, form, updatedAt) {
    if (!updatedAt) throw Object.assign(new Error('Reload the user list before editing this account.'), { status: 409 })
    return toAdminUserRow(await adminUsersRequest(userPath(id), { method: 'PATCH', body: { updatedAt, ...accountFields(form) } }))
  },
  // The Activate/Deactivate toggle: pending -> activate, inactive -> reactivate,
  // active -> deactivate (the last two on the version read).
  async setActive(user) {
    if (user.status === 'pending') return adminUsersRequest(`${userPath(user.id)}/activate`, { method: 'POST' })
    if (user.status === 'inactive') return adminUsersRequest(`${userPath(user.id)}/reactivate`, { method: 'POST', body: { updatedAt: user.updatedAt } })
    if (user.status === 'active') return adminUsersRequest(`${userPath(user.id)}/deactivate`, { method: 'POST', body: { updatedAt: user.updatedAt } })
    throw new Error(`Cannot change an account in status "${user.status}".`)
  },
}

// ── Clients ───────────────────────────────────────────────────────────────────
export async function fetchClients() { return null }
// B2 (wired). Admin match-or-create a client company by name. Returns the
// resolver's { status: 'created'|'matched'|'ambiguous', code?, name?, codes? }
// — created|matched|ambiguous are all 2xx so the UI branches on status; a 403
// (not admin) / 422 (empty name) throws fail-safe via apiFetch. Inert on a mock
// build (useClients only calls this when isSupabaseConfigured).
export async function createAdminClient(company, contact, email) {
  return apiFetch('/api/clients', {
    method: 'POST', body: { company, contact: contact || null, email: email || null },
  })
}
export async function fetchClientTerms() { return null }
export async function saveClientTerms() { /* side-effect write; no-op until B2 */ }

// ── Client contacts ───────────────────────────────────────────────────────────
export async function fetchContacts() { return null }
export async function saveContact() { return writeErr('B2') }
export async function deleteContact() { return writeErr('B2') }

// ── Client company profile ────────────────────────────────────────────────────
export async function fetchClientProfile() { return null }
export async function saveClientProfile() { return writeErr('B2') }

// ── Vendors & payouts ─────────────────────────────────────────────────────────
export async function fetchVendors() { return null }
export async function saveVendorCycle() { /* side-effect write; no-op until B2 */ }
export async function savePayoutLedger() { /* side-effect write; no-op until B2 */ }

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function fetchSubscriptions() { return null }
export async function saveSubscription() { /* side-effect write; no-op until B2 */ }

// ── Audit trail ───────────────────────────────────────────────────────────────
export async function fetchActivity() { return null }
export async function logEvent() { /* side-effect write; no-op until B2 */ }

// ── Staff roster ──────────────────────────────────────────────────────────────
export async function fetchProfiles() { return null }

// ── Server-generated order IDs ────────────────────────────────────────────────
export async function nextOrderId() { return null }

// ── Storage (documents) ───────────────────────────────────────────────────────
export async function uploadDocument() { notImpl('uploadDocument') }       // B5
export async function removeDocument() { /* no-op until B5 */ }
export async function openDocument() { return null }                       // B5
