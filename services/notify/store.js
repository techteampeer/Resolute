// Outbox access, service-role only.
//
// The outbox has RLS on and no policies, so a browser session cannot reach it
// at all. Everything here goes through the service key and therefore must only
// ever run server-side. Isolated in its own module so the orchestrator stays
// pure and testable with a fake store.
import { createClient } from '@supabase/supabase-js'

export function createStore(env = process.env) {
  const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL
  const key = env.SUPABASE_SERVICE_ROLE_KEY
  if (!url) throw new Error('notify: SUPABASE_URL is not set')
  if (!key) throw new Error('notify: SUPABASE_SERVICE_ROLE_KEY is not set (server-only secret)')

  const db = createClient(url, key, { auth: { persistSession: false } })

  return {
    // Claims a batch atomically — `for update skip locked` inside the RPC means
    // two overlapping runs never claim the same rows.
    async claim(mode, limit = 100) {
      const { data, error } = await db.rpc('claim_notifications', { p_mode: mode, p_limit: limit })
      if (error) throw new Error(`claim_notifications: ${error.message}`)
      return data || []
    },
    async markSent(id) {
      const { error } = await db.rpc('mark_notification_sent', { p_id: id })
      if (error) throw new Error(`mark_notification_sent: ${error.message}`)
    },
    // Returns the row to pending until attempts run out, so a transient SES
    // error retries on the next drain instead of silently dropping the message.
    async markFailed(id, message) {
      const { error } = await db.rpc('mark_notification_failed', { p_id: id, p_error: String(message).slice(0, 500) })
      if (error) throw new Error(`mark_notification_failed: ${error.message}`)
    },
  }
}
