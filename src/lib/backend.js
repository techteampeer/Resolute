// Backend data-access layer. Every function is a no-op-friendly wrapper around
// Supabase; callers should branch on `isSupabaseConfigured` (re-exported here)
// and fall back to mock state when it's false.
import { supabase, isSupabaseConfigured } from './supabase'

export { isSupabaseConfigured }

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
  assignedUserId: r.assigned_user_id || null,   // F1: the specific production owner
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
  assigned_user_id: o.assignedUserId ?? null,   // F1: the specific production owner
  screener: o.screener, examiner: o.examiner, typer: o.typer, delivery: o.delivery,
  progress: o.progress, eta: dateOrNull(o.eta), completed: dateOrNull(o.completed),
  completed_dates: o.completedDates, completed_by: o.completedBy,
  workflow: o.workflow || {},
})

const mapUser = (authUser, prof) => ({
  // profiles.id is the auth user's id. The Notifications screen writes
  // notification_preferences.profile_id with it, and RLS checks it against
  // auth.uid(), so a wrong value is refused rather than misfiled.
  id: prof?.id || authUser.id || null,
  email: authUser.email,
  role: prof?.role || null,        // null when no profile/role — caller must handle, never silently 'client'
  name: prof?.name || authUser.email,
  avatar: initials(prof?.name || authUser.email),
  superAdmin: !!prof?.super_admin,
  clientCode: prof?.client_code || null,
  // Whether this account may confirm money (client payments, vendor payouts,
  // subscriptions). Held by the billing owner only, and enforced by database
  // triggers as well — this is just what the UI hides behind.
  canConfirmPayments: !!prof?.can_confirm_payments,
})

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function getCurrentUser() {
  const { data: { session } } = await supabase.auth.getSession()
  if (!session) return null
  const { data: prof } = await supabase.from('profiles').select('*').eq('id', session.user.id).maybeSingle()
  return mapUser(session.user, prof)
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) {
    // Surface the real reason even when GoTrue's message is empty — include the
    // error code and HTTP status so misconfig (wrong project, disabled email
    // logins, unconfirmed email) is diagnosable from the UI, not just "invalid".
    const detail = [error.message, error.code, error.status ? `HTTP ${error.status}` : '']
      .map(s => (s || '').toString().trim()).filter(Boolean).join(' · ')
    return { success: false, error: detail || 'Authentication failed', code: error.code, status: error.status }
  }
  const user = await getCurrentUser()
  return { success: true, role: user?.role, user }
}

export const signOut = () => supabase.auth.signOut()

export function onAuthChange(cb) {
  const { data } = supabase.auth.onAuthStateChange(async () => { cb(await getCurrentUser()) })
  return () => data.subscription.unsubscribe()
}

// ── Orders ─────────────────────────────────────────────────────────────────
export async function fetchOrders() {
  const { data, error } = await supabase.from('orders').select('*, clients(name)').order('created', { ascending: false })
  if (error) { console.error('[orders]', error.message); return null }
  return data.map(toAppOrder)
}

// One order by id, with the same client-name join fetchOrders() uses. Backs the
// delta-realtime path: a change event fetches only the row that changed instead
// of re-reading the whole table. RLS-scoped like every read — an order the
// caller may not see resolves to `{ row: null }`, so this never leaks a row the
// full fetch would have hidden. Returns a DISCRIMINATED result: `{ row }` on a
// real answer (row may be null = genuinely absent/hidden) vs `{ error }` on a
// transient failure — so the caller never mistakes a network blip for a delete.
export async function fetchOrderById(id) {
  const { data, error } = await supabase.from('orders').select('*, clients(name)').eq('id', id).maybeSingle()
  if (error) { console.error('[order]', error.message); return { error: error.message } }
  return { row: data ? toAppOrder(data) : null }
}

