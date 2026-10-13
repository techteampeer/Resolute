// The notification catalogue, app-side.
//
// The DB owns routing (who gets what, and whether it is immediate or digest).
// This file owns presentation: how each event reads in a subject line and in
// the body. Keeping them apart means changing a wording never needs a
// migration, and changing who is notified never needs a deploy.
//
// Pure data + pure functions. No imports, no I/O — this file has to run
// unchanged in a browser preview, a Vercel function and a Lambda.

// The order reference a human actually recognises. Ours is RTS-…; the client's
// own file number is what they quote back at us, so it leads when present.
export const orderRef = (p = {}) =>
  [p.clientFileNo, p.orderId].filter(Boolean).join(' · ')

// Non-super-admins must never see client names (displayClient in the app).
// Notifications go only to staff, and the recipient's own role decides: an
// admin sees the name, everyone else sees the code. Defaulting to the code
// means a missing role degrades to the safe side.
export const clientLabel = (p = {}, recipientRole) =>
  (recipientRole === 'admin' && p.clientName) ? p.clientName : (p.clientCode || 'Client')

const place = (p) => [p.county && `${p.county} County`, p.state].filter(Boolean).join(', ')

export const TYPES = {
  'order.new': {
    label: 'New order placed',
    accent: '#2441E5',
    subject: (p, role) => `New order · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'A new order came in',
    lead: (p, role) =>
      `${clientLabel(p, role)} placed ${p.orderType || 'an order'}${place(p) ? ` in ${place(p)}` : ''}. `
      + 'It is parked with Admin for confirmation and pricing — it has not entered production.',
    cta: 'Confirm and assign',
  },
  'order.assigned': {
    label: 'Work assigned to you',
    accent: '#2441E5',
    subject: (p, role) => `Assigned to you · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'Work landed in your queue',
    lead: (p, role) =>
      `Admin assigned ${p.orderType || 'an order'} for ${clientLabel(p, role)}`
      + `${place(p) ? ` in ${place(p)}` : ''} to your desk`
      + `${p.priority === 'rush' ? ' — this one is RUSH' : ''}`
      + `${p.eta ? `, committed for ${p.eta}` : ''}.`,
    cta: 'Open the order',
  },
  'order.progress': {
    label: 'Stage completed',
    accent: '#00B8D9',
    subject: (p, role) => `Progress · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'Stage completed',
    lead: (p) => p.action || 'A production stage finished.',
    cta: 'Open the order',
  },
  'order.awaiting_admin': {
    label: 'Awaiting Admin approval',
    accent: '#B45309',
    subject: (p, role) => `Needs assignment · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'Waiting on Admin',
    lead: (p) =>
      `${p.action || 'A stage finished'}. The order cannot advance until an Admin approves it and assigns the next stage.`,
    cta: 'Approve and assign',
  },
  'order.delivered': {
    label: 'Order delivered',
    accent: '#15803D',
    subject: (p, role) => `Delivered · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'Order delivered',
    lead: (p, role) =>
      `The completed package reached ${clientLabel(p, role)} and the invoice is now visible to them.`,
    cta: 'Open the order',
  },
  'order.cancel_requested': {
    label: 'Cancellation requested',
    accent: '#DC2626',
    subject: (p, role) => `Cancellation requested · ${orderRef(p)} · ${clientLabel(p, role)}`,
    headline: () => 'Cancellation requested',
    lead: (p, role) =>
      `${clientLabel(p, role)} asked to cancel this order after production had started, `
      + 'so it needs an Admin decision rather than cancelling outright.',
    cta: 'Approve or decline',
  },
  'message.client': {
    label: 'Client message',
    accent: '#2441E5',
    subject: (p, role) =>
      `Client message · ${orderRef(p) || clientLabel(p, role)}`,
    headline: () => 'A client wrote in',
    lead: (p, role) => `${clientLabel(p, role)} sent a message in the portal. Only Admins can reply.`,
    quote: (p) => p.body,
    cta: 'Read and reply',
  },
}

export const typeOf = (key) => TYPES[key] || {
  label: key, accent: '#5C6E8C',
  subject: (p) => `Update · ${orderRef(p)}`,
  headline: () => 'Order update',
  lead: (p) => p.action || '',
  cta: 'Open the order',
}

// Facts worth putting under the lead. Empty values are dropped rather than
// rendered as "— " rows, because orders vary in how much they carry.
export const factsFor = (key, p = {}, role) => {
  const base = [
    ['Order', p.orderId],
    ['Client file #', p.clientFileNo],
    ['Client', clientLabel(p, role)],
    ['Type', p.orderType],
    ['Location', place(p)],
  ]
  if (key === 'message.client') return base.filter(([, v]) => v)
  return [
    ...base,
    ['Priority', p.priority === 'rush' ? 'RUSH' : null],
    ['Now with', p.assignedTo],
    ['ETA', p.eta],
  ].filter(([, v]) => v)
}

// Where the email points. The portal discards an unauthenticated destination
// unless the login flow preserves it, which is why ProtectedRoute carries
// `from` — without that these links land everyone on their dashboard.
//
// The segment is not the same in every portal: Admin, client and the production
// (`user`) workspace route an order detail at /orders/:id. Post-D3 (ADR 0001)
// the four stage portals are retired, so `user` is the only production
// recipient of order.assigned — its "Open the order" link is /user/orders/:id.
const ORDER_SEGMENT = {
  admin: 'orders', client: 'orders', user: 'orders',
}
// A notification_outbox row queued BEFORE the D3 deploy can still carry a retired
// stage recipient_role (screener/examiner/typer/delivery). Those portals are
// gone, so map any such role to the production `user` desk — otherwise the mail's
// "Open the order" link would point at a deleted /<stage>/… route.
const STAGE_ROLES = new Set(['screener', 'examiner', 'typer', 'delivery'])
export const linkFor = (p = {}, baseUrl, role = 'admin') => {
  const base = String(baseUrl || '').replace(/\/+$/, '')
  if (!base) return null
  const r = STAGE_ROLES.has(role) ? 'user' : role
  const seg = ORDER_SEGMENT[r] || 'orders'
  return p.orderId ? `${base}/${r}/${seg}/${p.orderId}` : `${base}/${r}`
}
