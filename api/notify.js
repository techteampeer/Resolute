// Email notifications for portal activity. Driven by Supabase Database Webhooks
// on INSERT into public.order_events and public.support_messages (see
// api/README.md), so every event already written to those tables produces mail
// with no client-side wiring and full coverage of server-side events.
//
// Routing is role-based (no per-user preferences by design — defaults live
// here, in code):
//
//   EVENT                                    → RECIPIENTS
//   New order placed                         → admins
//   Order assigned / handed to a stage       → the staff on that stage
//   Stage completed, returned for assignment → admins
//   Order delivered                          → the client + admins
//   Cancellation requested                   → admins
//   Cancellation approved / declined         → the client
//   Clarification, hold, payment, status     → the client
//   Client sends a message                   → admins
//   Admin replies                            → the client
//   Internal staff note                      → admins
//
// order_events.audience ('staff' | 'client' | 'all') selects the groups; for
// staff-facing events the recipient is whichever role currently owns the order
// (orders.assigned_to), read at send time so it is always accurate.
//
// Auth: the webhook must send header `x-notify-secret: <NOTIFY_SECRET>`.
// Payload: the standard Supabase webhook body { type, table, record, ... }.
import { supabaseAdmin, hasSupabaseAdmin } from './_lib/supabaseAdmin.js'
import { sendMail, isSmtpLive, PORTAL_URL } from './_lib/mailer.js'

const send = (res, code, body) => res.status(code).json(body)

const ROLE_LABEL = {
  screener: 'Screening', examiner: 'Examination', typer: 'Typing',
  delivery: 'Delivery', operator: 'Single Seating', admin: 'Admin',
}

// ── Recipient resolution ─────────────────────────────────────────────────────
const joinEmails = (rows) => (rows || []).map(r => r.email).filter(Boolean).join(', ') || null

async function clientEmail(clientCode) {
  if (!clientCode) return null
  const { data } = await supabaseAdmin.from('profiles')
    .select('email').eq('client_code', clientCode).eq('role', 'client').limit(1).maybeSingle()
  return data?.email || null
}

async function adminEmails() {
  if (process.env.NOTIFY_ADMIN_EMAIL) return process.env.NOTIFY_ADMIN_EMAIL
  const { data } = await supabaseAdmin.from('profiles')
    .select('email').eq('role', 'admin').eq('status', 'active')
  return joinEmails(data)
}

// Everyone working a given stage. Deactivated accounts are skipped so people
// who have left stop receiving order mail.
async function staffEmails(role) {
  if (!role) return null
  if (role === 'admin') return adminEmails()
  const { data } = await supabaseAdmin.from('profiles')
    .select('email').eq('role', role).eq('status', 'active')
  return joinEmails(data)
}

// ── Deep links ───────────────────────────────────────────────────────────────
const clientLink = (orderId) => (orderId ? `${PORTAL_URL()}/client/orders/${orderId}` : `${PORTAL_URL()}/client/support`)
const adminLink  = (orderId) => (orderId ? `${PORTAL_URL()}/admin/orders/${orderId}` : `${PORTAL_URL()}/admin/support`)
// Each portal opens its order detail on its own route.
const staffLink  = (role, orderId) => {
  if (!orderId) return PORTAL_URL()
  if (role === 'admin')    return adminLink(orderId)
  if (role === 'operator') return `${PORTAL_URL()}/operator/orders/${orderId}`
  return `${PORTAL_URL()}/${role}/order/${orderId}`
}

// ── Plans: one event can notify several groups, so always return a list ──────
async function orderById(id) {
  const { data } = await supabaseAdmin.from('orders')
    .select('client_code, status, assigned_to, type').eq('id', id).maybeSingle()
  return data
}

// `deps` exists so the routing table above can be unit-tested without a
// database or an SMTP server; production callers use the defaults.
export const defaultDeps = { clientEmail, adminEmails, staffEmails, orderById }

