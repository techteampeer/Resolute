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

const toOrderRow = (o) => ({
  status: o.status, priority: o.priority, payment: o.payment, clarification: o.clarification,
  assigned_to: o.assignedTo,
  screener: o.screener, examiner: o.examiner, typer: o.typer, delivery: o.delivery,
  progress: o.progress, eta: o.eta, completed: o.completed,
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

// Best-effort insert of a new order (client-placed). Note: RLS only lets staff
// insert, so from a client session this may be rejected — the order still lives
// in local state; wire a serverless endpoint for durable client-side creation.
export async function insertOrder(order) {
  const { error } = await supabase.from('orders').insert({
    id: order.id, client_code: order.clientCode || null,
    state: order.state, county: order.county, type: order.type,
    created: order.created, ...toOrderRow(order),
  })
  if (error) console.error('[insertOrder]', error.message)
}

export function subscribeOrders(cb) {
  const channel = supabase.channel('orders-rt')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'orders' }, cb)
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

export async function logEvent({ orderId = null, action, type = 'status', actor = null }) {
  const { error } = await supabase.from('order_events').insert({ order_id: orderId, action, type, actor })
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
