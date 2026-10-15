// Unit tests for website order intake: validation, the order row, duplicate
// protection, client resolution, unsupported products and the HTTP adapter's
// auth gate. Run: npm test
// Everything is faked — no Supabase, no network, no Apps Script.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  validateWebsiteOrder, splitContactName, parseParties, toStateCode, STATES,
  WEBSITE_PRODUCTS, CUSTOM_SEARCH_TYPE, REQUIRED_FIELDS, FIELD_LIMITS, WEBSITE_MESSAGE_PREFIX,
} from '../schema.js'
import { US_STATES } from '../../../src/data/mockData.js'
import { processWebsiteIntake, buildWebsiteOrderRow } from '../intake.js'
import { normalizeCompanyName, normalizeMessageId, SEARCH_CATALOG } from '../../email_intake/schema.js'
import { buildOrderRow as buildEmailOrderRow } from '../../email_intake/intake.js'
import { orderSourceOf } from '../../../src/lib/orderSource.js'
import handler from '../../../api/orders/website-intake.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const SUBMISSION = '3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b'

// Exactly what resolute-website src/routes/order.tsx posts, plus the Apps
// Script's submissionId.
const payload = (extra = {}) => ({
  submittedAt: '2026-10-14T15:04:05.000Z',
  website: '',
  businessName: 'Lakewood Title Group',
  contactName: 'Dana Whitfield',
  workEmail: 'dana@lakewoodtitle.com',
  propertyState: 'Florida',
  county: 'Miami-Dade',
  address: '880 Main St',
  city: 'Miami',
  zip: '33101',
  parcelApn: '01-3125-001-0010',
  yourFileRef: 'LOAN-42',
  propertyType: 'Residential',
  parties: 'Buyer: Taylor Brooks; Seller: Avery Banks; Borrower: Jordan Reyes',
  searchType: 'Judgment & Lien Search',
  product: 'Judgment & Lien Search',
  customSearch: '',
  priority: 'Standard',
  specialInstructions: 'Closing is tight.',
  submissionId: SUBMISSION,
  ...extra,
})

// A fake intake_create_order with the database function's rules: exact match
// on the normalised company name, ambiguity when several match, otherwise a
// new client — committed only together with its order — and the messageId
// unique index.
function makeDeps(clients = [
  { code: 'CL01', name: 'Lakewood Title Group' },
  { code: 'CL02', name: 'Apex Lending Partners' },
]) {
  const table = clients.map(c => ({ ...c }))
  const orders = new Map()
  const calls = { writes: [], lookups: [], inserted: [] }
  let nextId = 10049
  const deps = {
    today: () => '2026-10-14',
    findByMessageId: async (id) => { calls.lookups.push(id); return orders.get(id) || null },
    createIntakeOrder: async (args) => {
      calls.writes.push(args)
      const { row, company } = args
      const hits = table.filter(c => normalizeCompanyName(c.name) === normalizeCompanyName(company))
      if (hits.length > 1) return { status: 'ambiguous', codes: hits.map(c => c.code) }
      const messageId = row.workflow.intake.messageId
      if (orders.has(messageId)) {
        const err = new Error('duplicate key value violates unique constraint "orders_intake_message_id_key"')
        err.code = '23505'
        throw err
      }
      let client = hits[0]
      let clientMatch = 'name'
      if (!client) {
        client = { code: `CL${String(table.length + 1).padStart(2, '0')}`, name: company }
        table.push(client)
        clientMatch = 'created'
      }
      const order = { id: `RES-${nextId++}`, status: row.status, assigned_to: row.assigned_to, client_code: client.code, type: row.type }
      orders.set(messageId, order)
      calls.inserted.push({ ...row, id: order.id, client_code: client.code })
      return { status: 'created', clientMatch, clientCode: client.code, order }
    },
  }
  return { deps, calls, table, orders }
}