// Returns { ok, error }. An RLS-filtered UPDATE is not an error in PostgREST —
// it matches zero rows and returns 200 — so "did anything change?" has to be
// answered by asking for the affected rows back. Without this the app could not
// tell a refused write from a successful one, and reported success either way.
// Postgres' own words for a refused write ("new row violates row-level security
// policy for table \"fulfillments\"") are exact and useless to a typer. Keep them
// in the console for diagnosis; put a sentence on the screen.
const refusalText = (msg, subject) =>
  /row-level security|permission denied|insufficient privilege/i.test(msg || '')
    ? `the database refused the change (${subject})`
    : (msg || 'not saved')

export async function saveOrder(order) {
  const { data, error } = await supabase.from('orders')
    .update(toOrderRow(order)).eq('id', order.id).select('id')
  if (error) {
    console.error('[saveOrder]', error.message)
    return { ok: false, error: refusalText(error.message, 'you may no longer own this order') }
  }
  if (!data || data.length === 0) {
    const msg = 'the database refused the change (you may no longer own this order)'
    console.error('[saveOrder]', msg)
    return { ok: false, error: msg }
  }
  return { ok: true }
}

// Insert a new order (client-placed or staff). RLS: orders_insert_client lets a
// client insert for their own client_code; staff/admin policies cover the rest.
// Throws on failure so the caller (createOrder) can surface it rather than
// leaving a phantom order that exists only in local state.
export async function insertOrder(order) {
  const { error } = await supabase.from('orders').insert({
    id: order.id, client_code: order.clientCode || null,
    state: order.state, county: order.county, type: order.type,
    created: dateOrNull(order.created), ...toOrderRow(order),
  })
  if (error) { console.error('[insertOrder]', error.message); throw error }
}

// `onStatus` receives the channel lifecycle status ('SUBSCRIBED', 'CHANNEL_ERROR',
// 'TIMED_OUT', 'CLOSED'). Callers that need to avoid a hydration race start their
// snapshot only once the channel is actually SUBSCRIBED — before that, postgres
// changes are not yet delivered, so a change in that window would be lost.
export function subscribeOrders(cb, onStatus) {
  const channel = supabase.channel('orders-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, cb)
    .subscribe((status) => { onStatus?.(status) })
  return () => supabase.removeChannel(channel)
}

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
  const { data, error } = await supabase.from('support_messages').select('*').order('created_at', { ascending: true })
  if (error) { console.error('[fetchSupportMessages]', error.message); return null }
  return data.map(toSupportMsg)
}

// RLS gates this: clients may only write sender='client'/visibility='client';
// admins may reply to clients; every other staff role may write internal notes
// only. A rejected insert throws so the caller can surface it.
export async function insertSupportMessage({ clientCode, sender, author, body, orderId = null, attachment = null, visibility = 'client' }) {
  const { error } = await supabase.from('support_messages').insert({ client_code: clientCode, sender, author: author || null, body, order_id: orderId, attachment, visibility })
  if (error) { console.error('[insertSupportMessage]', error.message); throw error }
}

// Client marks an invoice paid via the narrow SECURITY DEFINER RPC (clients
// have no UPDATE on orders). Staff confirm/bounce through the normal saveOrder.
export async function markOrderPayment(orderId, payment) {
  const { error } = await supabase.rpc('client_mark_payment', { p_order_id: orderId, p_payment: payment })
  if (error) { console.error('[markOrderPayment]', error.message); throw error }
}

// Client cancels (or requests cancellation of) their own order via a SECURITY
// DEFINER RPC — same reason as payments (no client UPDATE on orders). The RPC
// also records the order_events row so Admin is notified. Returns the resulting
// mode: 'cancelled' (was still queued) or 'requested' (needs Admin approval).
export async function cancelOrderRpc(orderId) {
  const { data, error } = await supabase.rpc('client_cancel_order', { p_order_id: orderId })
  if (error) { console.error('[cancelOrderRpc]', error.message); throw error }
  return data
}

