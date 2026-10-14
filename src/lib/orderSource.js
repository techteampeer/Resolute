// Where an order came from — for display only.
//
// workflow.intake.source is written once, at creation:
//   'web'      the portal's own Place Order flows (OrderContext.createOrder)
//   'email'    POST /api/orders/email-intake
//   'website'  POST /api/orders/website-intake
// The stored values are never rewritten: 'web' still means Portal, and
// isPortalOrder() / StagePlanModal (pricing + approval) keep keying on it
// unchanged. This module only names them.
export const ORDER_SOURCE_LABEL = { website: 'Website', email: 'Email', portal: 'Portal' }

// 'website' | 'email' | 'portal'. Legacy rows with no intake source predate
// the intake endpoints, so they were created in the portal.
export function orderSourceOf(order) {
  const source = order?.workflow?.intake?.source
  if (source === 'website') return 'website'
  if (source === 'email') return 'email'
  return 'portal'
}

export const orderSourceLabel = (order) => ORDER_SOURCE_LABEL[orderSourceOf(order)]
