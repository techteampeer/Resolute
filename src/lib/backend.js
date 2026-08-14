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
  assigned_to: o.assignedTo,
  screener: o.screener, examiner: o.examiner, typer: o.typer, delivery: o.delivery,
  progress: o.progress, eta: dateOrNull(o.eta), completed: dateOrNull(o.completed),
  completed_dates: o.completedDates, completed_by: o.completedBy,
  workflow: o.workflow || {},
})

const mapUser = (authUser, prof) => ({
  email: authUser.email,
  role: prof?.role || null,        // null when no profile/role — caller must handle, never silently 'client'
  name: prof?.name || authUser.email,
  avatar: initials(prof?.name || authUser.email),
  superAdmin: !!prof?.super_admin,
  clientCode: prof?.client_code || null,
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

export async function saveOrder(order) {
  const { error } = await supabase.from('orders').update(toOrderRow(order)).eq('id', order.id)
  if (error) console.error('[saveOrder]', error.message)
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

export function subscribeOrders(cb) {
  const channel = supabase.channel('orders-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, cb)
    .subscribe()
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

export async function saveFulfillment(orderId, data) {
  const { error } = await supabase.from('fulfillments').upsert({ order_id: orderId, data, updated_at: new Date().toISOString() })
  if (error) console.error('[saveFulfillment]', error.message)
}

// ── Client payment terms ──────────────────────────────────────────────────────
export async function fetchClientTerms() {
  const { data, error } = await supabase.from('clients').select('code, payment_terms')
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
export async function logEvent({ orderId = null, action, type = 'status', actor = null, audience = 'staff' }) {
  const { error } = await supabase.from('order_events').insert({ order_id: orderId, action, type, actor, audience })
  if (error) console.error('[logEvent]', error.message)
}

// ── Server-generated order IDs ────────────────────────────────────────────────
export async function nextOrderId() {
  const { data, error } = await supabase.rpc('next_order_id')
  if (error) { console.error('[nextOrderId]', error.message); return null }
  return data
}

// ── Storage (documents bucket) ────────────────────────────────────────────────
export async function uploadDocument(orderId, file) {
  const safe = file.name.replace(/[^\w.\-]+/g, '_')
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
