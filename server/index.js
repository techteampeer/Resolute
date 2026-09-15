import express from 'express'
import cookieParser from 'cookie-parser'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import authRoutes from './routes/auth.js'
import dataRoutes from './routes/data.js'
import documentRoutes from './routes/documents.js'
import adminRoutes from './routes/admin.js'
import eventRoutes from './routes/events.js'

/**
 * The portal server: one container serving the built SPA and the API it talks to.
 *
 * This tier exists because the SPA cannot do any of the four things the GCP move
 * requires. A browser cannot open a Postgres socket, cannot hold database
 * credentials, cannot verify a Firebase session cookie, and cannot sign a Cloud
 * Storage URL without publishing the signing credential to every visitor. All of
 * that lives here, and the SPA talks to it over HTTP with an httpOnly cookie.
 */
const app = express()
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist')

app.disable('x-powered-by')
app.use(express.json({ limit: '2mb' }))
app.use(cookieParser())

// Cloud Run terminates TLS at the proxy, so `secure` cookies need the app to
// trust the forwarded protocol or they are never set.
app.set('trust proxy', 1)

app.get('/healthz', (_req, res) => res.json({ ok: true }))

app.use('/api/auth', authRoutes)
app.use('/api/documents', documentRoutes)
app.use('/api/admin', adminRoutes)
app.use('/api/events', eventRoutes)
app.use('/api', dataRoutes)

// Anything under /api that got this far does not exist. Without this it would
// fall through to the SPA handler below and answer with index.html, so a typo'd
// endpoint would surface as a JSON parse error rather than a plain 404.
// An anonymous caller sees 401 instead, because the routers above authenticate
// first — which is the better order: it does not tell a stranger which
// endpoints exist.
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))

// Hashed asset filenames are content-addressed and safe to cache forever;
// index.html must never be, or a deploy does not reach anyone already loaded.
app.use('/assets', express.static(path.join(dist, 'assets'), {
  immutable: true, maxAge: '1y',
}))
app.use(express.static(dist, { index: false, maxAge: '1h' }))

// SPA fallback: client-side routes (/admin, /typer/…) are not files on disk.
// A path-less app.use rather than app.get('*'): Express 5 routes through
// path-to-regexp 8, where a bare '*' is no longer a valid pattern and throws at
// startup ("Missing parameter name at index 1").
app.use((_req, res) => {
  res.set('Cache-Control', 'no-cache, must-revalidate')
  res.sendFile(path.join(dist, 'index.html'))
})

const port = Number(process.env.PORT || 8080)
app.listen(port, '0.0.0.0', () => console.log(`[portal] listening on ${port}`))
