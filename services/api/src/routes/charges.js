// Additional-fee routes (B1), a charges sub-resource under an order. Thin
// adapters: a fast role pre-check, authoritative validation, then the repository
// inside the caller's claims transaction (where RLS is the real guard). Mounted
// with mergeParams so :orderId from the parent path is visible here.
//
// Authorization (B1 spec §4), enforced twice — a clear 403 here, RLS inside:
//   Raise             → admin or production `user` (owner, via RLS); client 403.
//   Approve / Decline → the owning client only; any staff 403.
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { raiseCharge, resolveCharge } from '../repositories/charges.js'
import { validateRaise, validateDecision } from '../charges.js'
import { HttpError } from '../errors.js'

export const chargesRouter = Router({ mergeParams: true })

// POST /api/orders/:orderId/charges — staff raise a pending fee.
chargesRouter.post('/', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'user') {
      return res.status(403).json({ error: 'only staff can raise a fee' })
    }
    const v = validateRaise(req.body)
    if (!v.ok) return res.status(422).json({ error: v.message })

    const order = await withUserClaims(req.user, (client) =>
      raiseCharge(client, req.params.orderId, { label: v.label, amount: v.amount, user: req.user }))
    res.status(201).json(order)
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})

// POST /api/orders/:orderId/charges/:chargeId/resolve — owning client decides.
chargesRouter.post('/:chargeId/resolve', async (req, res, next) => {
  try {
    if (req.user.role !== 'client') {
      return res.status(403).json({ error: 'only the owning client can resolve a fee' })
    }
    const decision = req.body?.decision
    if (!validateDecision(decision)) {
      return res.status(422).json({ error: 'decision must be approved or declined' })
    }

    const order = await withUserClaims(req.user, (client) =>
      resolveCharge(client, req.params.orderId, req.params.chargeId, decision))
    res.status(200).json(order)
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})
