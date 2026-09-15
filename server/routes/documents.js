import { Router } from 'express'
import multer from 'multer'
import { queryAs } from '../lib/db.js'
import { requireUser } from '../lib/auth.js'
import { upload as putObject, signedUrl, remove } from '../lib/storage.js'

const r = Router()
r.use(requireUser)

const mem = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } })

/**
 * Paths are always `orders/<orderId>/<timestamp>-<name>`, which is what lets the
 * owning order be recovered from a path and checked.
 */
const orderIdFromPath = (p) => {
  const m = /^orders\/([^/]+)\//.exec(String(p || ''))
  return m ? m[1] : null
}

/**
 * May this caller see that order? This IS the access check.
 *
 * Supabase enforced RLS policies on storage.objects, so the database decided who
 * could read a file. GCS does not consult Postgres, and a signed URL is a bearer
 * token. So every path is resolved back to its order and that order is read
 * through withUser: if RLS hides it, there is nothing to sign or overwrite.
 */
async function mayTouchOrder(profileId, orderId) {
  if (!orderId) return false
  const rows = await queryAs(profileId, 'select id from public.orders where id = $1', [orderId])
  return rows.length > 0
}

r.post('/', mem.single('file'), async (req, res) => {
  try {
    const orderId = req.body?.orderId
    if (!req.file || !orderId) return res.status(400).json({ error: 'Missing file or orderId' })
    if (!(await mayTouchOrder(req.user.profile_id, orderId))) {
      // 404 rather than 403: a document on an order they may not see and one
      // that does not exist should be indistinguishable.
      return res.status(404).json({ error: 'Order not found' })
    }
    const safe = req.file.originalname.replace(/[^\w.\-]+/g, '_')
    const path = `orders/${orderId}/${Date.now()}-${safe}`
    await putObject(path, req.file.buffer, req.file.mimetype || 'application/octet-stream')
    res.status(201).json({ path, url: await signedUrl(path, 3600) })
  } catch (err) {
    console.error('[documents] upload', err)
    res.status(500).json({ error: 'Upload failed' })
  }
})

r.post('/sign', async (req, res) => {
  try {
    const path = req.body?.path
    if (!(await mayTouchOrder(req.user.profile_id, orderIdFromPath(path)))) {
      return res.status(404).json({ error: 'Not found' })
    }
    res.json({ url: await signedUrl(path, 3600) })
  } catch (err) {
    console.error('[documents] sign', err)
    res.status(500).json({ error: 'Could not sign' })
  }
})

r.delete('/', async (req, res) => {
  try {
    const path = req.body?.path
    if (!(await mayTouchOrder(req.user.profile_id, orderIdFromPath(path)))) {
      return res.status(404).json({ error: 'Not found' })
    }
    await remove(path)
    res.json({ ok: true })
  } catch (err) {
    console.error('[documents] remove', err)
    res.status(500).json({ error: 'Could not remove' })
  }
})

export default r
