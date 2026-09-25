// POST /api/orders/email-intake
//
// Machine-to-machine intake for orders that arrive by email. Google Apps Script
// reads the intake inbox, sends the message to Vertex AI / Gemini, and POSTs the
// structured result here. This app never reads Gmail and runs no extraction —
// the JSON is already extracted when it arrives.
//
// A thin Vercel adapter: authenticate, parse, delegate, map the result to HTTP.
// All logic lives in services/email_intake/, which knows nothing about Vercel,
// so the AWS move replaces this file and nothing else.
import { timingSafeEqual } from 'node:crypto'
import { hasSupabaseAdmin } from '../_lib/supabaseAdmin.js'
import { processIntake } from '../../services/email_intake/intake.js'
import { createDeps } from '../../services/email_intake/store.js'

const send = (res, code, body) => res.status(code).json(body)

const SECRET_HEADER = 'x-intake-secret'

// Constant-time comparison so a wrong secret leaks nothing about the right one.
// timingSafeEqual throws on a length mismatch, so that case is checked first —
// the length of a shared secret is not worth protecting.
function secretMatches(received, expected) {
  const got = Buffer.from(String(Array.isArray(received) ? received[0] : received || ''))
  const want = Buffer.from(String(expected))
  return got.length === want.length && timingSafeEqual(got, want)
}

// Result code → HTTP status. 4xx means "do not retry, the payload is wrong";
// anything 5xx is ours and Apps Script may safely retry, because the message id
// makes a retry idempotent.
const STATUS_FOR = {
  invalid_payload: 400,
  unknown_client: 422,
  ambiguous_client: 422,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  // Fail closed. An unset secret disables the endpoint rather than opening it —
  // this route can create real orders, so it must never be reachable by default.
  const secret = process.env.EMAIL_INTAKE_API_SECRET
  if (!secret) return send(res, 503, { error: 'Email intake is not configured' })
  if (!secretMatches(req.headers[SECRET_HEADER], secret)) {
    return send(res, 401, { error: 'Unauthorized' })
  }

  let body
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {})
  } catch {
    return send(res, 400, { error: 'Malformed JSON payload' })
  }

  if (!hasSupabaseAdmin) {
    return send(res, 500, { error: 'Server not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)' })
  }

  try {
    const result = await processIntake(body, createDeps())

    if (!result.ok) {
      return send(res, STATUS_FOR[result.code] || 400, {
        error: result.error, code: result.code, field: result.field,
      })
    }

    const order = result.order || {}
    const duplicate = result.status === 'duplicate'
    return send(res, duplicate ? 200 : 201, {
      ok: true,
      duplicate,
      orderId: order.id,
      status: order.status,
      assignedTo: order.assigned_to ?? null,
      clientCode: order.client_code ?? null,
      // How the client was established on THIS call: code | name | created.
      // Null for a duplicate, which created nothing.
      clientMatch: duplicate ? null : (result.clientMatch ?? null),
    })
  } catch (err) {
    // Never echo the exception to the caller — it can carry connection strings.
    console.error('[email-intake]', err?.message || err)
    return send(res, 500, { error: 'Intake failed' })
  }
}
