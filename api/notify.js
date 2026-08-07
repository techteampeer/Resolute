// Email notifications for portal activity. Designed to be called by Supabase
// Database Webhooks on INSERT into public.order_events and public.support_messages
// (see api/README.md for setup) — so every notable event already written to
// those tables produces an email, with no client-side wiring and full coverage
// of server-side events (cancellations, RPC actions, etc.).
//
// Auth: the webhook must send header `x-notify-secret: <NOTIFY_SECRET>`.
// Payload: the standard Supabase webhook body { type, table, record, ... }.
import { supabaseAdmin, hasSupabaseAdmin } from './_lib/supabaseAdmin.js'
import { sendMail, isSmtpLive, PORTAL_URL } from './_lib/mailer.js'

const send = (res, code, body) => res.status(code).json(body)

async function clientEmail(clientCode) {
  if (!clientCode) return null
  const { data } = await supabaseAdmin.from('profiles').select('email').eq('client_code', clientCode).eq('role', 'client').limit(1).maybeSingle()
  return data?.email || null
}
async function adminEmails() {
  if (process.env.NOTIFY_ADMIN_EMAIL) return process.env.NOTIFY_ADMIN_EMAIL
  const { data } = await supabaseAdmin.from('profiles').select('email').eq('role', 'admin')
  return (data || []).map(r => r.email).filter(Boolean).join(', ') || null
}

// Map an inserted row to { to, subject, text }. Returns null when nothing to send.
// Deep link to where the recipient acts on this in the portal.
const clientLink = (orderId) => (orderId ? `${PORTAL_URL()}/client/orders/${orderId}` : `${PORTAL_URL()}/client/support`)
const adminLink  = (orderId) => (orderId ? `${PORTAL_URL()}/admin/orders?order=${orderId}` : `${PORTAL_URL()}/admin/support`)

async function planFromRecord(table, record) {
  if (!record) return null

  if (table === 'support_messages') {
    // A message → notify the OTHER party. Skip the general (order-less) thread's
    // own echoes only when there's nothing to route to.
    const orderPart = record.order_id ? ` on order ${record.order_id}` : ''
    // Internal staff notes never reach the client — they go to admins, who own
    // every client-facing reply.
    if (record.visibility === 'internal') {
      const to = await adminEmails()
      return to && {
        to,
        subject: `Internal note${orderPart} (${record.client_code || '—'})`,
        text: `${record.author || 'A staff member'} left an internal note${orderPart}:\n\n"${record.body}"\n\nOpen the order in the admin portal.`,
        link: adminLink(record.order_id),
      }
    }
    if (record.sender === 'support') {
      const to = await clientEmail(record.client_code)
      return to && { to, subject: `New message${orderPart}`, text: `You have a new message from the Resolute team${orderPart}:\n\n"${record.body}"\n\nReply in your portal.`, link: clientLink(record.order_id) }
    }
    // client → notify admins
    const to = await adminEmails()
    return to && { to, subject: `Client message${orderPart} (${record.client_code || '—'})`, text: `${record.client_code || 'A client'} sent a message${orderPart}:\n\n"${record.body}"\n\nOpen the order in the admin portal to reply.`, link: adminLink(record.order_id) }
  }

  if (table === 'order_events') {
    const id = record.order_id
    if (!id) return null
    // Resolve the order's client for client-facing notices.
    const { data: order } = await supabaseAdmin.from('orders').select('client_code, status').eq('id', id).maybeSingle()
    const action = String(record.action || '')
    // New order → admins (there's an order to confirm).
    if (record.type === 'new') {
      const to = await adminEmails()
      return to && { to, subject: `New order ${id} placed`, text: `${action}\n\nReview and confirm it in the admin portal.`, link: adminLink(id) }
    }
    // Client-originated cancellation → admins.
    if (/cancel/i.test(action) && !/approved|declined/i.test(action)) {
      const to = await adminEmails()
      return to && { to, subject: `Order ${id}: ${action}`, text: `${action}\n\nOpen the admin portal for details.`, link: adminLink(id) }
    }
    // Everything else about an order → its client.
    const to = await clientEmail(order?.client_code)
    return to && { to, subject: `Update on your order ${id}`, text: `${action}\n\nTrack it in your Resolute portal.`, link: clientLink(id) }
  }

  return null
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
    const plan = await planFromRecord(table, record)
    if (!plan) return send(res, 200, { sent: false, reason: 'no recipient / not notifiable' })
    const result = await sendMail(plan)
    return send(res, 200, { sent: true, live: isSmtpLive(), to: plan.to, subject: plan.subject, result })
  } catch (err) {
    console.error('[notify] error:', err?.message || err)
    return send(res, 200, { sent: false, error: 'send_failed' })   // 200 so the webhook doesn't retry-storm
  }
}
