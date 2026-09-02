// Unit tests for the email-intake pipeline and its HTTP adapter.
// Run: npm test
// Everything is faked — no Supabase, no network, no Gmail, no Gemini.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateIntake, normalizeMessageId, normalizeParties, SEARCH_CATALOG } from '../schema.js'
import { processIntake, buildOrderRow } from '../intake.js'
import handler from '../../../api/orders/email-intake.js'

// ── Fixtures / mock factory ──────────────────────────────────────────────────
const CLIENT = { code: 'CL01', name: 'Lakewood Title Group' }

const payload = (extra = {}) => ({
  source_email: 'dana@lakewoodtitle.com',
  email_message_id: '<CAB-1234@mail.gmail.com>',
  property_address: '880 Main St, Houston, TX 77002',
  county: 'Harris',
  state: 'TX',
  parcel_apn: '0660110000021',
  search_type: 'Full Search',
  parties: [{ role: 'buyer', name: 'Taylor Brooks' }, { role: 'seller', name: 'Avery Banks' }],
  instructions: 'Closing is tight — please prioritise.',
  client_identifier: 'CL01',
  ...extra,
})

function makeDeps(overrides = {}) {
  const calls = { inserted: [], lookups: [], clients: [] }
  let existing = null
  const deps = {
    findByMessageId: async (id) => { calls.lookups.push(id); return existing },
    resolveClient: async (code) => { calls.clients.push(code); return code === 'CL01' ? CLIENT : null },
    nextOrderId: async () => 'RTS-10049',
    insertOrder: async (row) => {
      calls.inserted.push(row)
      existing = { id: row.id, status: row.status, assigned_to: row.assigned_to, client_code: row.client_code, type: row.type }
      return existing
    },
    today: () => '2026-09-02',
    ...overrides,
  }
  return { deps, calls }
}

// ── Schema validation ────────────────────────────────────────────────────────
test('SEARCH_CATALOG comes from the portal product catalog', () => {
  assert.ok(SEARCH_CATALOG.includes('Full Search'))
  assert.ok(SEARCH_CATALOG.includes('Current Owner Search'))
  assert.ok(SEARCH_CATALOG.includes('Current Owner'), 'legacy short names stay valid')
})

test('normalizeMessageId strips angle brackets and preserves case', () => {
  assert.equal(normalizeMessageId('<CAB-1@mail.gmail.com>'), 'CAB-1@mail.gmail.com')
  assert.equal(normalizeMessageId('  CAB-1@mail.gmail.com '), 'CAB-1@mail.gmail.com')
  assert.equal(normalizeMessageId('<AbC@x>'), 'AbC@x')
  assert.equal(normalizeMessageId(''), null)
})

test('normalizeParties accepts bare strings and role objects', () => {
  assert.deepEqual(normalizeParties(['Jane Doe']), [{ role: null, name: 'Jane Doe' }])
  assert.deepEqual(normalizeParties([{ role: 'Buyer', name: 'Jane Doe' }]), [{ role: 'buyer', name: 'Jane Doe' }])
  assert.deepEqual(normalizeParties('not an array'), [])
  assert.deepEqual(normalizeParties([{ role: 'buyer' }]), [], 'a party with no name is dropped')
})

test('validateIntake normalises a good payload', () => {
  const r = validateIntake(payload())
  assert.equal(r.ok, true)
  assert.equal(r.value.messageId, 'CAB-1234@mail.gmail.com')
  assert.equal(r.value.searchType, 'Full Search')
  assert.equal(r.value.priority, 'normal')
  assert.equal(r.value.state, 'TX')
})

test('validateIntake rejects a non-object payload', () => {
  assert.equal(validateIntake(null).ok, false)
  assert.equal(validateIntake('a string').ok, false)
  assert.equal(validateIntake([]).ok, false)
})

test('validateIntake rejects each missing required field', () => {
  for (const field of ['email_message_id', 'client_identifier', 'search_type', 'property_address', 'county']) {
    const r = validateIntake(payload({ [field]: undefined }))
    assert.equal(r.ok, false, `${field} should be required`)
    assert.equal(r.field, field)
  }
})

test('validateIntake rejects a blank required field, not just a missing one', () => {
  const r = validateIntake(payload({ property_address: '   ' }))
  assert.equal(r.ok, false)
  assert.equal(r.field, 'property_address')
})

test('validateIntake rejects an off-catalog search_type rather than defaulting it', () => {
  const r = validateIntake(payload({ search_type: 'Astrology Report' }))
  assert.equal(r.ok, false)
  assert.equal(r.field, 'search_type')
  assert.match(r.error, /must be one of/)
})

