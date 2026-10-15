// Orders routes. Thin adapters: resolve the request to a user, run the
// repository inside that user's claims transaction, return app-shaped JSON.
// This is the pattern every other resource (support, fulfillment, billing, …)
// replicates as B2 continues.
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { listOrders, getOrder } from '../repositories/orders.js'

export const ordersRouter = Router()

ordersRouter.get('/', async (req, res, next) => {
  try {
    const data = await withUserClaims(req.user, (client) => listOrders(client))
    res.json(data)
  } catch (err) {
    next(err)
  }
})

ordersRouter.get('/:id', async (req, res, next) => {
  try {
    const order = await withUserClaims(req.user, (client) => getOrder(client, req.params.id))
    if (!order) return res.status(404).json({ error: 'not found' })
    res.json(order)
  } catch (err) {
    next(err)
  }
})
