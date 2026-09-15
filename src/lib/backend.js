// Backend data-access layer. Every function is a no-op-friendly wrapper around
// the portal's own API (server/); callers should branch on
// `isBackendConfigured` (re-exported here) and fall back to mock state when
// it's false.
//
// This used to wrap the Supabase client directly from the browser, with RLS as
// the only boundary. The database now lives in Cloud SQL, which a browser
// cannot reach, so the same calls go over HTTP to server/ — which holds the
// connection, verifies the Firebase session and injects the caller's id so the
// same RLS policies still decide every row.
import { api, ApiError, isBackendConfigured } from './api'

export { isBackendConfigured }

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'

// ── Mappers: DB row ↔ app (mock) shape ──────────────────────────────────────
const toAppOrder = (r) => ({
  id: r.id,
  client: r.clients?.name || r.client_code,
  clientCode: r.client_code,
  state: r.state, county: r.county, type: r.type,
  status: r.status, priority: r.priority, payment: r.payment,
  clarification: r.clarification,
  clientFileNo: r.client_file_no,
  assignedTo: r.assigned_to,
  screener: r.screener, examiner: r.examiner, typer: r.typer, delivery: r.delivery,
  progress: r.progress,
  created: r.created, eta: r.eta, completed: r.completed,
  completedDates: r.completed_dates || {},
  completedBy: r.completed_by || {},
  workflow: r.workflow || {},
})

// Date columns (eta/completed/created) reject '' — an empty string is not valid
// date syntax (Postgres 22007). Coerce blanks to null so client-placed orders
// (which have no ETA yet) and admin edits persist instead of silently 400-ing.
const dateOrNull = (v) => (v ? v : null)
const toOrderRow = (o) => ({
  status: o.status, priority: o.priority, payment: o.payment, clarification: o.clarification,
  client_file_no: o.clientFileNo || null,
  assigned_to: o.assignedTo,
  screener: o.screener, examiner: o.examiner, typer: o.typer, delivery: o.delivery,
  progress: o.progress, eta: dateOrNull(o.eta), completed: dateOrNull(o.completed),
  completed_dates: o.completedDates, completed_by: o.completedBy,
  workflow: o.workflow || {},
})

const mapUser = (u) => ({
  // profiles.id, which is what notification_preferences.profile_id is written
  // with and what the server injects as auth.uid() — so a wrong value here is
  // refused by RLS rather than misfiled.
  id: u.id,
  email: u.email,
  role: u.role || null,        // null when no profile/role — caller must handle, never silently 'client'
  name: u.name || u.email,
  avatar: initials(u.name || u.email),
  superAdmin: !!u.superAdmin,
  clientCode: u.clientCode || null,
  // Whether this account may confirm money (client payments, vendor payouts,
  // subscriptions). Held by the billing owner only, and enforced by database
  // triggers as well — this is just what the UI hides behind.
  canConfirmPayments: !!u.canConfirmPayments,
})

// ── Auth ─────────────────────────────────────────────────────────────────────
// The session is an httpOnly cookie, so there is nothing to read here and no
// token in reachable JavaScript. Sign-in state changes are local events.
const authListeners = new Set()
const notifyAuth = (user) => authListeners.forEach(fn => fn(user))

export async function getCurrentUser() {
  try {
    const { user } = await api.get('/auth/me')
    return user ? mapUser(user) : null
  } catch (err) {
    // 401 is the ordinary "not signed in" answer, not a fault.
    if (err instanceof ApiError && err.status === 401) return null
    console.error('[getCurrentUser]', err.message)
    return null
  }
}

export async function signIn(email, password) {
  try {
    const { user } = await api.post('/auth/login', { email, password })
    const mapped = mapUser(user)
    notifyAuth(mapped)
    return { success: true, role: mapped.role, user: mapped }
  } catch (err) {
    const status = err instanceof ApiError ? err.status : undefined
    return { success: false, error: err.message || 'Authentication failed', status }
  }
}

export async function signOut() {
  try { await api.post('/auth/logout') } finally { notifyAuth(null) }
}

/** Ask the server to email a password-reset link. */
export async function requestPasswordReset(email) {
  try { await api.post('/auth/reset', { email }) } catch { /* always reports success */ }
}

