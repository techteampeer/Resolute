// Client payments. Thin adapters: validate the request (paymentRules), run the
// database function inside the caller's claims transaction, return the order.
// The two-step check workflow is the database's (section 12): the client's
// report is never payment; only the billing owner confirms or bounces it.
//   POST /api/orders/:id/payment          { method, reference, checkDocumentId? }
//                                         the client reports its payment -> 200 order (status 'marked')
//   POST /api/orders/:id/payment/verify   { decision, updatedAt, reason? }
//                                         the billing owner's decision -> 200 order | 409 stale (with order)
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { getOrder } from '../repositories/orders.js'
import { reportPayment, verifyPayment } from '../repositories/payments.js'
import { PaymentInputError, validateReport, validateVerify } from '../paymentRules.js'

export const paymentsRouter = Router()

const strip = (msg) => (msg.startsWith('payments: ') ? msg.slice(10) : msg)

// The database's refusals in the caller's terms; hidden and absent are one 404.
function refusal(err) {
  if (err instanceof PaymentInputError) return [err.status, err.message]
  const msg = String((err && err.message) || '')
  switch (err && err.code) {
    case '22023': return [400, strip(msg)]
    case 'P0002': return [404, 'not found']
    case '42501': return [403, msg.startsWith('payments: ') || msg.startsWith('only the billing owner') ? strip(msg) : 'not allowed']
    case '55000': return [409, strip(msg)]
    case '22P02': return [400, 'invalid request']
    default: return null
  }
}

const handle = (fn) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    const [status, body] = await fn(req)
    return res.status(status).json(body)
  } catch (err) {
    const r = refusal(err)
    if (r) return res.status(r[0]).json({ error: r[1] })
    return next(err)
  }
}

paymentsRouter.post('/:id/payment', handle(async (req) => {
  const r = validateReport(req.body)
  return withUserClaims(req.user, async (c) => {
    await reportPayment(c, req.params.id, r)
    return [200, await getOrder(c, req.params.id)]
  })
}))

paymentsRouter.post('/:id/payment/verify', handle(async (req) => {
  const v = validateVerify(req.body)
  try {
    return await withUserClaims(req.user, async (c) => {
      await verifyPayment(c, req.params.id, v)
      return [200, await getOrder(c, req.params.id)]
    })
  } catch (err) {
    // Decided on a version that has moved on: nothing was written; show the latest.
    if (err && err.code === '40001') {
      const order = await withUserClaims(req.user, (c) => getOrder(c, req.params.id))
      return [409, { error: strip(String(err.message || '')), stale: true, order }]
    }
    throw err
  }
}))