test('validateIntake rejects a bad priority and a bad state', () => {
  assert.equal(validateIntake(payload({ priority: 'urgent' })).field, 'priority')
  assert.equal(validateIntake(payload({ state: 'Texas' })).field, 'state')
})

test('validateIntake defaults state to empty when absent, matching the web form', () => {
  const r = validateIntake(payload({ state: undefined }))
  assert.equal(r.ok, true)
  assert.equal(r.value.state, '')
})

test('validateIntake rejects an over-long message id', () => {
  const r = validateIntake(payload({ email_message_id: `${'x'.repeat(1000)}@mail` }))
  assert.equal(r.ok, false)
  assert.equal(r.field, 'email_message_id')
})

// ── Happy path: one normal order, parked with Admin ──────────────────────────
test('valid intake creates exactly one order', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload(), deps)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'created')
  assert.equal(calls.inserted.length, 1)
  assert.equal(r.order.id, 'RTS-10049')
})

test('the created order enters the existing initial Admin state', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload(), deps)
  const row = calls.inserted[0]
  // These five are what "parked with Admin" means for a website order too.
  assert.equal(row.status, 'received')
  assert.equal(row.assigned_to, 'admin')
  assert.equal(row.progress, 5)
  assert.equal(row.clarification, null)
  assert.deepEqual(row.completed_dates, {})
  assert.deepEqual(row.completed_by, {})
  // Not yet claimed by any pipeline role, and not yet scheduled.
  assert.deepEqual(
    [row.screener, row.examiner, row.typer, row.delivery, row.eta, row.completed],
    [null, null, null, null, null, null],
  )
  // Admin has not confirmed it — the client UI keys "Placed" vs "Received" on this.
  assert.equal(row.workflow.confirmed, undefined)
})

test('the created order matches the columns a website order writes', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload(), deps)
  const row = calls.inserted[0]
  // Same column set as src/lib/backend.js insertOrder().
  assert.deepEqual(Object.keys(row).sort(), [
    'assigned_to', 'clarification', 'client_code', 'client_file_no', 'completed',
    'completed_by', 'completed_dates', 'county', 'created', 'delivery', 'eta',
    'examiner', 'id', 'payment', 'priority', 'progress', 'screener', 'state',
    'status', 'type', 'typer', 'workflow',
  ])
  assert.equal(row.payment, 'Check')      // createOrder's default
  assert.equal(row.priority, 'normal')
  assert.equal(row.created, '2026-09-02')
})

test('email fields land on the intake object the portal already renders', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload(), deps)
  const { intake } = calls.inserted[0].workflow
  assert.equal(intake.source, 'email')
  assert.equal(intake.propertyAddress, '880 Main St, Houston, TX 77002')
  assert.equal(intake.parcelNumberAPN, '0660110000021')
  assert.equal(intake.orderType, 'Full Search')
  assert.equal(intake.buyer, 'Taylor Brooks')
  assert.equal(intake.seller, 'Avery Banks')
  assert.equal(intake.borrowerName, '')
  assert.equal(intake.from, 'dana@lakewoodtitle.com')
  assert.equal(intake.company, 'Lakewood Title Group')
  assert.equal(intake.messageId, 'CAB-1234@mail.gmail.com')
  assert.match(intake.specialInstructions, /Closing is tight/)
  // Top-level columns the dashboards filter on.
  assert.equal(calls.inserted[0].county, 'Harris')
  assert.equal(calls.inserted[0].state, 'TX')
  assert.equal(calls.inserted[0].client_code, 'CL01')
})

test('parties with no mappable role are surfaced in the instructions, not dropped', () => {
  const value = validateIntake(payload({ parties: ['Jane Doe', { role: 'trustee', name: 'Acme Trust' }], instructions: 'Rush.' })).value
  const row = buildOrderRow(value, CLIENT, 'RTS-1', '2026-09-02')
  assert.match(row.workflow.intake.specialInstructions, /Rush\./)
  assert.match(row.workflow.intake.specialInstructions, /Parties: Jane Doe, trustee: Acme Trust/)
  assert.equal(row.workflow.intake.parties.length, 2)
})

test('instructions are null, never an empty string, when nothing was said', () => {
  const value = validateIntake(payload({ instructions: undefined, parties: [] })).value
  assert.equal(buildOrderRow(value, CLIENT, 'RTS-1').workflow.intake.specialInstructions, null)
})

// ── Rejections ───────────────────────────────────────────────────────────────
test('an invalid payload is rejected and creates nothing', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ search_type: 'Nope' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'invalid_payload')
  assert.equal(calls.inserted.length, 0)
  assert.equal(calls.clients.length, 0, 'validation runs before any lookup')
})

