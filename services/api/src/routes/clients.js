// Client-company routes (B2). Admin-only match-or-create a client by name.
// Thin adapter: role pre-check, request validation, then the repository inside
// the caller's claims transaction (where is_admin() + the per-name lock are the
// real guards).
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { createAdminClient } from '../repositories/clients.js'
import { validateCompanyCreate } from '../clients.js'
import { HttpError } from '../errors.js'

export const clientsRouter = Router()

// POST /api/clients — body { company, contact?, email? }. Returns the resolver:
//   created   → 201 { status:'created',   code, name }
//   matched   → 200 { status:'matched',   code, name }   (idempotent)
//   ambiguous → 200 { status:'ambiguous', codes }        (UI asks admin to pick)
// Non-admin → 403, invalid company → 422. 'ambiguous' stays 2xx on purpose: the
// client provider returns the body and the UI branches on status, so an
// ambiguous result must NOT read as a thrown error.
clientsRouter.post('/', async (req, res, next) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'only an admin can create a client' })
    }
    const v = validateCompanyCreate(req.body)
    if (!v.ok) return res.status(422).json({ error: v.message })

    const result = await withUserClaims(req.user, (client) =>
      createAdminClient(client, { company: v.company, contact: v.contact, email: v.email }))
    res.status(result?.status === 'created' ? 201 : 200).json(result)
  } catch (err) {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message })
    next(err)
  }
})