// Client marks a pending clarification as responded (own order; RLS-safe RPC).
export async function respondClarificationRpc(orderId) {
  const { error } = await supabase.rpc('client_respond_clarification', { p_order_id: orderId })
  if (error) { console.error('[respondClarificationRpc]', error.message); throw error }
}

export function subscribeSupport(cb) {
  const channel = supabase.channel('support-rt')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'support_messages' }, cb)
    .subscribe()
  return () => supabase.removeChannel(channel)
}

// ── Fulfillment (JSONB document) ─────────────────────────────────────────────
export async function fetchFulfillment(orderId) {
  const { data, error } = await supabase.from('fulfillments').select('data').eq('order_id', orderId).maybeSingle()
  if (error) { console.error('[fetchFulfillment]', error.message); return null }
  return data?.data || null
}

// Returns { ok, error }. Same reasoning as saveOrder: a refused write comes back
// as 200 with no rows, and this is the path a typer spends an hour filling in —
// the autosave badge used to say "Saved" on a timer whether or not the row moved.
export async function saveFulfillment(orderId, data) {
  const { data: rows, error } = await supabase.from('fulfillments')
    .upsert({ order_id: orderId, data, updated_at: new Date().toISOString() })
    .select('order_id')
  if (error) {
    console.error('[saveFulfillment]', error.message)
    return { ok: false, error: refusalText(error.message, 'this order may not be on your desk') }
  }
  if (!rows || rows.length === 0) {
    const msg = 'the database refused the change (this order may not be on your desk)'
    console.error('[saveFulfillment]', msg)
    return { ok: false, error: msg }
  }
  return { ok: true }
}

// ── Notification preferences ─────────────────────────────────────────────────
// notification_types is the catalogue (what exists, who it can reach, and the
// mode used when someone has expressed no preference); notification_preferences
// holds one row per person per type, and only when they have chosen something.
// No row means "the type's default", which is why turning a preference off again
// deletes the row instead of writing the default into it.
export async function fetchNotificationTypes() {
  const { data, error } = await supabase
    .from('notification_types')
    .select('key,label,description,default_roles,default_mode,sort_order')
    .order('sort_order')
  if (error) { console.error('[notificationTypes]', error.message); return null }
  return data
}

// RLS (notif_pref_own_read) scopes this to the caller, so no filter is needed —
// but an admin may read everyone's, hence the explicit profile filter.
export async function fetchNotificationPreferences(profileId) {
  let q = supabase.from('notification_preferences').select('type_key,mode,updated_at')
  if (profileId) q = q.eq('profile_id', profileId)
  const { data, error } = await q
  if (error) { console.error('[notificationPreferences]', error.message); return null }
  return data
}

// Returns { ok, error } like the other writes: an RLS refusal comes back as 200
// with no rows, and a settings toggle that silently does nothing is worse than
// one that says why.
export async function saveNotificationPreference(profileId, typeKey, mode) {
  if (!profileId) return { ok: false, error: 'your profile is not linked to a login yet' }
  const { data, error } = await supabase
    .from('notification_preferences')
    .upsert({ profile_id: profileId, type_key: typeKey, mode, updated_at: new Date().toISOString() })
    .select('type_key')
  if (error) {
    console.error('[saveNotificationPreference]', error.message)
    return { ok: false, error: refusalText(error.message, 'you may only change your own preferences') }
  }
  if (!data || data.length === 0) {
    const msg = 'the database refused the change (you may only change your own preferences)'
    console.error('[saveNotificationPreference]', msg)
    return { ok: false, error: msg }
  }
  return { ok: true }
}

// Back to the type's default: remove the row rather than store a copy of the
// default, so a later change to the default follows the person automatically.
export async function clearNotificationPreference(profileId, typeKey) {
  if (!profileId) return { ok: false, error: 'your profile is not linked to a login yet' }
  const { error } = await supabase
    .from('notification_preferences')
    .delete().eq('profile_id', profileId).eq('type_key', typeKey)
  if (error) {
    console.error('[clearNotificationPreference]', error.message)
    return { ok: false, error: refusalText(error.message, 'you may only change your own preferences') }
  }
  return { ok: true }
}

