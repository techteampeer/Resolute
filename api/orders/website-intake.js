// POST /api/orders/website-intake
//
// Machine-to-machine intake for orders placed on the public website
// (resolutetitleservices.com/order). The website posts to a Google Apps Script
// web app, which logs the order to its Google Sheet, emails the team and the
// customer, and then forwards the same structured JSON here with a stable
// submissionId. No AI and no extraction: the fields are the form's own.
//
// A thin Vercel adapter: authenticate, parse, delegate, map the result to HTTP.
// All logic lives in services/website_intake/ (and the unchanged
// services/email_intake/store.js it shares), which knows nothing about Vercel.
import { timingSafeEqual } from 'node:crypto'
import { hasSupabaseAdmin } from '../_lib/supabaseAdmin.js'
import { processWebsiteIntake } from '../../services/website_intake/intake.js'
import { createDeps } from '../../services/email_intake/store.js'

const send = (res, code, body) => res.status(code).json(body)

const SECRET_HEADER = 'x-intake-secret'

// Constant-time comparison (length checked first — timingSafeEqual throws on a
// mismatch, and a shared secret's length is not worth protecting).
function secretMatches(received, expected) {
  const got = Buffer.from(String(Array.isArray(received) ? received[0] : received || ''))
  const want = Buffer.from(String(expected))
  return got.length === want.length && timingSafeEqual(got, want)
}

// 4xx: the payload is wrong — the Apps Script marks the row `rejected` for a
// person to review. 5xx: ours — safe to retry, the submissionId makes a retry
// idempotent.
const STATUS_FOR = {
  invalid_payload: 400,
  ambiguous_client: 422,
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return send(res, 405, { error: 'Method not allowed' })

  // Fail closed: its OWN secret, separate from email intake's, so either can be
  // rotated or revoked alone. Unset disables the endpoint rather than opening it.
  const secret = process.env.WEBSITE_INTAKE_API_SECRET
  if (!secret) return send(res, 503, { error: 'Website intake is not configured' })
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
    const result = await processWebsiteIntake(body, createDeps())

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
      // code | name | created — null for a duplicate, which created nothing.
      clientMatch: duplicate ? null : (result.clientMatch ?? null),
      needsReview: duplicate ? null : Boolean(result.reviewNotes?.length),
    })
  } catch (err) {
    // Never echo the exception — it can carry connection strings.
    console.error('[website-intake]', err?.message || err)
    return send(res, 500, { error: 'Intake failed' })
  }
}