const valid = (extra) => {
  const r = validateWebsiteOrder(payload(extra))
  assert.equal(r.ok, true, r.error)
  return r.value
}
const rejects = (extra, field) => {
  const r = validateWebsiteOrder(payload(extra))
  assert.equal(r.ok, false, `expected ${field} to be rejected`)
  assert.equal(r.field, field)
  return r
}

// ── Valid orders ─────────────────────────────────────────────────────────────
test('a valid website order lands as a normal received order parked with Admin', async () => {
  const { deps, calls } = makeDeps()
  const r = await processWebsiteIntake(payload(), deps)

  assert.equal(r.ok, true)
  assert.equal(r.status, 'created')
  assert.equal(r.clientCode, 'CL01')
  assert.equal(calls.inserted.length, 1)
  const row = calls.inserted[0]
  // The Awaiting Approval state every other intake path uses.
  assert.equal(row.status, 'received')
  assert.equal(row.assigned_to, 'admin')
  assert.equal(row.eta, null)
  assert.equal(row.progress, 5)
  assert.equal(row.created, '2026-10-14')
  for (const stage of ['screener', 'examiner', 'typer', 'delivery']) assert.equal(row[stage], null)
  assert.equal(row.state, 'FL')
  assert.equal(row.county, 'Miami-Dade')
  assert.equal(row.priority, 'normal')
  assert.equal(row.client_file_no, 'LOAN-42')
  assert.equal(row.workflow.confirmed, undefined, 'never pre-confirmed — Admin must Confirm & price')
})

test('the intake block carries source website and every field Admin reads', () => {
  const intake = buildWebsiteOrderRow(valid(), '2026-10-14').workflow.intake
  assert.equal(intake.source, 'website')
  assert.equal(intake.propertyAddress, '880 Main St, Miami, FL, 33101')
  assert.equal(intake.propertyType, 'Residential')
  assert.equal(intake.parcelNumberAPN, '01-3125-001-0010')
  assert.equal(intake.buyer, 'Taylor Brooks')
  assert.equal(intake.seller, 'Avery Banks')
  assert.equal(intake.borrowerName, 'Jordan Reyes')
  assert.equal(intake.from, 'Dana Whitfield <dana@lakewoodtitle.com>')
  assert.equal(intake.company, 'Lakewood Title Group')
  assert.equal(intake.contactFirstName, 'Dana')
  assert.equal(intake.contactLastName, 'Whitfield')
  assert.equal(intake.specialInstructions, 'Closing is tight.')
  assert.equal(intake.requestedTurnaround, 'Standard')
  assert.equal(intake.messageId, `website:${SUBMISSION}`)
})

test("the customer's original selections are preserved verbatim", () => {
  const { website } = buildWebsiteOrderRow(valid(), '2026-10-14').workflow.intake
  assert.deepEqual(website, {
    submissionId: SUBMISSION,
    submittedAt: '2026-10-14T15:04:05.000Z',
    product: 'Judgment & Lien Search',
    productMapped: false,
    customSearch: null,
    searchType: 'Judgment & Lien Search',
    parties: 'Buyer: Taylor Brooks; Seller: Avery Banks; Borrower: Jordan Reyes',
  })
})

test('Rush maps to the rush priority', () => {
  assert.equal(valid({ priority: 'Rush' }).priority, 'rush')
  assert.equal(valid({ priority: 'rush' }).priority, 'rush')
})

test('full state names convert to 2-letter codes; codes pass through', () => {
  assert.equal(valid({ propertyState: 'New York' }).propertyState, 'NY')
  assert.equal(valid({ propertyState: 'tx' }).propertyState, 'TX')
  assert.equal(toStateCode('District of Columbia'), 'DC')
  assert.equal(toStateCode('west virginia'), 'WV')
  assert.equal(toStateCode('Narnia'), null)
  assert.equal(toStateCode('ZZ'), null)
})