// ── Client registry ───────────────────────────────────────────────────────────
// Every client Resolute works with. clients_read lets any staff member read it;
// a client account sees only its own row (RLS), which is all it needs.
// Two sources, because the name is PII. 20260909120000 restricted
// public.clients to super admins and added public.client_directory — the same
// list with code, terms, activity and registration date only. Ask for both: a
// super admin's `clients` read returns names, everyone else's returns nothing
// and the directory still supplies the codes. Rows merge by code, so a caller
// who may not see a name simply does not get one.
export async function fetchClients() {
  const [dir, pii] = await Promise.all([
    supabase.from('client_directory').select('code,payment_terms,activity,registered').order('code'),
    supabase.from('clients').select('code,name,contact,email,phone,registered,activity,payment,payment_terms').order('code'),
  ])
  if (dir.error && pii.error) {
    console.error('[fetchClients]', dir.error.message, '|', pii.error.message)
    return null
  }
  if (dir.error) console.error('[fetchClients] directory:', dir.error.message)
  const byCode = new Map()
  for (const r of dir.data || []) byCode.set(r.code, { ...r })
  for (const r of pii.data || []) byCode.set(r.code, { ...(byCode.get(r.code) || {}), ...r })
  return [...byCode.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)))
}

// ── Client payment terms ──────────────────────────────────────────────────────
export async function fetchClientTerms() {
  // From the directory, not the table: clients_read is super-admin-only since
  // 20260909120000, so reading payment_terms off `clients` returned nothing for
  // a plain admin and every client on the billing page silently fell back to
  // "per order". client_directory carries the same column for all staff.
  const { data, error } = await supabase.from('client_directory').select('code, payment_terms')
  if (error) { console.error('[terms]', error.message); return null }
  return Object.fromEntries(data.map(r => [r.code, r.payment_terms || 'per_order']))
}

export async function saveClientTerms(code, termKey) {
  const { error } = await supabase.from('clients').update({ payment_terms: termKey }).eq('code', code)
  if (error) console.error('[terms]', error.message)
}

// ── Vendors & payout ledger ───────────────────────────────────────────────────
export async function fetchVendors() {
  const { data, error } = await supabase.from('vendors').select('*').order('code')
  if (error) { console.error('[vendors]', error.message); return null }
  return data.map(r => ({ code: r.code, name: r.name, contact: r.contact, coverage: r.coverage, cycle: r.cycle }))
}

export async function saveVendorCycle(code, cycle) {
  const { error } = await supabase.from('vendors').update({ cycle }).eq('code', code)
  if (error) console.error('[vendorCycle]', error.message)
}

// Durable financial record mirroring order.workflow.abstractorFee (which stays
// authoritative for the UI). Upsert keyed by order — one payable per order.
export async function savePayoutLedger(orderId, payout) {
  const { error } = await supabase.from('vendor_payouts').upsert({
    order_id: orderId, vendor_code: payout.vendor, amount: payout.amount,
    status: payout.status, set_by: payout.setBy || null, set_at: payout.setAt || null,
    paid_by: payout.paidBy || null, paid_at: payout.paidAt || null,
    reference: payout.reference || null,
  }, { onConflict: 'order_id' })
  if (error) console.error('[payoutLedger]', error.message)
}

// ── Subscriptions ─────────────────────────────────────────────────────────────
export async function fetchSubscriptions() {
  const { data, error } = await supabase.from('subscriptions').select('*').order('id')
  if (error) { console.error('[subscriptions]', error.message); return null }
  return data.map(r => ({ id: r.id, name: r.name, amount: Number(r.amount), cycle: r.cycle, lastPaidAt: r.last_paid_at, paidBy: r.paid_by }))
}

