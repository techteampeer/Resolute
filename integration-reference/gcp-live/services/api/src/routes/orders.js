// Orders routes. Thin adapters: validate the request (orderRules), run the
// repository inside the caller's claims transaction, return app-shaped JSON.
// Who may do what is decided by the database -- RLS, guard_order_handoff,
// guard_payment_confirmation, guard_payment_writes, guard_order_amounts and the
// status-aware role helpers -- with orderRules closing the columns those
// triggers leave open. Payments have their own routes (routes/payments.js).
//   GET    /             every order the caller may see
//   GET    /:id          one order; 404 whether absent or hidden
//   POST   /             place an order -> 201 order (server id, initial state)
//   PATCH  /:id          { updatedAt, ...fields, clientMessage? } -> 200 order | 409 stale | 403 | 404
//                        (clientMessage: Admin's note to the client about this
//                        change, stored in the SAME transaction -- both or neither)
//   POST   /:id/cancel   the client's own cancel -> 200 { mode, order }
//   POST   /:id/clarification-response   { text? } the client answered a clarification
//                        (with its reply, stored in the same transaction) -> 200 order
import { Router } from 'express'
import { withUserClaims } from '../db.js'
import {
  listOrders, getOrder, clientExists, insertOrder, updateOrder, versionMatches,
  activeProductionIds, clientCancel, clientRespondClarification,
} from '../repositories/orders.js'
import { callerAuthority } from '../repositories/profiles.js'
import {
  OrderInputError, validateCreate, validatePatch, assertProductionChanges, assertDeliveryMethod, assertPaymentUnchanged,
  assignedIds, UPDATE_COLUMNS,
} from '../orderRules.js'
import { insertMessage } from '../repositories/messages.js'
import { placerFor } from '../repositories/companies.js'
import { CommsInputError, messageText } from '../commsRules.js'

export const ordersRouter = Router()

const STALE = 'this order changed elsewhere — reloading the latest version'
const REFUSED = 'the database refused the change (you may no longer own this order)'

// A refusal the caller can act on, never internals. Rule exceptions raised by
// the order triggers (P0001) are the rule's own sentence; RLS and privilege
// refusals are one generic line; malformed values are 400. Anything else is a
// server error (logged by the app's error handler, never echoed).
function refusal(err) {
  if (err instanceof OrderInputError || err instanceof CommsInputError) return [err.status, err.message]
  switch (err && err.code) {
    case 'P0001': return /must be a number|out of range/.test(err.message) ? [400, err.message] : [403, err.message]
    case '42501': return [403, REFUSED]
    case '23503': return [400, 'a referenced client or user does not exist']
    case '22P02': case '22007': case '22008': case '22003': case '22023': case '23514': return [400, 'invalid value']
    default: return null
  }
}

const handle = (fn) => async (req, res, next) => {
  res.set('Cache-Control', 'no-store')
  try {
    const [status, body] = await fn(req)
    return res.status(status).json(body)
  } catch (err) {
    const r = refusal(err)
    if (r) return res.status(r[0]).json({ error: r[1] })
    return next(err)
  }
}

ordersRouter.get('/', handle(async (req) => [200, await withUserClaims(req.user, (c) => listOrders(c))]))

ordersRouter.get('/:id', handle(async (req) => {
  const order = await withUserClaims(req.user, (c) => getOrder(c, req.params.id))
  return order ? [200, order] : [404, { error: 'not found' }]
}))

// A client places an order for its OWN client account only; an administrator
// places one for any client in the directory. Production users do not place
// orders. The id, status, desk and everything past intake are the server's.
ordersRouter.post('/', handle(async (req) => {
  const order = await withUserClaims(req.user, async (c) => {
    const who = await callerAuthority(c)
    if (!who.admin && !who.client_code) {
      throw new OrderInputError(403, who.production ? 'production users do not place orders' : 'this account cannot place orders')
    }
    const f = validateCreate(req.body, { admin: !!who.admin })
    if (who.admin) {
      if (!f.clientCode) throw new OrderInputError(400, 'clientCode is required')
      if (!await clientExists(c, f.clientCode)) throw new OrderInputError(400, 'unknown client')
    } else {
      if (f.clientCode && f.clientCode !== who.client_code) throw new OrderInputError(403, 'you can only place orders for your own client account')
      f.clientCode = who.client_code
    }
    // "Placed by" names a live contact of this client; the order keeps the
    // directory's values as they are now -- a later edit never rewrites it.
    const placedBy = f.intake.placedBy
    if (placedBy) {
      const row = typeof placedBy.id === 'string' && /^[0-9a-f-]{36}$/i.test(placedBy.id) ? await placerFor(c, f.clientCode, placedBy.id) : null
      if (!row) throw new OrderInputError(400, 'placed by must be a person in this company\'s directory')
      f.intake.placedBy = { id: row.id, name: row.name, email: row.email, title: row.title }
    }
    return insertOrder(c, f)
  })
  return [201, order]
}))