test("the intake state list is the portal's canonical US_STATES", () => {
  assert.deepEqual(STATES.map(([code, name]) => ({ code, name })), US_STATES)
})

test('the endpoint loads in plain Node, without Vite aliases (as on Vercel)', () => {
  const endpoint = fileURLToPath(new URL('../../../api/orders/website-intake.js', import.meta.url))
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(endpoint)}); console.log(typeof m.default)`,
  ], { encoding: 'utf8' })
  assert.equal(out.trim(), 'function')
})

test('contact names split on the first space without guessing', () => {
  assert.deepEqual(splitContactName('Dana Whitfield'), { full: 'Dana Whitfield', first: 'Dana', last: 'Whitfield' })
  assert.deepEqual(splitContactName('Mary Ann van der Berg'), { full: 'Mary Ann van der Berg', first: 'Mary', last: 'Ann van der Berg' })
  assert.deepEqual(splitContactName('Cher'), { full: 'Cher', first: 'Cher', last: null })
  assert.deepEqual(splitContactName('  José   Núñez  '), { full: 'José Núñez', first: 'José', last: 'Núñez' })
  // Cannot break out of the "Name <email>" line.
  assert.equal(splitContactName('Eve <evil@x.com>').full, 'Eve evil@x.com')
  assert.equal(splitContactName('12345'), null)
})

test('parties parse by role; anything else is kept and flagged, never guessed', () => {
  assert.deepEqual(parseParties('Buyer: A; Buyer: B; Seller: C'), { buyer: 'A, B', seller: 'C', borrower: null, unparsed: [] })
  assert.deepEqual(parseParties(''), { buyer: null, seller: null, borrower: null, unparsed: [] })
  const odd = valid({ parties: 'Buyer: A; Lender XYZ' })
  assert.equal(odd.buyer, 'A')
  assert.ok(odd.reviewNotes.some(n => n.includes('Lender XYZ')))
})

test('control characters are stripped; free text keeps its line breaks', () => {
  const v = valid({ county: 'Miami-\nDade\u0007', specialInstructions: 'Line one\r\nLine two\u0000' })
  assert.equal(v.county, 'Miami- Dade')
  assert.equal(v.specialInstructions, 'Line one\nLine two')
})

test('numeric spreadsheet values are accepted as text', () => {
  const v = valid({ zip: 33101, parcelApn: 1234567 })
  assert.equal(v.zip, '33101')
  assert.equal(v.parcelApn, '1234567')
})

// ── Invalid fields ───────────────────────────────────────────────────────────
test('every required field is enforced', () => {
  for (const field of REQUIRED_FIELDS) rejects({ [field]: '' }, field)
  for (const field of REQUIRED_FIELDS) rejects({ [field]: '   ' }, field)
})

test('a non-object payload is rejected', () => {
  for (const p of [null, 'text', [], 42]) assert.equal(validateWebsiteOrder(p).ok, false)
})

test('field types and lengths are enforced', () => {
  rejects({ businessName: { name: 'x' } }, 'businessName')
  rejects({ parties: ['Buyer: A'] }, 'parties')
  rejects({ county: 'x'.repeat(FIELD_LIMITS.county + 1) }, 'county')
  rejects({ specialInstructions: 'x'.repeat(FIELD_LIMITS.specialInstructions + 1) }, 'specialInstructions')
})

test('submissionId must be a UUID', () => {
  rejects({ submissionId: 'abc' }, 'submissionId')
  rejects({ submissionId: '18f2c9a4b1d0e5f7' }, 'submissionId')   // a Gmail id shape
  rejects({ submissionId: 'x@y.com' }, 'submissionId')
})

test('email, state, priority, company and contact are validated', () => {
  rejects({ workEmail: 'not-an-email' }, 'workEmail')
  rejects({ workEmail: 'a@b.com>' }, 'workEmail')
  rejects({ propertyState: 'Narnia' }, 'propertyState')
  rejects({ priority: 'Overnight' }, 'priority')
  rejects({ businessName: '---' }, 'businessName')
  rejects({ contactName: '1234' }, 'contactName')
})

test('a tripped honeypot never becomes an order', async () => {
  rejects({ website: 'http://spam.example' }, 'website')
  const { deps, calls } = makeDeps()
  const r = await processWebsiteIntake(payload({ website: 'x' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_payload')
  assert.equal(calls.writes.length, 0)
})

test('an invalid payload writes nothing and creates no client', async () => {
  const { deps, calls, table } = makeDeps()
  const r = await processWebsiteIntake(payload({ workEmail: 'nope' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.field, 'workEmail')
  assert.equal(calls.lookups.length, 0)
  assert.equal(calls.writes.length, 0)
  assert.equal(table.length, 2)
})

// ── Products ─────────────────────────────────────────────────────────────────
test('the website product table holds exactly the seven website products', () => {
  assert.deepEqual(WEBSITE_PRODUCTS.map(p => p.name), [
    'Judgment & Lien Search', 'Legal & Vesting Report', 'Assignment Verification Report',
    'Mortgage & Assignment Search', 'Vesting Deed & Chain of Title Search',
    'Attorney Opinion Letter', 'Municipal Lien Search',
  ])
})

test('every confirmed mapping targets a real catalog product', () => {
  for (const p of WEBSITE_PRODUCTS) {
    if (p.portalType != null) assert.ok(SEARCH_CATALOG.includes(p.portalType), p.name)
  }
})

test('an unmapped product keeps its own name, quote-only, flagged for Admin', () => {
  for (const { name } of WEBSITE_PRODUCTS.filter(p => !p.portalType)) {
    const v = valid({ product: name, searchType: name })
    assert.equal(v.type, name)
    assert.equal(v.productMapped, false)
    assert.ok(!SEARCH_CATALOG.includes(v.type), `${name} must not silently become a catalog product`)
    assert.ok(v.reviewNotes.some(n => n.includes(name) && n.includes('Confirm & price')))
  }
})

test('product names match case-insensitively but an unknown product is rejected', () => {
  assert.equal(valid({ product: 'municipal lien search' }).type, 'Municipal Lien Search')
  const r = rejects({ product: 'Full Search' }, 'product')
  assert.match(r.error, /not a website product/)
  rejects({ product: 'Totally New Product' }, 'product')
})

test('a custom search becomes a quote-only order with the description kept', async () => {
  const { deps, calls } = makeDeps()
  const r = await processWebsiteIntake(
    payload({ product: '', searchType: 'Custom search', customSearch: 'Chain back to 1950, no mortgages' }), deps)
  assert.equal(r.ok, true)
  const row = calls.inserted[0]
  assert.equal(row.type, CUSTOM_SEARCH_TYPE)
  assert.equal(row.workflow.intake.website.customSearch, 'Chain back to 1950, no mortgages')
  assert.equal(row.workflow.intake.website.product, null)
  assert.match(row.workflow.intake.specialInstructions, /Custom search requested: Chain back to 1950/)
  assert.ok(row.workflow.intake.reviewNotes.some(n => n.startsWith('Custom search requested')))
})

test('neither a product nor a custom search is rejected', () => {
  rejects({ product: '', customSearch: '' }, 'product')
})

test('a missing address or bad ZIP is flagged for review, not rejected', () => {
  const v = valid({ address: '', city: '', zip: '3310' })
  assert.ok(v.reviewNotes.some(n => n.includes('street address or city')))
  assert.ok(v.reviewNotes.some(n => n.includes('ZIP "3310"')))
  assert.equal(buildWebsiteOrderRow(v, '2026-10-14').workflow.intake.propertyAddress, 'FL, 3310')
})

test('review notes never leak into client-facing special instructions', () => {
  const intake = buildWebsiteOrderRow(valid({ address: '' }), '2026-10-14').workflow.intake
  assert.equal(intake.specialInstructions, 'Closing is tight.')
  assert.ok(intake.reviewNotes.length >= 2)
})

// ── Duplicate protection ─────────────────────────────────────────────────────
test('a re-sent submission returns the first order and writes nothing', async () => {
  const { deps, calls } = makeDeps()
  const first = await processWebsiteIntake(payload(), deps)
  const again = await processWebsiteIntake(payload(), deps)
  assert.equal(again.ok, true)
  assert.equal(again.status, 'duplicate')
  assert.equal(again.order.id, first.order.id)
  assert.equal(calls.writes.length, 1)
})

test('the submission id is case-insensitive, so one id is one order', async () => {
  const { deps, calls } = makeDeps()
  await processWebsiteIntake(payload(), deps)
  const upper = await processWebsiteIntake(payload({ submissionId: SUBMISSION.toUpperCase() }), deps)
  assert.equal(upper.status, 'duplicate')
  assert.equal(calls.writes.length, 1)
})

test('a lost race on the unique index reports the winning order', async () => {
  const { deps } = makeDeps()
  const winner = await processWebsiteIntake(payload(), deps)
  // Simulate the second POST passing the pre-check before the first commits.
  let checks = 0
  const racing = {
    ...deps,
    findByMessageId: async (id) => (checks++ === 0 ? null : deps.findByMessageId(id)),
  }
  const loser = await processWebsiteIntake(payload(), racing)
  assert.equal(loser.status, 'duplicate')
  assert.equal(loser.order.id, winner.order.id)
})

test('a real insert failure propagates instead of being reported as a duplicate', async () => {
  const { deps } = makeDeps()
  const failing = { ...deps, createIntakeOrder: async () => { throw new Error('connection reset') } }
  await assert.rejects(() => processWebsiteIntake(payload(), failing), /connection reset/)
})

test('website ids live in their own namespace of the shared messageId key', () => {
  const id = valid().messageId
  assert.ok(id.startsWith(WEBSITE_MESSAGE_PREFIX))
  assert.ok(!id.includes('@'), 'an RFC 5322 Message-ID always has an @')
  // Email intake's ids are untouched by any of this.
  assert.equal(normalizeMessageId('<CAF123@mail.gmail.com>'), 'CAF123@mail.gmail.com')
  assert.equal(normalizeMessageId('18f2c9a4b1d0e5f7'), '18f2c9a4b1d0e5f7')
})

// ── Client resolution ────────────────────────────────────────────────────────
test('the company name matches an existing client by the existing rule', async () => {
  const { deps, calls } = makeDeps()
  const r = await processWebsiteIntake(payload({ businessName: 'LAKEWOOD  title group' }), deps)
  assert.equal(r.clientMatch, 'name')
  assert.equal(r.clientCode, 'CL01')
  assert.equal(calls.writes[0].company, 'LAKEWOOD title group')
  assert.equal(calls.writes[0].contact, 'Dana Whitfield')
  assert.equal(calls.writes[0].email, 'dana@lakewoodtitle.com')
})

test('an unknown company creates a new client with the order', async () => {
  const { deps, table } = makeDeps()
  const r = await processWebsiteIntake(payload({ businessName: 'Brand New Escrow Co' }), deps)
  assert.equal(r.clientMatch, 'created')
  assert.equal(r.clientCode, 'CL03')
  assert.equal(table.length, 3)
})

test('an ambiguous company creates nothing and asks for review', async () => {
  const { deps, calls } = makeDeps([
    { code: 'CL01', name: 'Lakewood Title Group' },
    { code: 'CL09', name: 'Lakewood Title Group' },
  ])
  const r = await processWebsiteIntake(payload(), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ambiguous_client')
  assert.equal(r.field, 'businessName')
  assert.match(r.error, /CL01, CL09/)
  assert.equal(calls.inserted.length, 0)
})

test('public input can never choose a client code', async () => {
  const { deps, calls } = makeDeps()
  await processWebsiteIntake(payload({ client_identifier: 'CL02', clientIdentifier: 'CL02', clientCode: 'CL02' }), deps)
  assert.equal(calls.writes[0].clientIdentifier, null)
  assert.equal(calls.writes[0].company, 'Lakewood Title Group')
})

test('an unexpected result from the database is an error, not an order', async () => {
  const { deps } = makeDeps()
  const odd = { ...deps, createIntakeOrder: async () => ({ status: 'unknown_client' }) }
  await assert.rejects(() => processWebsiteIntake(payload(), odd), /unexpected order creation result/)
})

// ── Source ───────────────────────────────────────────────────────────────────
test('website orders display as Website and do not take the Portal pricing path', () => {
  const row = buildWebsiteOrderRow(valid(), '2026-10-14')
  assert.equal(orderSourceOf(row), 'website')
  assert.notEqual(row.workflow.intake.source, 'web')   // isPortalOrder keys on 'web'
})

test('email intake still writes source email', () => {
  const row = buildEmailOrderRow({
    propertyState: 'TX', county: 'Harris', searchType: 'Full Search', priority: 'normal',
    contactFirstName: 'A', contactLastName: 'B', contactEmail: 'a@b.com', messageId: 'm1',
  }, '2026-10-14')
  assert.equal(row.workflow.intake.source, 'email')
  assert.equal(orderSourceOf(row), 'email')
})

// ── HTTP adapter: auth and method gating ─────────────────────────────────────
// These paths return before any dependency is constructed, so the real handler
// runs here with no Supabase configured.
function fakeRes() {
  const out = {}
  return {
    out,
    status(code) { out.code = code; return this },
    json(body) { out.body = body; return this },
  }
}
const call = async (req, env = {}) => {
  const saved = { ...process.env }
  Object.assign(process.env, env)
  const res = fakeRes()
  try { await handler(req, res) } finally { process.env = saved }
  return res.out
}
const SECRET = { WEBSITE_INTAKE_API_SECRET: 'w3bsite' }

test('a non-POST request is rejected', async () => {
  assert.equal((await call({ method: 'GET', headers: {} }, SECRET)).code, 405)
})

test('the endpoint fails closed when its secret is not configured', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'anything' }, body: payload() },
    { WEBSITE_INTAKE_API_SECRET: '', EMAIL_INTAKE_API_SECRET: 'anything' },
  )
  assert.equal(out.code, 503)
  assert.match(out.body.error, /not configured/)
})

test('a missing or wrong secret is rejected', async () => {
  assert.equal((await call({ method: 'POST', headers: {}, body: payload() }, SECRET)).code, 401)
  assert.equal((await call({ method: 'POST', headers: { 'x-intake-secret': 'wrong' }, body: payload() }, SECRET)).code, 401)
  assert.equal((await call({ method: 'POST', headers: { 'x-intake-secret': 'w3bsitX' }, body: payload() }, SECRET)).code, 401)
})

test("the email intake secret does not open the website endpoint", async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'em4il' }, body: payload() },
    { ...SECRET, EMAIL_INTAKE_API_SECRET: 'em4il' },
  )
  assert.equal(out.code, 401)
})

test('an authenticated request with malformed JSON is a 400, not a crash', async () => {
  const out = await call({ method: 'POST', headers: { 'x-intake-secret': 'w3bsite' }, body: '{ not json' }, SECRET)
  assert.equal(out.code, 400)
  assert.equal(out.body.error, 'Malformed JSON payload')
})

test('an authenticated request without a database configured is a retryable 500', async () => {
  const out = await call({ method: 'POST', headers: { 'x-intake-secret': 'w3bsite' }, body: payload() }, SECRET)
  assert.equal(out.code, 500)
  assert.match(out.body.error, /Server not configured/)
})