export async function saveSubscription(s) {
  const { error } = await supabase.from('subscriptions').upsert({
    id: s.id, name: s.name, amount: s.amount, cycle: s.cycle,
    last_paid_at: s.lastPaidAt, paid_by: s.paidBy,
  })
  if (error) console.error('[subscription]', error.message)
}

// ── Audit trail (append-only order_events) ────────────────────────────────────
export async function fetchActivity(limit = 50) {
  const { data, error } = await supabase.from('order_events')
    .select('*').order('created_at', { ascending: false }).limit(limit)
  if (error) { console.error('[activity]', error.message); return null }
  return data.map(r => ({
    id: r.id, action: r.action, type: r.type,
    time: new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }),
  }))
}

// `audience` decides who the event is for: 'staff' (internal routing),
// 'client' (client-facing), or 'all'. It gates client visibility in RLS
// (order_events_client_read) — without it a client sees none of their own
// order history — so it outlived the email system it was first added for.
// actorEmail is what stops someone being notified about their own action — the
// fan-out trigger excludes it. Distinct from `actor`, which is a display name.
export async function logEvent({ orderId = null, action, type = 'status', actor = null, actorEmail = null, audience = 'staff' }) {
  const { error } = await supabase.from('order_events').insert({ order_id: orderId, action, type, actor, actor_email: actorEmail, audience })
  if (error) console.error('[logEvent]', error.message)
}

// ── Staff roster ─────────────────────────────────────────────────────────────
// The real people who can be assigned work. Admin's Assign modal used to offer
// mockData's USERS fixture, which contains six staff with no profiles row and no
// login — so an order could be assigned to someone who does not exist, and the
// row recorded their name. profiles_read lets any staff member read the roster.
export async function fetchProfiles() {
  const { data, error } = await supabase
    .from('profiles')
    .select('id,name,email,role,super_admin,client_code,status,can_confirm_payments')
    .order('name')
  if (error) { console.error('[fetchProfiles]', error.message); return null }
  return data
}

// ── Server-generated order IDs ────────────────────────────────────────────────
export async function nextOrderId() {
  const { data, error } = await supabase.rpc('next_order_id')
  if (error) { console.error('[nextOrderId]', error.message); return null }
  return data
}

// ── Storage (documents bucket) ────────────────────────────────────────────────
export async function uploadDocument(orderId, file) {
  const safe = file.name.replace(/[^\w.-]+/g, '_')
  const path = `orders/${orderId}/${Date.now()}-${safe}`
  const { error } = await supabase.storage.from('documents').upload(path, file)
  if (error) throw error
  const { data } = await supabase.storage.from('documents').createSignedUrl(path, 3600)
  return { path, url: data?.signedUrl || null }
}

export async function removeDocument(path) {
  if (!path) return
  await supabase.storage.from('documents').remove([path])
}

// Open a stored document reference in a new tab. The `documents` bucket is
// PRIVATE, so signed URLs expire (1h) — persisting one into JSONB and reusing
// it later fails once an order moves between stages/portals (which is why
// attachments stopped opening everywhere). We keep the durable storage `path`
// and re-sign it on demand here; the stored `url` is only a fallback (e.g.
// mock-mode blob URLs). The tab is opened synchronously first so the async
// re-sign doesn't trip the browser's popup blocker.
export async function openDocument(ref) {
  if (!ref) return null
  const canResign = isSupabaseConfigured && supabase && !!ref.path
  if (!canResign && !ref.url) {
    alert('This document isn’t available to open — it may still be uploading, or was attached in a local session that wasn’t persisted.')
    return null
  }
  const win = window.open('about:blank', '_blank')
  let url = ref.url || null
  if (canResign) {
    try {
      const { data } = await supabase.storage.from('documents').createSignedUrl(ref.path, 3600)
      if (data?.signedUrl) url = data.signedUrl
    } catch { /* fall back to any stored url */ }
  }
  if (!win) return url            // popup blocked — nothing more we can do
  if (url) win.location.href = url
  else win.close()
  return url
}
