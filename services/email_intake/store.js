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

// Columns worth reporting back for an order we did not just build.
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

    // The repo's one deterministic client mapping: clients.code is the primary
    // key and orders.client_code is its foreign key. Exact match only — there
    // is no reliable address→client mapping in the schema to fall back on.
    async resolveClient(code) {
      const { data, error } = await c.from('clients').select('code, name')
        .eq('code', code).maybeSingle()
      if (error) rethrow('client lookup failed', error)
      return data || null
    },

    // Same sequence-backed id the Place Order form uses, so email and website
    // orders share one numbering with no chance of collision.
    async nextOrderId() {
      const { data, error } = await c.rpc('next_order_id')
      if (error) rethrow('order id allocation failed', error)
      return data || null
    },

    async insertOrder(row) {
      const { data, error } = await c.from('orders').insert(row).select(SUMMARY).single()
      if (error) rethrow('order insert failed', error)
      return data
    },
  }
}