// Update with the optimistic lock. Staff only: clients change their orders
// through the narrow client functions (cancel), never this route -- and the
// refusal is the same whatever the id, so it reveals nothing.
ordersRouter.patch('/:id', handle(async (req) => {
  const { id } = req.params
  const { clientMessage, ...patch } = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {}
  const note = clientMessage === undefined || clientMessage === null ? null : messageText(clientMessage)
  const { baseline, changes } = validatePatch(Array.isArray(req.body) ? req.body : patch)
  return withUserClaims(req.user, async (c) => {
    const who = await callerAuthority(c)
    if (!who.admin && !who.production) throw new OrderInputError(403, 'only staff change orders')
    if (note && !who.admin) throw new OrderInputError(403, 'only Admin writes to the client')
    // Admin's message to the client about this change: written after the change
    // in this transaction, so a refusal of either leaves neither.
    const tell = async () => { if (note) await insertMessage(c, { orderId: id, clientCode: null, text: note, visibility: 'client', requestId: null }) }
    const current = await getOrder(c, id)
    if (!current) return [404, { error: 'not found' }]
    // A stale write is a conflict first -- not a refusal of fields that only
    // differ because the order moved on (e.g. a client added an attachment).
    if (current.updatedAt !== baseline && (await versionMatches(c, id, baseline)) === false) {
      return [409, { error: STALE, stale: true, order: current }]
    }
    if (who.admin) {
      // Assignments must name real, active production accounts.
      const ids = assignedIds(changes, current)
      const active = await activeProductionIds(c, ids)
      if (ids.some((x) => !active.includes(x))) throw new OrderInputError(400, 'assignments must name active production users')
    } else {
      assertProductionChanges(changes, current)
    }
    assertDeliveryMethod(changes, current)
    assertPaymentUnchanged(changes, current)
    const set = Object.fromEntries(Object.entries(changes).map(([k, v]) => [UPDATE_COLUMNS[k], v]))
    if (!Object.keys(set).length) { await tell(); return [200, current] }
    const updated = await updateOrder(c, id, baseline, set)
    if (updated) { await tell(); return [200, updated] }
    // Nothing matched: stale (moved on), hidden, or refused by RLS. Never success.
    const matches = await versionMatches(c, id, baseline)
    if (matches === null) return [404, { error: 'not found' }]
    if (matches === false) return [409, { error: STALE, stale: true, order: await getOrder(c, id) }]
    return [403, { error: REFUSED }]
  })
}))

// The client's own cancel, through client_cancel_order(): immediate while the
// order is still queued, otherwise a request for Admin. Not found and not
// yours are the same answer.
ordersRouter.post('/:id/cancel', handle(async (req) => {
  const { id } = req.params
  return withUserClaims(req.user, async (c) => {
    const who = await callerAuthority(c)
    if (who.admin || who.production || !who.client_code) throw new OrderInputError(403, 'only the client who placed an order cancels it here')
    let mode
    try {
      mode = await clientCancel(c, id)
    } catch (err) {
      if (err && err.code === 'P0001') {
        if (/not cancellable/.test(err.message)) throw new OrderInputError(409, 'this order can no longer be cancelled')
        throw new OrderInputError(404, 'not found')
      }
      throw err
    }
    return [200, { mode, order: await getOrder(c, id) }]
  })
}))

// The client tells Admin it has answered a pending clarification (through
// client_respond_clarification(): its own order only; a no-op when nothing is
// pending). The activity trail and Admin's notification come from the database.
ordersRouter.post('/:id/clarification-response', handle(async (req) => {
  const { id } = req.params
  const raw = req.body && typeof req.body === 'object' ? req.body.text : undefined
  const reply = raw === undefined || raw === null ? null : messageText(raw)
  return withUserClaims(req.user, async (c) => {
    const who = await callerAuthority(c)
    if (who.admin || who.production || !who.client_code) throw new OrderInputError(403, 'only the order\'s client answers a clarification')
    try {
      await clientRespondClarification(c, id)
    } catch (err) {
      if (err && err.code === 'P0001') throw new OrderInputError(404, 'not found')
      throw err
    }
    // The reply itself, in the same transaction: Admin is told once.
    if (reply) await insertMessage(c, { orderId: id, clientCode: null, text: reply, visibility: 'client', requestId: null })
    return [200, await getOrder(c, id)]
  })
}))
