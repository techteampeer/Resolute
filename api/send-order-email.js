// POST /api/send-order-email
// Sends a quote / order-confirmation email to the client of an order.
// Body: { orderId, kind: 'quote'|'confirmation', amount, message }
//
// The recipient is derived SERVER-SIDE from the order (intake.from or the
// linked client's email) — callers can't supply arbitrary addresses, so this
// endpoint can't be abused as an open relay.
//
// Provider: Resend (RESEND_API_KEY). For testing without a domain, Resend's
// onboarding@resend.dev sender can mail your own account address. Swap to SES
// later by replacing deliver() only. No key configured → { sent:false } and
// the app still records the message in the order's quote thread.
import { supabaseAdmin, hasSupabaseAdmin } from './_lib/supabaseAdmin.js'

const FROM = process.env.RESEND_FROM || 'Resolute Title <onboarding@resend.dev>'

const parseAddress = (s = '') => {
  const m = String(s).match(/<([^>]+)>/)
  return (m ? m[1] : s).trim()
}

async function deliver({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY
  if (!key) return { sent: false, reason: 'RESEND_API_KEY not configured' }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM, to: [to], subject, text }),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    return { sent: false, reason: `Resend ${res.status}: ${detail.slice(0, 200)}` }
  }
  const data = await res.json()
  return { sent: true, id: data.id }
}

const money = (n) => (Number(n) || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD' })

function buildEmail(kind, order, amount, message) {
  const intake = order.workflow?.intake || {}
  const prop = intake.propertyAddress ? `\nProperty: ${intake.propertyAddress}` : ''
  if (kind === 'quote') {
    return {
      subject: `Quote for order ${order.id} — ${money(amount)}`,
      text: `Hello,\n\nThank you for your order ${order.id} (${order.type}).${prop}\n\n` +
        `Our quote for this search is ${money(amount)}.\n\n` +
        (message ? `${message}\n\n` : '') +
        `Reply to this email to accept the quote or discuss the price. ` +
        `Work begins once the order is confirmed.\n\n— Resolute Title Services`,
    }
  }
  return {
    subject: `Order ${order.id} confirmed — ${money(amount)}`,
    text: `Hello,\n\nYour order ${order.id} (${order.type}) is confirmed at the agreed price of ${money(amount)}.${prop}\n\n` +
      (message ? `${message}\n\n` : '') +
      `Our team has started work — we'll deliver the completed search as agreed.\n\n— Resolute Title Services`,
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}) }
  catch { return res.status(400).json({ error: 'Malformed JSON' }) }

  const { orderId, kind, amount, message } = body
  if (!orderId || !['quote', 'confirmation'].includes(kind)) {
    return res.status(400).json({ error: 'orderId and kind (quote|confirmation) are required' })
  }
  if (!hasSupabaseAdmin) return res.status(200).json({ sent: false, reason: 'Supabase admin not configured' })

  const { data: order, error } = await supabaseAdmin
    .from('orders').select('*, clients(email)').eq('id', orderId).single()
  if (error || !order) return res.status(404).json({ error: 'Order not found' })

  // Recipient: email the order came from, else the linked client's email.
  const to = parseAddress(order.workflow?.intake?.from || '') || order.clients?.email || null
  if (!to || !to.includes('@')) return res.status(200).json({ sent: false, reason: 'No client email on the order' })

  const mail = buildEmail(kind, order, amount, message)
  try {
    const result = await deliver({ to, ...mail })
    return res.status(200).json({ ...result, to })
  } catch (err) {
    console.error('[send-order-email]', err?.message || err)
    return res.status(200).json({ sent: false, reason: 'delivery_failed' })
  }
}
