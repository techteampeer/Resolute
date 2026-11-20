// Order-document routes (B3), a documents sub-resource under an order. Enforces
// delivery-only release SERVER-SIDE: staff see the whole paper trail; a client
// sees only what Delivery released. The order read is RLS-scoped (orders_read),
// so a client only reaches documents on an order they own.
//
// VERIFIABLE IN-REPO SLICE: the authorization is wired + tested. The actual bytes
// — GCS upload and short-lived signed-url generation — live in the deployed
// snapshot (ADR 0003 B3/B5), so `open` fails safe with a 501 once authorized,
// never a public or stored url.
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { getOrder } from '../repositories/orders.js'
import { collectOrderDocs, authorizedDocs } from '../orderDocs.js'

export const documentsRouter = Router({ mergeParams: true })

// GET /api/orders/:orderId/documents — the documents THIS caller may view.
documentsRouter.get('/', async (req, res, next) => {
  try {
    const isStaff = req.user.role !== 'client'
    const order = await withUserClaims(req.user, (c) => getOrder(c, req.params.orderId))
    if (!order) return res.status(404).json({ error: 'not found' }) // not visible under RLS
    res.json(authorizedDocs(order, { isStaff }))
  } catch (err) {
    next(err)
  }
})

// POST /api/orders/:orderId/documents/:docId/open — authorize opening one doc.
//   404 order not visible / no such doc · 403 a client asking for a doc Delivery
//   did not release · 501 once authorized (GCS signing is env-gated).
documentsRouter.post('/:docId/open', async (req, res, next) => {
  try {
    const isStaff = req.user.role !== 'client'
    const order = await withUserClaims(req.user, (c) => getOrder(c, req.params.orderId))
    if (!order) return res.status(404).json({ error: 'not found' })
    const doc = collectOrderDocs(order).find((d) => d.id === req.params.docId)
    if (!doc) return res.status(404).json({ error: 'document not found' })
    if (!authorizedDocs(order, { isStaff }).some((d) => d.id === doc.id)) {
      return res.status(403).json({ error: 'this document has not been released to you' })
    }
    return res.status(501).json({ error: 'document signing is not wired on the GCP backend yet (GCS — ADR 0003 B3/B5).' })
  } catch (err) {
    next(err)
  }
})
