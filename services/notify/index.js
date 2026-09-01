// The notification cycle, entire.
//
// One entry point — `runNotifications({ mode })` — with no knowledge of how it
// was invoked. On Vercel a serverless handler calls it; on AWS an EventBridge
// schedule triggers a Lambda that calls it. Neither adapter contains logic, so
// Friday's migration replaces about fifteen lines and nothing else.
//
//   mode 'immediate' — drain everything queued as immediate, one mail each.
//   mode 'digest'    — drain everything queued as digest, ONE mail per person.
import { createStore } from './store.js'
import { renderOne, renderDigest } from './render.js'
import { sesProvider } from './providers/ses.js'
import { previewProvider, consoleProvider } from './providers/preview.js'

export function resolveProvider(env = process.env) {
  switch ((env.NOTIFY_PROVIDER || 'preview').toLowerCase()) {
    case 'ses':     return sesProvider(env)
    case 'console': return consoleProvider()
    // Deliberately the default. An unconfigured deploy writes files instead of
    // mailing real colleagues.
    default:        return previewProvider(env)
  }
}

export async function runNotifications({
  mode = 'immediate',
  limit = 100,
  env = process.env,
  store = null,
  provider = null,
} = {}) {
  if (!['immediate', 'digest'].includes(mode)) throw new Error(`notify: unknown mode "${mode}"`)

  const db = store || createStore(env)
  const send = provider || resolveProvider(env)
  const baseUrl = env.PORTAL_URL || null

  const rows = await db.claim(mode, limit)
  if (!rows.length) return { mode, provider: send.name, claimed: 0, sent: 0, failed: 0, messages: 0 }

  // Immediate → one message per row. Digest → group by recipient so each person
  // gets a single roll-up, which is the whole reason the digest mode exists.
  const groups = mode === 'digest'
    ? [...rows.reduce((m, r) => {
        const k = r.recipient_email.toLowerCase()
        if (!m.has(k)) m.set(k, [])
        m.get(k).push(r)
        return m
      }, new Map()).values()]
    : rows.map(r => [r])

  let sent = 0, failed = 0, messages = 0
  for (const group of groups) {
    const head = group[0]
    const opts = { baseUrl, recipientRole: head.recipient_role || 'admin' }
    try {
      const mail = group.length > 1 || mode === 'digest'
        ? renderDigest(group, opts)
        : renderOne(head, opts)
      await send.send({ to: head.recipient_email, ...mail })
      messages++
      // Mark every row the message covered — a digest that went out must not
      // leave its rows pending, or tomorrow's digest repeats today's news.
      for (const r of group) { await db.markSent(r.id); sent++ }
    } catch (err) {
      for (const r of group) { await db.markFailed(r.id, err?.message || String(err)); failed++ }
    }
  }

  return { mode, provider: send.name, claimed: rows.length, sent, failed, messages }
}

export { renderOne, renderDigest } from './render.js'
export { TYPES } from './types.js'
