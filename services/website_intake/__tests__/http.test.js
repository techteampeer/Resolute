// HTTP adapter tests for POST /api/orders/website-intake past the auth gate:
// how each intake result maps to a status code and body, and that a failure
// never leaks internals. The service-role client and the store are replaced
// with fakes for this file only — no Supabase, no network.
import { test, vi, beforeEach } from 'vitest'
import assert from 'node:assert/strict'

const h = vi.hoisted(() => ({ deps: null }))
vi.mock('../../../api/_lib/supabaseAdmin.js', () => ({ hasSupabaseAdmin: true, supabaseAdmin: null }))
vi.mock('../../email_intake/store.js', () => ({ createDeps: () => h.deps }))

const { default: handler } = await import('../../../api/orders/website-intake.js')

const SUBMISSION = '7c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f'
const payload = (extra = {}) => ({
  submissionId: SUBMISSION,
  businessName: 'Lakewood Title Group',
  contactName: 'Dana Whitfield',
  workEmail: 'dana@lakewoodtitle.com',
  propertyState: 'Texas',
  county: 'Harris',
  address: '880 Main St',
  city: 'Houston',
  product: 'Municipal Lien Search',
  priority: 'Standard',
  ...extra,
})

const ORDER = { id: 'RES-10049', status: 'received', assigned_to: 'admin', client_code: 'CL01', type: 'Municipal Lien Search' }

beforeEach(() => {
  h.deps = {
    today: () => '2026-10-14',
    findByMessageId: async () => null,
    createIntakeOrder: async () => ({ status: 'created', clientMatch: 'name', clientCode: 'CL01', order: ORDER }),
  }
})

async function post(body, headers = { 'x-intake-secret': 'w3bsite' }) {
  const saved = process.env.WEBSITE_INTAKE_API_SECRET
  process.env.WEBSITE_INTAKE_API_SECRET = 'w3bsite'
  const out = {}
  const res = {
    status(code) { out.code = code; return this },
    json(b) { out.body = b; return this },
  }
  try { await handler({ method: 'POST', headers, body }, res) } finally {
    if (saved === undefined) delete process.env.WEBSITE_INTAKE_API_SECRET
    else process.env.WEBSITE_INTAKE_API_SECRET = saved
  }
  return out
}

test('a created order is a 201 with the order id and review flag', async () => {
  const out = await post(payload())
  assert.equal(out.code, 201)
  assert.deepEqual(out.body, {
    ok: true, duplicate: false, orderId: 'RES-10049', status: 'received', assignedTo: 'admin',
    clientCode: 'CL01', clientMatch: 'name', needsReview: true,
  })
})

test('a JSON string body is parsed like an object body', async () => {
  const out = await post(JSON.stringify(payload()))
  assert.equal(out.code, 201)
})

test('a duplicate submission is a 200 naming the existing order', async () => {
  h.deps.findByMessageId = async (id) => (id === `website:${SUBMISSION}` ? ORDER : null)
  let wrote = false
  h.deps.createIntakeOrder = async () => { wrote = true }
  const out = await post(payload())
  assert.equal(out.code, 200)
  assert.equal(out.body.duplicate, true)
  assert.equal(out.body.orderId, 'RES-10049')
  assert.equal(out.body.clientMatch, null)
  assert.equal(wrote, false)
})

test('an invalid payload is a 400 naming the field', async () => {
  const out = await post(payload({ workEmail: 'nope' }))
  assert.equal(out.code, 400)
  assert.equal(out.body.code, 'invalid_payload')
  assert.equal(out.body.field, 'workEmail')
})

test('an unsupported product name is a 400 for manual review', async () => {
  const out = await post(payload({ product: 'Full Search' }))
  assert.equal(out.code, 400)
  assert.equal(out.body.field, 'product')
})

test('an ambiguous company is a 422 for manual review', async () => {
  h.deps.createIntakeOrder = async () => ({ status: 'ambiguous', codes: ['CL01', 'CL09'] })
  const out = await post(payload())
  assert.equal(out.code, 422)
  assert.equal(out.body.code, 'ambiguous_client')
  assert.equal(out.body.field, 'businessName')
})

test('a database failure is a retryable 500 that leaks nothing', async () => {
  h.deps.createIntakeOrder = async () => { throw new Error('connect ECONNREFUSED postgres://service:s3cr3t@db.internal') }
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const out = await post(payload())
  spy.mockRestore()
  assert.equal(out.code, 500)
  assert.deepEqual(out.body, { error: 'Intake failed' })
  assert.ok(!JSON.stringify(out.body).includes('s3cr3t'))
})

test('a failed duplicate lookup is a retryable 500', async () => {
  h.deps.findByMessageId = async () => { throw new Error('timeout') }
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
  const out = await post(payload())
  spy.mockRestore()
  assert.equal(out.code, 500)
})
