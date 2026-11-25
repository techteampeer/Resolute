// The Express app: a health probe, the Firebase auth gate, and the resource
// routers. Kept as a factory so a test can build the app without listening.
import express from 'express'
import { verifyBearer, resolveAppUser } from './auth.js'
import { ordersRouter } from './routes/orders.js'
import { meRouter } from './routes/me.js'
import { adminUsersRouter } from './routes/adminUsers.js'
import { profilesRouter, clientsRouter } from './routes/directory.js'
import { documentsRouter } from './routes/documents.js'
import { fulfillmentRouter } from './routes/fulfillment.js'
import { messagesRouter } from './routes/messages.js'
import { activityRouter } from './routes/activity.js'
import { notificationsRouter } from './routes/notifications.js'
import { paymentsRouter } from './routes/payments.js'
import { companiesRouter } from './routes/companies.js'
import { gcsStorage } from './storage.js'
import { config } from './config.js'
import { corsFor } from './cors.js'

// `storage` is for tests only (an in-memory stand-in); the service itself uses
// the configured private bucket, or none -- document routes then answer 503.
export function createServer({ storage = config.documentsBucket ? gcsStorage(config.documentsBucket) : null } = {}) {
  const app = express()
  app.use(corsFor(config.corsOrigins))
  // A typer's commitment draft can outgrow the default 100 kB JSON limit.
  app.use('/api/orders/:id/fulfillment', express.json({ limit: '1mb' }))
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

  app.use('/api/me', meRouter)
  app.use('/api/orders', ordersRouter)
  app.use('/api/orders', fulfillmentRouter)
  app.use('/api/orders', paymentsRouter)
  app.use('/api', documentsRouter(storage))
  app.use('/api/messages', messagesRouter)
  app.use('/api', activityRouter)
  app.use('/api/notifications', notificationsRouter)
  app.use('/api/admin/users', adminUsersRouter)
  app.use('/api/profiles', profilesRouter)
  app.use('/api/clients', clientsRouter)
  app.use('/api', companiesRouter)

  // Error handler. Log the real reason server-side; never leak internals to the
  // client (the Supabase provider learned this the hard way — see refusalText).
  // A malformed or oversized request body (express.json) is the client's 4xx.
  app.use((err, _req, res, _next) => {
    if (err && err.expose && err.status >= 400 && err.status < 500) {
      return res.status(err.status).json({ error: 'invalid request body' })
    }
    console.error('[api]', (err && err.message) || err)
    return res.status(500).json({ error: 'internal error' })
  })

  return app
}
