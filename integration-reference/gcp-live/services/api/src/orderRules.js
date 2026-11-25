// Order request rules for the data API. Pure and dependency-free (unit-tested
// without a database). The database stays the authority -- RLS, the handoff
// guard (guard_order_handoff), payment confirmation and amount guards all still
// run on every write. These rules reject malformed input before it reaches SQL,
// build a new order's initial state on the server (the INSERT path is only
// amount-guarded in the database), and close the columns the handoff guard does
// not police: a production user may move an order through the pipeline, never
// re-price, re-prioritise, re-date or re-plan it.

export class OrderInputError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
const bad = (message) => new OrderInputError(400, message)
const denied = (message) => new OrderInputError(403, message)

// Mirrors of the database enums and the pipeline (packages/domain ROLE_SEQUENCE).
export const STAGES = ['screener', 'examiner', 'searchqc', 'typer', 'qc', 'delivery']
const STATUSES = ['received', 'screening', 'searching', 'examining', 'typing', 'delivered', 'onhold', 'delivery', 'cancelled', 'qc', 'searchqc']
const PRIORITIES = ['normal', 'rush']
const DESKS = ['admin', 'screener', 'examiner', 'typer', 'delivery', 'client', 'user']
const PAYMENT_METHODS = ['Check', 'ACH']          // src/lib/billing.js PAYMENT_METHODS
const CLARIFICATION = ['pending', 'responded']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE = /^\d{4}-\d{2}-\d{2}$/
const STAMP = /^\d{4}-\d{2}-\d{2}/
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})$/

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

function str(v, name, max, { nullable = true, required = false } = {}) {
  if (v === undefined || v === null) {
    if (required) throw bad(`${name} is required`)
    if (!nullable && v === null) throw bad(`${name} must be text`)
    return null
  }
  if (typeof v !== 'string') throw bad(`${name} must be text`)
  const t = v.trim()
  if (required && !t) throw bad(`${name} is required`)
  if (t.length > max) throw bad(`${name} is too long`)
  return t
}
const oneOf = (v, name, list) => { if (!list.includes(v)) throw bad(`${name} is not a valid value`); return v }
function dateOrNull(v, name) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v !== 'string' || !DATE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) throw bad(`${name} must be a date (YYYY-MM-DD)`)
  return v
}
function jsonSize(v, name, max) {
  if (JSON.stringify(v).length > max) throw bad(`${name} is too large`)
  return v
}

// ── Create ────────────────────────────────────────────────────────────────────
// What the place-order screens send (ClientDashboard, AdminPlaceOrder,
// BulkImport). The intake is display data the order carries for Admin and the
// production desk; it never decides identity, price or state.
const INTAKE_TEXT = ['propertyAddress', 'parcelNumberAPN', 'borrowerName', 'buyer', 'seller', 'propertyType',
  'customSearch', 'orderType', 'from', 'company', 'role', 'specialInstructions', 'contactPhone', 'placedByAdmin']
const INTAKE_KEYS = new Set(['source', 'parties', 'placedBy', 'lineItems', ...INTAKE_TEXT])
const LINE_TEXT = ['searchType', 'propertyType', 'address', 'city', 'state', 'county', 'zip', 'parcelId',
  'buyer', 'seller', 'borrower', 'clientFileNo', 'notes']
const LINE_KEYS = new Set(['n', ...LINE_TEXT])
// Portal sources only: 'email' and 'website' are the intake services' own and
// carry Admin-only review metadata; a portal caller cannot claim them.
const PORTAL_SOURCES = ['web', 'web-bulk']

function sanitizeIntake(raw, { admin }) {
  if (raw === undefined || raw === null) raw = {}
  if (!isObj(raw)) throw bad('intake must be an object')
  for (const k of Object.keys(raw)) if (!INTAKE_KEYS.has(k)) throw bad(`unknown intake field: ${k}`)
  if (own(raw, 'placedByAdmin') && !admin) throw denied('only an administrator places an order on a client\'s behalf')
  const out = { source: raw.source === undefined ? 'web' : oneOf(raw.source, 'intake.source', PORTAL_SOURCES) }
  for (const k of INTAKE_TEXT) if (own(raw, k)) out[k] = str(raw[k], `intake.${k}`, 4000)
  if (own(raw, 'parties')) {
    if (!Array.isArray(raw.parties) || raw.parties.length > 50) throw bad('intake.parties must be a list of at most 50')
    out.parties = raw.parties.map((p) => {
      if (!isObj(p) || Object.keys(p).some((k) => k !== 'role' && k !== 'name')) throw bad('intake.parties entries are { role, name }')
      return { role: str(p.role, 'party role', 100), name: str(p.name, 'party name', 300) }
    })
  }
  if (own(raw, 'placedBy')) {
    const p = raw.placedBy
    if (p === null) out.placedBy = null
    else {
      if (!isObj(p) || Object.keys(p).some((k) => !['id', 'name', 'email', 'title'].includes(k))) throw bad('intake.placedBy is { id, name, email, title }')
      out.placedBy = { id: str(p.id, 'placedBy.id', 100), name: str(p.name, 'placedBy.name', 300), email: str(p.email, 'placedBy.email', 320), title: str(p.title, 'placedBy.title', 200) }
    }
  }
  if (own(raw, 'lineItems')) {
    if (!Array.isArray(raw.lineItems) || raw.lineItems.length > 200) throw bad('intake.lineItems must be a list of at most 200')
    out.lineItems = raw.lineItems.map((li) => {
      if (!isObj(li)) throw bad('intake.lineItems entries must be objects')
      for (const k of Object.keys(li)) if (!LINE_KEYS.has(k)) throw bad(`unknown line item field: ${k}`)
      const item = {}
      if (own(li, 'n')) { if (!Number.isInteger(li.n) || li.n < 1 || li.n > 1000) throw bad('line item n must be a positive integer'); item.n = li.n }
      for (const k of LINE_TEXT) if (own(li, k)) item[k] = str(li[k], `line item ${k}`, 2000)
      return item
    })
  }
  return out
}

