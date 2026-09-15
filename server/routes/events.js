import { Router } from 'express'
import pg from 'pg'
import { requireUser } from '../lib/auth.js'

const r = Router()

/**
 * Change notifications as Server-Sent Events, replacing Supabase Realtime.
 *
 * One dedicated connection LISTENs (a listening client cannot be returned to the
 * pool — it is blocked for the life of the subscription) and fans out to every
 * connected browser. The payload carries only the table and a row id: the client
 * refetches through the API, where RLS applies. Pushing row data down this
 * channel would leak it, since NOTIFY has no row-level security and every
 * listener receives every message.
 */
const clients = new Set()
let listener = null

async function startListening() {
  if (listener) return
  const instance = process.env.INSTANCE_CONNECTION_NAME
  listener = new pg.Client({
    user: process.env.DB_USER,
    password: process.env.DB_PASS,
    database: process.env.DB_NAME,
    ...(instance
      ? { host: `/cloudsql/${instance}` }
      : { host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 5432) }),
  })

  listener.on('notification', (msg) => {
    for (const res of clients) {
      try { res.write(`data: ${msg.payload}\n\n`) } catch { clients.delete(res) }
    }
  })

  // A dropped listener means silent staleness — the UI would simply stop
  // updating with nothing in the logs — so reconnect rather than swallow it.
  listener.on('error', (err) => {
    console.error('[events] listener error, reconnecting', err)
    listener = null
    setTimeout(() => startListening().catch(() => {}), 2000)
  })

  await listener.connect()
  await listener.query('listen portal_changes')
}

r.get('/stream', requireUser, async (req, res) => {
  try {
    await startListening()
  } catch (err) {
    console.error('[events] could not listen', err)
    return res.status(503).end()
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // Cloud Run buffers responses unless told otherwise; without this the
    // stream arrives in chunks long after the event.
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 5000\n\n')
  clients.add(res)

  // Idle proxies close a quiet connection; a comment line keeps it open and is
  // ignored by EventSource.
  const ping = setInterval(() => { try { res.write(': ping\n\n') } catch { /* closed */ } }, 25_000)
  req.on('close', () => { clearInterval(ping); clients.delete(res) })
})

export default r
