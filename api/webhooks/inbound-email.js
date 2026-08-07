// POST /api/webhooks/inbound-email
// Inbound email → draft order pipeline.
// Accepts an inbound-email JSON payload (text + attachments), extracts the
// intake fields via the LLM service, and creates a draft order.
//
// Vercel serverless function (Node). The SPA rewrite in vercel.json excludes
// /api, so this route resolves to the function, not index.html.
import { extractOrderFields } from '../_lib/extractOrder.js'
import { createInboundOrder } from '../_lib/ordersRepo.js'
import { hasSupabaseAdmin } from '../_lib/supabaseAdmin.js'

// Normalize the many inbound-email provider shapes (SendGrid/Postmark/Mailgun/
// custom) into { from, subject, text, attachments }.
function normalize(body = {}) {
  const text =
    body.text || body['text'] || body.plain || body['body-plain'] ||
    body.TextBody || body.stripped_text || body.bodyPlain || ''
  const subject = body.subject || body.Subject || ''
  const from = body.from || body.From || body.sender || ''
  let attachments = body.attachments || body.Attachments || []
  if (!Array.isArray(attachments)) attachments = []
  // Header bag varies by provider; lower-case the keys once for lookups.
  const raw = body.headers || body.Headers || {}
  const headers = {}
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) headers[String(k).toLowerCase()] = v
  } else if (Array.isArray(raw)) {
    for (const h of raw) if (h?.Name || h?.name) headers[String(h.Name || h.name).toLowerCase()] = h.Value ?? h.value
  }
  return { from, subject, text, attachments, headers }
}

// Portal-only communication policy: clients converse in the portal, and our
// outbound mail is notification-only. A reply to one of those notifications is
// NOT an order request, so it must never reach the draft-order pipeline.
// Detected by our own notification markers, the auto-generated hint we set, or
// a plain "Re:" subject on a threaded reply.
function isReplyToNotification({ subject = '', headers = {} }) {
  if (headers['x-resolute-notification']) return true
  const auto = String(headers['auto-submitted'] || '').toLowerCase()
  if (auto && auto !== 'no') return true
  const threaded = Boolean(headers['in-reply-to'] || headers['references'])
  if (threaded && /^\s*(re|aw|antw|sv)\s*:/i.test(subject)) return true
  return false
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' })
  }

  // Optional shared-secret check (set INBOUND_WEBHOOK_SECRET to enable).
  const secret = process.env.INBOUND_WEBHOOK_SECRET
  if (secret && req.headers['x-webhook-secret'] !== secret) {
    return res.status(401).json({ error: 'Invalid webhook secret' })
  }

  let email
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    email = normalize(body)
  } catch {
    return res.status(400).json({ error: 'Malformed JSON payload' })
  }

  if (!email.text && (!email.attachments || email.attachments.length === 0)) {
    // Nothing to parse — acknowledge so the provider doesn't retry.
    return res.status(200).json({ received: true, skipped: 'no email content' })
  }

  // A reply to one of our notifications is correspondence, not an order.
  // Acknowledge and drop it rather than drafting a phantom order; the client's
  // real message belongs in the portal thread.
  if (isReplyToNotification(email)) {
    return res.status(200).json({ received: true, skipped: 'reply to notification (portal-only policy)' })
  }

  // Extract + persist. We acknowledge with 200 even if a downstream step fails
  // (logged server-side) so the email provider treats the message as received
  // and does not retry-storm. For true fire-and-forget, move this behind a
  // queue (e.g. Supabase queue / QStash) or Vercel waitUntil.
  try {
    if (!hasSupabaseAdmin) throw new Error('Supabase admin not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
    const { fields, method } = await extractOrderFields(email)
    const order = await createInboundOrder(fields, { from: email.from, subject: email.subject })
    return res.status(200).json({ received: true, orderId: order.id, status: order.status, extraction: method, fields })
  } catch (err) {
    console.error('[inbound-email] processing error:', err?.message || err)
    return res.status(200).json({ received: true, processed: false, error: 'processing_failed' })
  }
}