const CREATE_KEYS = new Set(['clientCode', 'state', 'county', 'type', 'priority', 'payment', 'clientFileNo', 'intake'])

// -> the validated fields of a NEW order. Everything else about its initial
// state (id, status, desk, progress, dates, workflow) is fixed by the insert.
export function validateCreate(body, { admin }) {
  if (!isObj(body)) throw bad('expected a JSON object')
  for (const k of Object.keys(body)) if (!CREATE_KEYS.has(k)) throw bad(`unknown field: ${k}`)
  const state = str(body.state, 'state', 2, { required: true })
  if (!/^[A-Z]{2}$/.test(state)) throw bad('state must be a two-letter code')
  return {
    clientCode: str(body.clientCode, 'clientCode', 40) || null,
    state,
    county: str(body.county, 'county', 120) || '',
    type: str(body.type, 'type', 120) || 'Full Search',
    priority: body.priority === undefined ? 'normal' : oneOf(body.priority, 'priority', PRIORITIES),
    payment: body.payment === undefined ? 'Check' : oneOf(body.payment, 'payment', PAYMENT_METHODS),
    clientFileNo: str(body.clientFileNo, 'clientFileNo', 100) || null,
    intake: jsonSize(sanitizeIntake(body.intake, { admin }), 'intake', 64000),
  }
}

// ── Update ────────────────────────────────────────────────────────────────────
// The writable columns -- exactly what the Supabase provider's saveOrder sends
// (toOrderRow). Identity and placement (id, client, state, county, type,
// created) are not writable here at all.
export const UPDATE_COLUMNS = {
  status: 'status', priority: 'priority', payment: 'payment', clarification: 'clarification',
  clientFileNo: 'client_file_no', assignedTo: 'assigned_to', assignedUserId: 'assigned_user_id',
  screener: 'screener', examiner: 'examiner', typer: 'typer', delivery: 'delivery',
  progress: 'progress', eta: 'eta', completed: 'completed',
  completedDates: 'completed_dates', completedBy: 'completed_by', workflow: 'workflow',
}

function stageMap(v, name, value) {
  if (!isObj(v)) throw bad(`${name} must be an object`)
  for (const [k, x] of Object.entries(v)) {
    if (!STAGES.includes(k)) throw bad(`${name} has an unknown stage: ${k}`)
    if (x !== null) value(x, `${name}.${k}`)
  }
  return v
}

// -> { baseline, changes } with every present field type-checked. `updatedAt`
// is the version the caller last saw; it is required (the optimistic lock).
export function validatePatch(body) {
  if (!isObj(body)) throw bad('expected a JSON object')
  const { updatedAt, ...rest } = body
  if (typeof updatedAt !== 'string' || !TIMESTAMP.test(updatedAt)) throw bad('updatedAt (the version you last saw) is required')
  const changes = {}
  for (const [k, v] of Object.entries(rest)) {
    if (!own(UPDATE_COLUMNS, k)) throw bad(`field cannot be changed: ${k}`)
    switch (k) {
      case 'status': changes[k] = oneOf(v, k, STATUSES); break
      case 'priority': changes[k] = oneOf(v, k, PRIORITIES); break
      case 'payment': changes[k] = str(v, k, 40); break
      case 'clarification': changes[k] = v === null ? null : oneOf(v, k, CLARIFICATION); break
      case 'clientFileNo': changes[k] = str(v, k, 100) || null; break
      case 'assignedTo': changes[k] = v === null ? null : oneOf(v, k, DESKS); break
      case 'assignedUserId':
        if (v !== null && (typeof v !== 'string' || !UUID.test(v))) throw bad('assignedUserId must be a user id')
        changes[k] = v === null ? null : v.toLowerCase(); break
      case 'screener': case 'examiner': case 'typer': case 'delivery': changes[k] = str(v, k, 200); break
      case 'progress':
        if (!Number.isInteger(v) || v < 0 || v > 100) throw bad('progress must be a whole number from 0 to 100')
        changes[k] = v; break
      case 'eta': case 'completed': changes[k] = dateOrNull(v, k); break
      case 'completedDates':
        changes[k] = stageMap(v, k, (x, n) => { if (typeof x !== 'string' || !STAMP.test(x) || x.length > 40) throw bad(`${n} must be a date`) }); break
      case 'completedBy':
        changes[k] = stageMap(v, k, (x, n) => { if (typeof x !== 'string' || x.length > 200) throw bad(`${n} must be a name`) }); break
      case 'workflow':
        if (!isObj(v)) throw bad('workflow must be an object')
        changes[k] = jsonSize(v, k, 200000); break
    }
  }
  return { baseline: updatedAt, changes }
}