export function onAuthChange(cb) {
  authListeners.add(cb)
  return () => authListeners.delete(cb)
}

// ── Orders ─────────────────────────────────────────────────────────────────
export async function fetchOrders() {
  try {
    return (await api.get('/orders')).map(toAppOrder)
  } catch (err) { console.error('[orders]', err.message); return null }
}

// Returns { ok, error }. A write the database refuses is not an error at the
// transport level — the UPDATE simply matches zero rows and succeeds — so "did
// anything change?" has to be answered by the server counting affected rows.
// Without that the app could not tell a refused write from a saved one, and
// reported success either way. The server phrases the refusal; Postgres' own
// words ("new row violates row-level security policy for table
// \"fulfillments\"") are exact and useless to a typer.
export async function saveOrder(order) {
  try {
    return await api.patch(`/orders/${encodeURIComponent(order.id)}`, toOrderRow(order))
  } catch (err) {
    console.error('[saveOrder]', err.message)
    return { ok: false, error: err.message || 'not saved' }
  }
}

// Insert a new order (client-placed or staff). RLS: orders_insert_client lets a
// client insert for their own client_code; staff/admin policies cover the rest.
// Throws on failure so the caller (createOrder) can surface it rather than
// leaving a phantom order that exists only in local state.
export async function insertOrder(order) {
  await api.post('/orders', {
    id: order.id, client_code: order.clientCode || null,
    state: order.state, county: order.county, type: order.type,
    created: dateOrNull(order.created), ...toOrderRow(order),
  })
}

// Supabase Realtime is gone with Supabase. The server turns Postgres
// LISTEN/NOTIFY into Server-Sent Events, which is all this ever needed: both
// callbacks only ever refetched. The payload carries a table name and a row id,
// never row data — every listener receives every message, so anything else
// would leak across clients.
function subscribeTable(table, cb) {
  if (!isBackendConfigured) return () => {}
  let es
  try { es = api.stream('/events/stream') } catch { return () => {} }
  es.onmessage = (e) => {
    try { if (JSON.parse(e.data)?.table === table) cb() } catch { /* ignore malformed frame */ }
  }
  // EventSource reconnects on its own; log once rather than on every retry.
  es.onerror = () => { if (es.readyState === EventSource.CLOSED) console.warn(`[realtime] ${table} stream closed`) }
  return () => es.close()
}

export const subscribeOrders = (cb) => subscribeTable('orders', cb)

// ── Support messages (client ⇄ admin inbox) ──────────────────────────────────
const toSupportMsg = (r) => ({
  id: r.id, clientCode: r.client_code, orderId: r.order_id || null, from: r.sender, author: r.author, body: r.body,
  attachment: r.attachment || null,
  // 'client' = part of the client conversation; 'internal' = staff-only note
  // (RLS hides these from clients entirely).
  visibility: r.visibility || 'client',
  at: new Date(r.created_at).getTime(),
  time: new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
})

// RLS returns only the caller's own thread (client) or every thread (staff).
export async function fetchSupportMessages() {
  try {
    return (await api.get('/support-messages')).map(toSupportMsg)
  } catch (err) { console.error('[fetchSupportMessages]', err.message); return null }
}

// RLS gates this: clients may only write sender='client'/visibility='client';
// admins may reply to clients; every other staff role may write internal notes
// only. A rejected insert throws so the caller can surface it.
export async function insertSupportMessage({ clientCode, sender, author, body, orderId = null, attachment = null, visibility = 'client' }) {
  await api.post('/support-messages', { clientCode, sender, author, body, orderId, attachment, visibility })
}

// Client marks an invoice paid via the narrow SECURITY DEFINER RPC (clients
// have no UPDATE on orders). Staff confirm/bounce through the normal saveOrder.
export async function markOrderPayment(orderId, payment) {
  await api.post(`/orders/${encodeURIComponent(orderId)}/payment`, { payment })
}

// Client cancels (or requests cancellation of) their own order via a SECURITY
// DEFINER RPC — same reason as payments (no client UPDATE on orders). The RPC
// also records the order_events row so Admin is notified. Returns the resulting
// mode: 'cancelled' (was still queued) or 'requested' (needs Admin approval).
export async function cancelOrderRpc(orderId) {
  return (await api.post(`/orders/${encodeURIComponent(orderId)}/cancel`))?.mode ?? null
}