test('an unknown client is rejected safely — no order, no phantom client', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ client_identifier: 'CL99' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'unknown_client')
  assert.equal(r.field, 'client_identifier')
  assert.equal(calls.inserted.length, 0)
})

test('client resolution is exact — a sender address is never used as identity', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload({ client_identifier: 'cl01' }), deps)
  assert.deepEqual(calls.clients, ['cl01'], 'the identifier is passed through verbatim')
  assert.equal(calls.inserted.length, 0, 'no fallback to source_email')
})

test('a failure to allocate an order id creates nothing', async () => {
  const { deps, calls } = makeDeps({ nextOrderId: async () => null })
  const r = await processIntake(payload(), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'order_id_unavailable')
  assert.equal(calls.inserted.length, 0)
})

// ── Idempotency ──────────────────────────────────────────────────────────────
test('the same email POSTed twice creates one order', async () => {
  const { deps, calls } = makeDeps()
  const first = await processIntake(payload(), deps)
  const second = await processIntake(payload(), deps)
  assert.equal(first.status, 'created')
  assert.equal(second.status, 'duplicate')
  assert.equal(second.order.id, first.order.id)
  assert.equal(calls.inserted.length, 1)
})

test('a message id already on an order short-circuits before any side effect', async () => {
  const { deps, calls } = makeDeps({
    findByMessageId: async () => ({ id: 'RTS-10048', status: 'received', assigned_to: 'admin' }),
  })
  const r = await processIntake(payload(), deps)
  assert.equal(r.status, 'duplicate')
  assert.equal(r.order.id, 'RTS-10048')
  assert.equal(calls.inserted.length, 0)
  assert.equal(calls.clients.length, 0)
})

test('angle-bracketed and bare spellings of one message id are the same order', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload({ email_message_id: '<CAB-1234@mail.gmail.com>' }), deps)
  const r = await processIntake(payload({ email_message_id: 'CAB-1234@mail.gmail.com' }), deps)
  assert.equal(r.status, 'duplicate')
  assert.equal(calls.inserted.length, 1)
})

test('losing the insert race returns the winning order, not an error', async () => {
  // Both requests pass the pre-check; the unique index rejects the second.
  const winner = { id: 'RTS-10049', status: 'received', assigned_to: 'admin' }
  let checks = 0
  const { deps, calls } = makeDeps({
    findByMessageId: async () => (++checks === 1 ? null : winner),
    insertOrder: async () => { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e },
  })
  const r = await processIntake(payload(), deps)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'duplicate')
  assert.equal(r.order.id, 'RTS-10049')
  assert.equal(calls.inserted.length, 0)
})

test('a real insert failure propagates instead of being reported as a duplicate', async () => {
  const { deps } = makeDeps({ insertOrder: async () => { throw new Error('connection reset') } })
  await assert.rejects(() => processIntake(payload(), deps), /connection reset/)
})

// ── HTTP adapter: auth and method gating ─────────────────────────────────────
// These paths all return before any dependency is constructed, so the handler
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

test('a non-POST request is rejected', async () => {
  const out = await call({ method: 'GET', headers: {} }, { EMAIL_INTAKE_API_SECRET: 's3cret' })
  assert.equal(out.code, 405)
})

test('a missing intake secret header is rejected', async () => {
  const out = await call({ method: 'POST', headers: {}, body: payload() }, { EMAIL_INTAKE_API_SECRET: 's3cret' })
  assert.equal(out.code, 401)
  assert.equal(out.body.error, 'Unauthorized')
})

test('a wrong intake secret is rejected', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'wrong' }, body: payload() },
    { EMAIL_INTAKE_API_SECRET: 's3cret' },
  )
  assert.equal(out.code, 401)
})

test('a secret of the right length but wrong value is rejected', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'aaaaaa' }, body: payload() },
    { EMAIL_INTAKE_API_SECRET: 's3cret' },
  )
  assert.equal(out.code, 401)
})

test('the endpoint fails closed when no secret is configured', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'anything' }, body: payload() },
    { EMAIL_INTAKE_API_SECRET: '' },
  )
  assert.equal(out.code, 503)
  assert.match(out.body.error, /not configured/)
})

test('an authenticated request with malformed JSON is a 400, not a crash', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 's3cret' }, body: '{ not json' },
    { EMAIL_INTAKE_API_SECRET: 's3cret' },
  )
  assert.equal(out.code, 400)
  assert.equal(out.body.error, 'Malformed JSON payload')
})

test('an authenticated request never echoes the secret back', async () => {
  const out = await call(
    { method: 'POST', headers: { 'x-intake-secret': 'wrong-secret' }, body: payload() },
    { EMAIL_INTAKE_API_SECRET: 's3cret' },
  )
  assert.equal(JSON.stringify(out.body).includes('s3cret'), false)
})
