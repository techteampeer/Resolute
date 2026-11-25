// In-app notifications: the caller's own, newest first, and their read state.
// Created only by the database alongside the event or message they announce
// (gcp/02_post_migrate.sql section 11); nothing here can create one, and the
// read-state functions touch the caller's own rows alone.
//   GET  /api/notifications[?limit=]   -> { notifications, unread }
//   POST /api/notifications/read       { ids } -> { updated }
//   POST /api/notifications/read-all   -> { updated }
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import { listNotifications, markRead, markAllRead } from '../repositories/notifications.js'
import { toAppNotification } from '../mappers.js'
import { CommsInputError, parseLimit, validateReadIds } from '../commsRules.js'

export const notificationsRouter = Router()

const handle = (fn) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    const [status, body] = await fn(req)
    return res.status(status).json(body)
  } catch (err) {
    if (err instanceof CommsInputError) return res.status(err.status).json({ error: err.message })
    if (err && err.code === '22023') return res.status(400).json({ error: 'invalid request' })
    return next(err)
  }
}

notificationsRouter.get('/', handle(async (req) => {
  const limit = parseLimit(req.query.limit, 50, 100)
  return withUserClaims(req.user, async (c) => {
    const { rows, unread } = await listNotifications(c, limit)
    return [200, { notifications: rows.map(toAppNotification), unread }]
  })
}))

notificationsRouter.post('/read', handle(async (req) => {
  const ids = validateReadIds(req.body)
  return withUserClaims(req.user, async (c) => [200, { updated: await markRead(c, ids) }])
}))

notificationsRouter.post('/read-all', handle(async (req) => withUserClaims(req.user, async (c) => [200, { updated: await markAllRead(c) }])))