// Client marks a pending clarification as responded (own order; RLS-safe RPC).
export async function respondClarificationRpc(orderId) {
  await api.post(`/orders/${encodeURIComponent(orderId)}/clarification`)
}

export const subscribeSupport = (cb) => subscribeTable('support_messages', cb)

// ── Fulfillment (JSONB document) ─────────────────────────────────────────────
export async function fetchFulfillment(orderId) {
  try {
    return await api.get(`/fulfillments/${encodeURIComponent(orderId)}`)
  } catch (err) { console.error('[fetchFulfillment]', err.message); return null }
}

// Returns { ok, error }. Same reasoning as saveOrder, and this is the path a
// typer spends an hour filling in — the autosave badge used to say "Saved" on a
// timer whether or not the row moved.
export async function saveFulfillment(orderId, data) {
  try {
    return await api.put(`/fulfillments/${encodeURIComponent(orderId)}`, data)
  } catch (err) {
    console.error('[saveFulfillment]', err.message)
    return { ok: false, error: err.message || 'not saved' }
  }
}

// ── Notification preferences ─────────────────────────────────────────────────
// notification_types is the catalogue (what exists, who it can reach, and the
// mode used when someone has expressed no preference); notification_preferences
// holds one row per person per type, and only when they have chosen something.
// No row means "the type's default", which is why turning a preference off again
// deletes the row instead of writing the default into it.
export async function fetchNotificationTypes() {
  try { return await api.get('/notification-types') }
  catch (err) { console.error('[notificationTypes]', err.message); return null }
}

// RLS (notif_pref_own_read) scopes this to the caller, so no filter is needed —
// but an admin may read everyone's, hence the explicit profile filter.
export async function fetchNotificationPreferences(profileId) {
  try {
    return await api.get(`/notification-preferences${profileId ? `?profileId=${encodeURIComponent(profileId)}` : ''}`)
  } catch (err) { console.error('[notificationPreferences]', err.message); return null }
}

// Returns { ok, error } like the other writes: a settings toggle that silently
// does nothing is worse than one that says why.
export async function saveNotificationPreference(profileId, typeKey, mode) {
  if (!profileId) return { ok: false, error: 'your profile is not linked to a login yet' }
  try { return await api.put('/notification-preferences', { profileId, typeKey, mode }) }
  catch (err) {
    console.error('[saveNotificationPreference]', err.message)
    return { ok: false, error: err.message || 'not saved' }
  }
}

// Back to the type's default: remove the row rather than store a copy of the
// default, so a later change to the default follows the person automatically.
export async function clearNotificationPreference(profileId, typeKey) {
  if (!profileId) return { ok: false, error: 'your profile is not linked to a login yet' }
  try { return await api.del('/notification-preferences', { profileId, typeKey }) }
  catch (err) {
    console.error('[clearNotificationPreference]', err.message)
    return { ok: false, error: err.message || 'not saved' }
  }
}

// ── Client registry ───────────────────────────────────────────────────────────
// Two sources, merged server-side, because the name is PII: 20260909120000
// restricted public.clients to super admins and added public.client_directory —
// the same list with code, terms, activity and registration date only. A caller
// who may not see a name simply does not get one.
export async function fetchClients() {
  try { return await api.get('/clients') }
  catch (err) { console.error('[fetchClients]', err.message); return null }
}

// ── Client payment terms ──────────────────────────────────────────────────────
export async function fetchClientTerms() {
  try { return await api.get('/client-terms') }
  catch (err) { console.error('[terms]', err.message); return null }
}

export async function saveClientTerms(code, termKey) {
  try { await api.patch(`/clients/${encodeURIComponent(code)}/terms`, { termKey }) }
  catch (err) { console.error('[terms]', err.message) }
}

// ── Vendors & payout ledger ───────────────────────────────────────────────────
export async function fetchVendors() {
  try {
    return (await api.get('/vendors')).map(r => ({ code: r.code, name: r.name, contact: r.contact, coverage: r.coverage, cycle: r.cycle }))
  } catch (err) { console.error('[vendors]', err.message); return null }
}