// Stable JSON for comparing values regardless of key order (jsonb reorders keys).
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isObj(v)) return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`
  return JSON.stringify(v === undefined ? null : v)
}
const same = (a, b) => canonical(a ?? null) === canonical(b ?? null)

// What a production user may change: the pipeline position and their own
// stage's work. The handoff guard decides whether the MOVE is legitimate.
const PRODUCTION_FIELDS = new Set(['status', 'assignedTo', 'assignedUserId', 'progress', 'completed',
  'completedDates', 'completedBy', 'workflow', 'screener', 'examiner', 'typer', 'delivery'])
// Workflow keys owned by Admin / billing / the client. A production user's
// write must leave each exactly as stored -- except the stage-owned ones below.
export const ADMIN_WORKFLOW_KEYS = ['stagePlan', 'singleSeating', 'intake', 'confirmed', 'confirmedAt', 'confirmedBy',
  'invoiceAmount', 'invoicedAt', 'invoiceVisibleToClient', 'payment', 'abstractorFee', 'onHold', 'holdReason', 'holdBy',
  'holdAt', 'clarificationNote', 'cancelRequested', 'clientDocs']
// Set by production as part of completing a stage, in that same write only: the
// typer finalises the invoice total (FulfillmentScreen), delivery decides
// whether the client sees the invoice (the Production Desk's delivery step).
const STAGE_OWNED = { invoiceAmount: 'typer', invoicedAt: 'typer', invoiceVisibleToClient: 'delivery' }

// `current` is the stored order in app shape. Throws 403 naming the first field
// a production user tried to change but may not.
export function assertProductionChanges(changes, current) {
  for (const [k, v] of Object.entries(changes)) {
    if (PRODUCTION_FIELDS.has(k)) continue
    if (!same(v, current[k])) throw denied(`a production user cannot change ${k}`)
  }
  if (own(changes, 'workflow')) {
    const before = current.workflow || {}
    const stamps = (stage) => !!(changes.completedDates && changes.completedDates[stage]) && !(current.completedDates || {})[stage]
    for (const k of ADMIN_WORKFLOW_KEYS) {
      if (STAGE_OWNED[k] && stamps(STAGE_OWNED[k])) continue
      if (!same(changes.workflow[k], before[k])) throw denied(`a production user cannot change workflow.${k}`)
    }
  }
}

// A client's payment is reported and decided only through the payment
// endpoints (routes/payments.js; payment_report / payment_verify): an order
// save may carry the stored payment unchanged, or leave it out, never change it.
export function assertPaymentUnchanged(changes, current) {
  if (!own(changes, 'workflow') || !own(changes.workflow, 'payment')) return
  if (!same(changes.workflow.payment, (current.workflow || {}).payment)) {
    throw denied('a payment is reported by the client and confirmed or bounced by the billing owner in Billing, not by editing the order')
  }
}

// How a completed package may be delivered on this service. There is no email
// provider, so an "emailed" delivery could only ever be a claim nobody sent:
// a write that records any other method is refused (an older stored value is
// left as it is).
export const DELIVERY_METHODS = ['portal']
export function assertDeliveryMethod(changes, current) {
  if (!own(changes, 'workflow')) return
  const next = changes.workflow.deliveryMethod
  if (next === undefined || next === null || same(next, (current.workflow || {}).deliveryMethod)) return
  if (!DELIVERY_METHODS.includes(next)) {
    throw bad('email delivery is not connected on this service: deliver through the client portal (deliveryMethod "portal")')
  }
}

// The production-user ids an admin write points the order at: the desk owner
// and every stage-plan slot. Each must be an active production account.
export function assignedIds(changes, current) {
  const ids = new Set()
  if (own(changes, 'assignedUserId') && changes.assignedUserId && changes.assignedUserId !== current.assignedUserId) ids.add(changes.assignedUserId)
  const plan = own(changes, 'workflow') ? changes.workflow.stagePlan : undefined
  if (plan !== undefined && !same(plan, (current.workflow || {}).stagePlan)) {
    if (plan !== null && !isObj(plan)) throw bad('workflow.stagePlan must be an object')
    for (const [stage, id] of Object.entries(plan || {})) {
      if (!STAGES.includes(stage)) throw bad(`workflow.stagePlan has an unknown stage: ${stage}`)
      if (id === null || id === '') continue
      if (typeof id !== 'string' || !UUID.test(id)) throw bad(`workflow.stagePlan.${stage} must be a user id`)
      ids.add(id.toLowerCase())
    }
  }
  return [...ids]
}
