// The Express app: a health probe, the Firebase auth gate, and the resource
// routers. Kept as a factory so a test can build the app without listening.
import express from 'express'
import { verifyBearer, resolveAppUser } from './auth.js'
import { ordersRouter } from './routes/orders.js'

export function createServer() {
  const app = express()
  app.use(express.json())

  // Liveness/readiness for Cloud Run — no auth.
  app.get('/healthz', (_req, res) => res.json({ ok: true }))

  // Auth gate for everything under /api: a verified Firebase token that resolves
  // to a provisioned profile. req.user = { id: profiles.id, role, email }.
  app.use('/api', async (req, res, next) => {
    try {
      const decoded = await verifyBearer(req.headers.authorization)
      if (!decoded) return res.status(401).json({ error: 'unauthenticated' })
      const user = await resolveAppUser(decoded)
      if (!user) return res.status(403).json({ error: 'no profile for this account' })
      req.user = user
      return next()
    } catch (err) {
      return next(err)
    }
  })

  app.use('/api/orders', ordersRouter)

  // Error handler. Log the real reason server-side; never leak internals to the
  // client (the Supabase provider learned this the hard way — see refusalText).
  app.use((err, _req, res, _next) => {
    console.error('[api]', (err && err.message) || err)
    res.status(500).json({ error: 'internal error' })
  })

  return app
}
