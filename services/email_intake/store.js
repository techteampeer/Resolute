// The only file in services/email_intake that talks to Supabase. Isolated so
// intake.js stays pure and testable against a fake — same split as
// services/notify/store.js.
//
// Uses the service-role client, which bypasses RLS. That is what lets a
// machine caller insert an order at all: every orders INSERT policy is written
// for a browser session (staff role, or a client inserting for their own
// client_code), and this caller is neither. The shared-secret gate in the
// handler is therefore the only thing standing in front of it — keep it.
import { supabaseAdmin } from '../../api/_lib/supabaseAdmin.js'

const db = () => {
  if (!supabaseAdmin) {
    throw new Error('email_intake: Supabase admin not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)')
  }
  return supabaseAdmin
}

// Preserve Postgres' error code on the way out — processIntake reads 23505 to
// tell a lost idempotency race from a real failure.
const rethrow = (prefix, error) => {
  const err = new Error(`email_intake: ${prefix}: ${error.message}`)
  if (error.code) err.code = error.code
  throw err
}

// Columns worth reporting back for an order that already exists.
const SUMMARY = 'id, status, assigned_to, client_code, type'

export function createDeps(client = null) {
  const c = client || db()
  return {
    // Idempotency lookup against the partial unique index's expression.
    async findByMessageId(messageId) {
      const { data, error } = await c.from('orders').select(SUMMARY)
        .eq('workflow->intake->>messageId', messageId).limit(1)
      if (error) rethrow('duplicate check failed', error)
      return data?.[0] || null
    },

    // Client + order in ONE database transaction: intake_create_order (in
    // 20260925000000_email_intake_client_resolution.sql) matches the client —
    // or creates it under a per-name lock — then draws the order id and inserts
    // the order. If the insert fails, a client created by the same call rolls
    // back with it, and the error (23505 included) propagates unchanged.
    // contact/email only populate a NEW client; the database never matches on them.
    // Returns { status: 'created', clientMatch, clientCode, order }
    //       | { status: 'ambiguous', codes } | { status: 'unknown_client' }.
    async createIntakeOrder({ row, clientIdentifier = null, company = null, contact = null, email = null }) {
      const { data, error } = await c.rpc('intake_create_order', {
        p_order: row, p_company: company, p_contact: contact, p_email: email,
        p_client_code: clientIdentifier,
      })
      if (error) rethrow('order creation failed', error)
      if (data?.status === 'ambiguous') return { status: 'ambiguous', codes: data.codes || [] }
      if (data?.status === 'unknown_client') return { status: 'unknown_client' }
      if (data?.status === 'created' && data.order?.id && data.clientCode) {
        return { status: 'created', clientMatch: data.clientMatch, clientCode: data.clientCode, order: data.order }
      }
      throw new Error('email_intake: order creation returned an unexpected result')
    },
  }
}