export async function plansFromRecord(table, record, deps = defaultDeps) {
  const { clientEmail, adminEmails, staffEmails, orderById } = deps
  if (!record) return []
  const plans = []
  const push = (to, subject, text, link) => { if (to) plans.push({ to, subject, text, link }) }

  if (table === 'support_messages') {
    const orderPart = record.order_id ? ` on order ${record.order_id}` : ''
    const who = record.client_code || '—'

    // Internal staff notes never reach the client — they exist to flag
    // something for Admin, who owns every client-facing reply.
    if (record.visibility === 'internal') {
      push(await adminEmails(), `Internal note${orderPart} (${who})`,
        `${record.author || 'A staff member'} left an internal note${orderPart}:\n\n"${record.body}"\n\nOpen the order in the admin portal.`,
        adminLink(record.order_id))
      return plans
    }
    if (record.sender === 'support') {
      push(await clientEmail(record.client_code), `New message${orderPart}`,
        `You have a new message from the Resolute team${orderPart}:\n\n"${record.body}"\n\nReply in your portal.`,
        clientLink(record.order_id))
      return plans
    }
    push(await adminEmails(), `Client message${orderPart} (${who})`,
      `${who} sent a message${orderPart}:\n\n"${record.body}"\n\nOpen the order in the admin portal to reply.`,
      adminLink(record.order_id))
    return plans
  }

  if (table === 'order_events') {
    const id = record.order_id
    if (!id) return plans
    const order = await orderById(id)
    const action = String(record.action || '')
    const audience = record.audience || 'staff'

    // A brand-new order is Admin's to confirm and price.
    if (record.type === 'new') {
      push(await adminEmails(), `New order ${id} placed`,
        `${action}\n\nReview and confirm it in the admin portal.`, adminLink(id))
      return plans
    }

    // A client asking to cancel needs an Admin decision; the outcome of that
    // decision (approved/declined) is client-facing and falls through below.
    if (/cancel/i.test(action) && !/approved|declined/i.test(action)) {
      push(await adminEmails(), `Order ${id}: ${action}`,
        `${action}\n\nOpen the admin portal for details.`, adminLink(id))
      return plans
    }

    // Staff side — whoever now owns the order. This is the half that did not
    // exist before: stage owners were never told work had arrived.
    if (audience === 'staff' || audience === 'all') {
      const role = order?.assigned_to
      const to = await staffEmails(role)
      if (to) {
        const stage = ROLE_LABEL[role] || role
        push(to,
          role === 'admin' ? `Order ${id} needs assignment` : `Order ${id} is ready for ${stage}`,
          role === 'admin'
            ? `${action}\n\nAssign the next stage in the admin portal.`
            : `${action}\n\nOrder ${id}${order?.type ? ` (${order.type})` : ''} is now in the ${stage} queue.\n\nOpen it in your portal to begin.`,
          staffLink(role, id))
      }
    }

    // Client side — progress they are waiting on.
    if (audience === 'client' || audience === 'all') {
      push(await clientEmail(order?.client_code), `Update on your order ${id}`,
        `${action}\n\nTrack it in your Resolute portal.`, clientLink(id))
    }
    return plans
  }

  return plans
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })
  if (!hasSupabaseAdmin) return send(res, 500, { error: 'Server not configured' })

  const secret = process.env.NOTIFY_SECRET
  if (!secret || req.headers['x-notify-secret'] !== secret) return send(res, 401, { error: 'Unauthorized' })

  let payload
  try { payload = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {}) }
  catch { return send(res, 400, { error: 'Malformed JSON' }) }

  const table = payload.table || payload.type_table
  const record = payload.record || payload.new || payload
  try {
    const plans = await plansFromRecord(table, record)
    if (!plans.length) return send(res, 200, { sent: false, reason: 'no recipient / not notifiable' })
    // One event can legitimately notify several groups; a failure to reach one
    // must not silently drop the others.
    const results = await Promise.allSettled(plans.map(p => sendMail(p)))
    return send(res, 200, {
      sent: true, live: isSmtpLive(),
      delivered: results.map((r, i) => ({
        to: plans[i].to, subject: plans[i].subject,
        ok: r.status === 'fulfilled',
        error: r.status === 'rejected' ? String(r.reason?.message || r.reason) : undefined,
      })),
    })
  } catch (err) {
    console.error('[notify] error:', err?.message || err)
    return send(res, 200, { sent: false, error: 'send_failed' })   // 200 so the webhook doesn't retry-storm
  }
}
