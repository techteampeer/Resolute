// The typer's fulfillment draft for an order (the sectioned commitment form),
// saved as the typer works. Staff only; written only by an admin or the
// production user who owns the order (RLS fulfillments_write_owner admits the
// whole production pool -- this narrows it to the owner).
//   GET /api/orders/:id/fulfillment   -> { data } (null when nothing is saved yet)
//   PUT /api/orders/:id/fulfillment   { data } -> { ok: true }
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { getOrder } from '../repositories/orders.js'
import { callerAuthority } from '../repositories/profiles.js'
import { getFulfillment, saveFulfillment } from '../repositories/fulfillment.js'

export const fulfillmentRouter = Router()
const MAX_CHARS = 1_000_000
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

const handle = (fn) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    const [status, body] = await withUserClaims(req.user, (c) => fn(c, req))
    return res.status(status).json(body)
  } catch (err) {
    if (err && err.code === '42501') return res.status(403).json({ error: 'not allowed' })
    return next(err)
  }
}

fulfillmentRouter.get('/:id/fulfillment', handle(async (c, req) => {
  const who = await callerAuthority(c)
  if (!who.admin && !who.production) return [403, { error: 'staff only' }]
  if (!await getOrder(c, req.params.id)) return [404, { error: 'not found' }]
  return [200, { data: await getFulfillment(c, req.params.id) }]
}))

fulfillmentRouter.put('/:id/fulfillment', handle(async (c, req) => {
  const data = req.body && req.body.data
  if (!isObj(data) || JSON.stringify(data).length > MAX_CHARS) return [400, { error: 'data must be an object of at most 1 MB' }]
  const who = await callerAuthority(c)
  if (!who.admin && !who.production) return [403, { error: 'staff only' }]
  const order = await getOrder(c, req.params.id)
  if (!order) return [404, { error: 'not found' }]
  if (!who.admin && !(order.assignedTo === 'user' && order.assignedUserId === req.user.id)) {
    return [403, { error: 'only the order\'s production owner (or an admin) edits its fulfillment' }]
  }
  return (await saveFulfillment(c, req.params.id, data)) ? [200, { ok: true }] : [403, { error: 'not allowed' }]
}))