export async function saveVendorCycle(code, cycle) {
  try { await api.patch(`/vendors/${encodeURIComponent(code)}/cycle`, { cycle }) }
  catch (err) { console.error('[vendorCycle]', err.message) }
}

// Durable financial record mirroring order.workflow.abstractorFee (which stays
// authoritative for the UI). One payable per order.
export async function savePayoutLedger(orderId, payout) {
  try { await api.put(`/payouts/${encodeURIComponent(orderId)}`, payout) }
  catch (err) { console.error('[payoutLedger]', err.message) }
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function fetchSubscriptions() {
  try {
    return (await api.get('/subscriptions')).map(r => ({ id: r.id, name: r.name, amount: Number(r.amount), cycle: r.cycle, lastPaidAt: r.last_paid_at, paidBy: r.paid_by }))
  } catch (err) { console.error('[subscriptions]', err.message); return null }
}

export async function saveSubscription(s) {
  try { await api.put('/subscriptions', s) }
  catch (err) { console.error('[subscription]', err.message) }
}

// ── Audit trail (append-only order_events) ────────────────────────────────────
export async function fetchActivity(limit = 50) {
  try {
    return (await api.get(`/activity?limit=${limit}`)).map(r => ({
      id: r.id, action: r.action, type: r.type,
      time: new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
    }))
  } catch (err) { console.error('[activity]', err.message); return null }
}

// `audience` decides who the event is for: 'staff' (internal routing),
// 'client' (client-facing), or 'all'. It gates client visibility in RLS
// (order_events_client_read) — without it a client sees none of their own
// order history. actorEmail is what stops someone being notified about their
// own action — the fan-out trigger excludes it. Distinct from `actor`, which is
// a display name.
export async function logEvent({ orderId = null, action, type = 'status', actor = null, actorEmail = null, audience = 'staff' }) {
  try { await api.post('/events', { orderId, action, type, actor, actorEmail, audience }) }
  catch (err) { console.error('[logEvent]', err.message) }
}

// ── Staff roster ─────────────────────────────────────────────────────────────
// The real people who can be assigned work. Admin's Assign modal used to offer
// mockData's USERS fixture, which contains six staff with no profile and no
// login — so an order could be assigned to someone who does not exist.
export async function fetchProfiles() {
  try { return await api.get('/profiles') }
  catch (err) { console.error('[fetchProfiles]', err.message); return null }
}

// ── Server-generated order IDs ────────────────────────────────────────────────
export async function nextOrderId() {
  try { return (await api.get('/next-order-id'))?.id ?? null }
  catch (err) { console.error('[nextOrderId]', err.message); return null }
}

// ── Storage (Cloud Storage, via the server) ──────────────────────────────────
// The bucket is private and the browser holds no credential for it: the server
// checks that the caller may see the owning order, then mints a short-lived
// signed URL. A signed URL is a bearer token, which is why it is never minted
// without that check and never stored for reuse.
export async function uploadDocument(orderId, file) {
  const form = new FormData()
  form.append('orderId', orderId)
  form.append('file', file)
  return await api.upload('/documents', form)   // { path, url }
}

export async function removeDocument(path) {
  if (!path) return
  try { await api.del('/documents', { path }) }
  catch (err) { console.error('[removeDocument]', err.message) }
}

// Open a stored document reference in a new tab. Signed URLs expire (1h), so a
// URL persisted into JSONB stops working once an order moves between stages —
// which is why attachments stopped opening everywhere. Keep the durable `path`
// and re-sign on demand; the stored `url` is only a fallback (e.g. mock-mode
// blob URLs). The tab is opened synchronously first so the async re-sign does
// not trip the browser's popup blocker.
export async function openDocument(ref) {
  if (!ref) return null
  const canResign = isBackendConfigured && !!ref.path
  if (!canResign && !ref.url) {
    alert('This document isn’t available to open — it may still be uploading, or was attached in a local session that wasn’t persisted.')
    return null
  }
  const win = window.open('about:blank', '_blank')
  let url = ref.url || null
  if (canResign) {
    try {
      const signed = await api.post('/documents/sign', { path: ref.path })
      if (signed?.url) url = signed.url
    } catch { /* fall back to any stored url */ }
  }
  if (!win) return url            // popup blocked — nothing more we can do
  if (url) win.location.href = url
  else win.close()
  return url
}
