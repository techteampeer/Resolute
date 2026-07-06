// Quote-first order confirmation. Every new order (portal or email) is HELD
// with Admin until the price is discussed and the client accepts; only then is
// a confirmation sent and the order released to production (Screener).
//
// State lives on order.workflow.quote:
// { stage, amount, thread: [{id, from:'admin'|'client', text, at, email?}],
//   quotedAt/quotedBy, acceptedAt/acceptedVia, confirmedAt/confirmedBy }

export const QUOTE_STAGES = {
  pending:   { label: 'Needs Quote',        color: '#b45309' },
  quoted:    { label: 'Quote Sent',         color: '#2563eb' },
  accepted:  { label: 'Client Accepted',    color: '#0e7490' },
  confirmed: { label: 'Confirmed',          color: '#15803d' },
  declined:  { label: 'Declined',           color: '#dc2626' },
}

export const quoteOf = (o) => o.workflow?.quote || null
export const quoteStage = (o) => quoteOf(o)?.stage || null
// Orders created before the quote flow existed have no quote object — they are
// already in production and are never held.
export const isHeldForQuote = (o) => {
  const s = quoteStage(o)
  return Boolean(s && s !== 'confirmed' && s !== 'declined')
}
export const isEmailSource = (o) => o.workflow?.intake?.source === 'email'

export const newQuote = () => ({ stage: 'pending', amount: null, thread: [] })

const now = () => new Date().toISOString()
export const threadMsg = (from, text, extra = {}) =>
  ({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, from, text, at: now(), ...extra })

// Stage transitions — each returns the updated quote object.
export const sendQuote = (q, { amount, note, by, emailResult }) => ({
  ...q, stage: 'quoted', amount,
  quotedAt: now(), quotedBy: by,
  thread: [...(q.thread || []), threadMsg('admin',
    `Quote: $${amount}${note ? ` — ${note}` : ''}`,
    emailResult ? { email: emailResult } : {})],
})
export const acceptQuote = (q, via, text) => ({
  ...q, stage: 'accepted', acceptedAt: now(), acceptedVia: via,
  thread: [...(q.thread || []), threadMsg(via === 'portal' ? 'client' : 'admin',
    text || (via === 'portal' ? 'Quote accepted via portal.' : 'Client accepted by email reply.'))],
})
export const confirmOrder = (q, { by, note, emailResult }) => ({
  ...q, stage: 'confirmed', confirmedAt: now(), confirmedBy: by,
  thread: [...(q.thread || []), threadMsg('admin',
    `Order confirmed at $${q.amount}.${note ? ` ${note}` : ''}`,
    emailResult ? { email: emailResult } : {})],
})
export const declineQuote = (q, text) => ({
  ...q, stage: 'declined',
  thread: [...(q.thread || []), threadMsg('admin', text || 'Quote declined / order cancelled.')],
})
export const addThreadMsg = (q, from, text) =>
  ({ ...q, thread: [...(q.thread || []), threadMsg(from, text)] })

// Fire the real email for email-sourced orders (best-effort; the thread is the
// source of truth either way). Returns { sent, reason?, to? }.
export async function sendOrderEmail(orderId, kind, amount, message) {
  try {
    const res = await fetch('/api/send-order-email', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderId, kind, amount, message }),
    })
    if (!res.ok) return { sent: false, reason: `HTTP ${res.status}` }
    return await res.json()
  } catch {
    return { sent: false, reason: 'endpoint unreachable (local dev has no /api)' }
  }
}
