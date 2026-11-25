// Request rules for portal messages, the activity feed and notification read
// state. Pure and dependency-free (unit-tested without a database). Nothing
// here decides who may do what: the database sets a message's sender, author
// and client code from the caller's own profile and the existing RLS policies
// decide (gcp/02_post_migrate.sql section 11). This only refuses malformed
// requests early, with a sentence the caller can act on.

export class CommsInputError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = (message) => new CommsInputError(400, message)

export const MAX_MESSAGE_CHARS = 4000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const CLIENT_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const MESSAGE_FIELDS = ['orderId', 'clientCode', 'text', 'visibility', 'requestId']

// POST /api/messages body -> { orderId, clientCode, text, visibility, requestId }.
// Who sent it is never part of the request: a sender, author or attachment is
// refused rather than ignored, so a forged one is visible as a refusal.
export function validateMessage(body) {
  if (!isObj(body)) throw bad('expected a JSON object')
  for (const k of Object.keys(body)) {
    if (MESSAGE_FIELDS.includes(k)) continue
    if (k === 'attachment') throw bad('message attachments are not available yet')
    if (['author', 'authorId', 'sender', 'from', 'createdAt', 'id'].includes(k)) {
      throw bad(`${k} is decided by the server from your account, not by the request`)
    }
    throw bad(`unknown field: ${k}`)
  }
  const orderId = body.orderId ?? null
  if (orderId !== null && (typeof orderId !== 'string' || !ORDER_ID.test(orderId))) throw bad('orderId is invalid')
  const clientCode = body.clientCode ?? null
  if (clientCode !== null && (typeof clientCode !== 'string' || !CLIENT_CODE.test(clientCode))) throw bad('clientCode is invalid')
  if (orderId && clientCode) throw bad('give an orderId or a clientCode, not both')
  if (typeof body.text !== 'string') throw bad('text is required')
  const text = body.text.trim()
  if (!text || text.length > MAX_MESSAGE_CHARS) throw bad(`a message must be 1 to ${MAX_MESSAGE_CHARS} characters`)
  if (CONTROL.test(text)) throw bad('the message contains control characters')
  const visibility = body.visibility ?? 'client'
  if (visibility !== 'client' && visibility !== 'internal') throw bad('visibility must be "client" or "internal"')
  const requestId = body.requestId ?? null
  if (requestId !== null && (typeof requestId !== 'string' || !UUID.test(requestId))) throw bad('requestId must be a UUID')
  return { orderId, clientCode, text, visibility, requestId: requestId && requestId.toLowerCase() }
}

// The text of a message that rides on another action (an order change, a
// clarification answer): the same rules as a message's own text.
export function messageText(v) {
  if (typeof v !== 'string') throw bad('the message must be text')
  const text = v.trim()
  if (!text || text.length > MAX_MESSAGE_CHARS) throw bad(`a message must be 1 to ${MAX_MESSAGE_CHARS} characters`)
  if (CONTROL.test(text)) throw bad('the message contains control characters')
  return text
}

// GET ?orderId= for a thread (null = every conversation the caller may read).
export function threadQuery(q) {
  const orderId = q && q.orderId !== undefined && q.orderId !== '' ? q.orderId : null
  if (orderId !== null && (typeof orderId !== 'string' || !ORDER_ID.test(orderId))) throw bad('orderId is invalid')
  return { orderId }
}

// POST /api/notifications/read body -> the ids (as decimal strings) to mark.
export function validateReadIds(body) {
  if (!isObj(body) || !Array.isArray(body.ids)) throw bad('ids must be a list')
  if (body.ids.length < 1 || body.ids.length > 500) throw bad('ids must hold 1 to 500 notification ids')
  return body.ids.map((id) => {
    const s = typeof id === 'number' && Number.isSafeInteger(id) ? String(id) : id
    if (typeof s !== 'string' || !/^[1-9][0-9]{0,17}$/.test(s)) throw bad('ids must be notification ids')
    return s
  })
}

// ?limit= -> a whole number within [1, max] (def when absent).
export function parseLimit(raw, def, max) {
  if (raw === undefined || raw === '') return def
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1) throw bad('limit must be a positive whole number')
  return Math.min(n, max)
}
