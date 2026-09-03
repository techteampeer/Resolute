// Unit tests for the email-intake pipeline and its HTTP adapter.
// Run: npm test
// Everything is faked — no Supabase, no network, no Gmail, no Gemini.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  validateIntake, normalizeMessageId, normalizeSearchType, normalizeTurnaround,
  SEARCH_CATALOG, REQUIRED_FIELDS, OPTIONAL_FIELDS,
} from '../schema.js'
import { processIntake, buildOrderRow } from '../intake.js'
import { PRODUCTS } from '../../../src/data/products.js'
import handler from '../../../api/orders/email-intake.js'

// ── Fixtures / mock factory ──────────────────────────────────────────────────
const CLIENT = { code: 'CL01', name: 'Lakewood Title Group' }

// Every required field, and nothing else.
const required = (extra = {}) => ({
  property_state: 'TX',
  county: 'Harris',
  property_address: '880 Main St',
  city: 'Houston',
  search_type: 'Full Search',
  turnaround: 'Standard (48 hours)',
  contact_first_name: 'Dana',
  contact_last_name: 'Whitfield',
  contact_email: 'dana@lakewoodtitle.com',
  client_identifier: 'CL01',
  email_message_id: '18f2c9a4b1d0e5f7',
  ...extra,
})

// Required + every optional field.
const payload = (extra = {}) => required({
  zip: '77002',
  parcel_apn: '0660110000021',
  client_file_number: 'LOAN-42',
  buyer: 'Taylor Brooks',
  borrower: 'Jordan Reyes',
  seller: 'Avery Banks',
  special_instructions: 'Closing is tight.',
  company: 'Lakewood Title Group',
  order_number: 'ORD-9911',
  customer_link: 'https://client.example/orders/9911',
  email_subject: 'Title search request — 880 Main St',
  source_email: 'Dana Whitfield <dana@lakewoodtitle.com>',
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

const rowFor = (p = payload()) => {
  const r = validateIntake(p)
  assert.equal(r.ok, true, `expected a valid payload, got ${r.error}`)
  return buildOrderRow(r.value, CLIENT, 'RTS-10049', '2026-09-02')
}

// ── The official field set ───────────────────────────────────────────────────
test('the required field list is exactly the official one', () => {
  assert.deepEqual(REQUIRED_FIELDS, [
    'property_state', 'county', 'property_address', 'city', 'search_type',
    'turnaround', 'contact_first_name', 'contact_last_name', 'contact_email',
    'client_identifier', 'email_message_id',
  ])
})

test('the optional field list is exactly the official one', () => {
  assert.deepEqual(OPTIONAL_FIELDS, [
    'zip', 'parcel_apn', 'client_file_number', 'buyer', 'borrower', 'seller',
    'special_instructions', 'company', 'order_number', 'customer_link',
    'email_subject', 'source_email',
  ])
})

test('a payload with only the required fields is accepted', () => {
  const r = validateIntake(required())
  assert.equal(r.ok, true)
})

test('every required field is individually required', () => {
  for (const field of REQUIRED_FIELDS) {
    const r = validateIntake(required({ [field]: undefined }))
    assert.equal(r.ok, false, `${field} should be required`)
    assert.equal(r.field, field)
  }
})

test('a blank required field is rejected, not just a missing one', () => {
  for (const field of REQUIRED_FIELDS) {
    assert.equal(validateIntake(required({ [field]: '   ' })).ok, false, `blank ${field} should be rejected`)
  }
})

test('every optional field may be omitted', () => {
  for (const field of OPTIONAL_FIELDS) {
    const r = validateIntake(payload({ [field]: undefined }))
    assert.equal(r.ok, true, `${field} should be optional`)
  }
})

test('validateIntake rejects a non-object payload', () => {
  assert.equal(validateIntake(null).ok, false)
  assert.equal(validateIntake('a string').ok, false)
  assert.equal(validateIntake([]).ok, false)
})

test('unknown keys are ignored, not rejected', () => {
  assert.equal(validateIntake(payload({ some_future_field: 'x' })).ok, true)
})

// ── property_state ───────────────────────────────────────────────────────────
test('property_state must be a 2-letter code and is upper-cased', () => {
  assert.equal(validateIntake(required({ property_state: 'tx' })).value.propertyState, 'TX')
  assert.equal(validateIntake(required({ property_state: 'Texas' })).field, 'property_state')
  assert.equal(validateIntake(required({ property_state: 'T' })).field, 'property_state')
})

// ── Turnaround → priority ────────────────────────────────────────────────────
test('Standard (48 hours) maps to the existing normal priority', () => {
  for (const wording of ['Standard (48 hours)', 'standard', 'Standard 48 hrs', '48 hours', 'normal']) {
    assert.equal(normalizeTurnaround(wording), 'normal', wording)
  }
})

test('Rush (24 hours) maps to the existing rush priority', () => {
  for (const wording of ['Rush (24 hours)', 'rush', 'RUSH 24 HRS', '24 hours', '24']) {
    assert.equal(normalizeTurnaround(wording), 'rush', wording)
  }
})

test('an unrecognised turnaround is rejected, never defaulted', () => {
  for (const wording of ['same day', '72 hours', 'ASAP', 'whenever']) {
    assert.equal(normalizeTurnaround(wording), null, wording)
    assert.equal(validateIntake(required({ turnaround: wording })).field, 'turnaround')
  }
})

test('turnaround reaches the order as priority, and the wording is kept verbatim', () => {
  assert.equal(rowFor(payload({ turnaround: 'Rush (24 hours)' })).priority, 'rush')
  assert.equal(rowFor(payload({ turnaround: 'Standard (48 hours)' })).priority, 'normal')
  assert.equal(
    rowFor(payload({ turnaround: 'Rush (24 hours)' })).workflow.intake.requestedTurnaround,
    'Rush (24 hours)',
  )
})

// ── Search type ──────────────────────────────────────────────────────────────
test('SEARCH_CATALOG comes from the portal product catalog', () => {
  assert.ok(SEARCH_CATALOG.includes('Full Search'))
  assert.ok(SEARCH_CATALOG.includes('Current Owner Search'))
  assert.ok(SEARCH_CATALOG.includes('Current Owner'), 'legacy short names stay valid')
})

test('every current product name maps to itself, case- and spacing-insensitively', () => {
  for (const { name } of PRODUCTS) {
    assert.equal(normalizeSearchType(name), name, name)
    assert.equal(normalizeSearchType(name.toUpperCase()), name, name)
    assert.equal(normalizeSearchType(`  ${name.toLowerCase()}  `), name, name)
  }
})

test('every accepted catalog name resolves to some catalog member', () => {
  for (const name of SEARCH_CATALOG) {
    assert.ok(SEARCH_CATALOG.includes(normalizeSearchType(name)), name)
  }
})

test('a legacy short name normalises forward to the current product name', () => {
  // Folding punctuation makes 'Two-Owner' and 'Two Owner Search' one key. A new
  // order should carry the name the website writes today; both are the same
  // product at the same price.
  assert.equal(normalizeSearchType('Two-Owner'), 'Two Owner Search')
  assert.equal(normalizeSearchType('Current Owner'), 'Current Owner Search')
})

test('a legacy-only product still resolves to itself', () => {
  for (const name of ['Lien Search', 'Tax Certificate', 'HOA Estoppel']) {
    assert.equal(normalizeSearchType(name), name, name)
    assert.equal(normalizeSearchType(name.toLowerCase()), name, name)
  }
})

test('explicit aliases resolve to real products', () => {
  assert.equal(normalizeSearchType('current owner rundown'), 'Current Owner Search')
  assert.equal(normalizeSearchType('full'), 'Full Search')
  assert.equal(normalizeSearchType('bringdown'), 'Update / Bringdown')
  assert.equal(normalizeSearchType('OFAC'), 'Patriot Name Search')
  assert.equal(normalizeSearchType('doc retrieval'), 'Document Retrieval')
})

test('normalizeSearchType only ever returns a catalog member', () => {
  const wordings = ['Full Search', 'full', 'bringdown', 'ofac', 'commercial', 'energy', 'two owner']
  for (const w of wordings) assert.ok(SEARCH_CATALOG.includes(normalizeSearchType(w)), w)
})

test('an off-catalog search_type is rejected rather than guessed at', () => {
  for (const wording of ['Astrology Report', 'Municipal Lien', 'Survey', 'Title Insurance', '']) {
    assert.equal(normalizeSearchType(wording), null, wording)
  }
  const r = validateIntake(required({ search_type: 'Astrology Report' }))
  assert.equal(r.ok, false)
  assert.equal(r.field, 'search_type')
  assert.match(r.error, /not a Resolute product/)
})

test('Tax Search and the legacy Tax Certificate stay distinct products', () => {
  assert.equal(normalizeSearchType('Tax Search'), 'Tax Search')
  assert.equal(normalizeSearchType('Tax Certificate'), 'Tax Certificate')
})

test('search_type lands on both the type column and the intake object', () => {
  const row = rowFor(payload({ search_type: 'two owner' }))
  assert.equal(row.type, 'Two Owner Search')
  assert.equal(row.workflow.intake.orderType, 'Two Owner Search')
})

// ── The Apps Script reference must stay in step with the API ─────────────────
// The Google project is a separate deployment, so its enums are a copy. These
// tests are the drift guard: a stale copy fails here rather than in production
// as a 400 on a real client's order.
const GS = readFileSync(new URL('../apps-script-example.gs', import.meta.url), 'utf8')
const gsArray = (name) => {
  const block = GS.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))
  assert.ok(block, `${name} not found in apps-script-example.gs`)
  return [...block[1].matchAll(/["']([^"']+)["']/g)].map(m => m[1])
}
// The JSON schema the lead script embeds in the prompt.
const GS_PROMPT_SCHEMA = GS.match(/Schema:\s*\{([\s\S]*?)\n {4}\}/)

test("the Apps Script search-type list is entirely accepted by the API", () => {
  const types = gsArray('SEARCH_TYPES')
  assert.ok(types.length > 0)
  for (const t of types) {
    assert.ok(SEARCH_CATALOG.includes(t), `${t} is offered to Gemini but not in the product catalog`)
    assert.ok(normalizeSearchType(t), `${t} would be rejected by the API`)
  }
})

test('the Apps Script turnaround list maps onto both priorities', () => {
  const wordings = gsArray('TURNAROUNDS')
  assert.deepEqual(wordings.map(normalizeTurnaround).sort(), ['normal', 'rush'])
})

test('the extraction schema asks for every field the API requires', () => {
  assert.ok(GS_PROMPT_SCHEMA, 'prompt schema not found in apps-script-example.gs')
  const schema = GS_PROMPT_SCHEMA[1]
  // The two the model cannot know are supplied by Apps Script and Gmail; every
  // other required API field must be something the model is asked for.
  const supplied = { client_identifier: 'clientCode', email_message_id: 'message.getId()' }
  const camel = (s) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
  for (const field of REQUIRED_FIELDS) {
    if (supplied[field]) continue
    // The prompt keeps the lead script's camelCase keys: property_address →
    // "propertyAddress", contact_first_name → "contactFirstName", …
    const wanted = camel(field)
    assert.ok(schema.includes(`"${wanted}"`), `the prompt does not ask for ${field} (as "${wanted}")`)
  }
})

test('the extraction schema cannot return a client code or a message id', () => {
  const schema = GS_PROMPT_SCHEMA[1]
  for (const forbidden of ['client_identifier', 'clientCode', 'email_message_id', 'messageId']) {
    assert.equal(schema.includes(`"${forbidden}"`), false, `${forbidden} must not be a Gemini output field`)
  }
  // The customer is extracted as a NAME, for CLIENT_CODE_MAP to resolve.
  assert.ok(schema.includes('"customer"'))
  assert.match(GS, /Do NOT output a client code[\s\S]{0,120}CL01/)
  // …and stripped defensively even so.
  assert.match(GS, /delete extractedJsonData\.client_identifier/)
})

test('client_identifier and email_message_id come only from Apps Script and Gmail', () => {
  assert.match(GS, /client_identifier:\s+clientCode/)
  assert.match(GS, /email_message_id:\s+messageId/)
  assert.match(GS, /const messageId = message\.getId\(\)/)
})

test('the lead script Gmail behaviour is preserved', () => {
  assert.match(GS, /const GMAIL_SEARCH_QUERY = 'label:resolute is:unread'/)
  assert.match(GS, /const SUBJECT_MUST_CONTAIN = "RES-"/)
  assert.match(GS, /subject\.includes\(SUBJECT_MUST_CONTAIN\)/)
  // Both bodies still reach the model — the HTML is what carries customerLink.
  assert.match(GS, /const plainBody = message\.getPlainBody\(\)/)
  assert.match(GS, /const htmlBody = message\.getBody\(\)/)
  assert.match(GS, /HTML Version \(Reference for extracting hyperlinks\)/)
  assert.match(GS, /"customerLink"/)
})

test('the lead script Vertex and trigger config is preserved', () => {
  assert.match(GS, /const VERTEX_AI_MODEL = "gemini-2\.5-pro"/)
  assert.match(GS, /const GCP_REGION = "us-central1"/)
  assert.match(GS, /"temperature": 0\.1/)
  assert.match(GS, /"responseMimeType": "application\/json"/)
  assert.match(GS, /ScriptApp\.getOAuthToken\(\)/)
  assert.match(GS, /\.everyMinutes\(5\)/)
  // A rename would orphan the trigger already created in the Google project.
  assert.match(GS, /function processResoluteEmailsWithVertexAI\(\)/)
  assert.match(GS, /const functionName = 'processResoluteEmailsWithVertexAI'/)
})

test('there is no AI is-this-an-order gate — the RES- filter is the gate', () => {
  assert.equal(/is_order_request/.test(GS), false)
})

test('the RES- order number is read from the subject, deterministically', () => {
  // Lift the actual regex out of the script and exercise it, so this is the
  // real extractor's behaviour and not a restatement of it.
  const literal = GS.match(/const RES_ORDER_NUMBER = \/(.+)\/;/)
  assert.ok(literal, 'RES_ORDER_NUMBER not found in apps-script-example.gs')
  const re = new RegExp(literal[1])
  const from = (subject) => (String(subject).match(re) || [null])[0]

  assert.equal(from('RES-2026-1937 title search request'), 'RES-2026-1937')
  assert.equal(from('Fwd: RES-2026-1937 — 880 Main St'), 'RES-2026-1937')
  assert.equal(from('Re: [External] order RES-2026-1937.'), 'RES-2026-1937')
  assert.equal(from('RES-1937'), 'RES-1937')
  assert.equal(from('RES-2026-PTMD-1922'), 'RES-2026-PTMD-1922')
  // Passes the SUBJECT_MUST_CONTAIN filter but carries no readable number.
  assert.equal(from('RES- please advise'), null)
  assert.match(GS, /function orderNumberFromSubject\(subject\)/)
  assert.match(GS, /orderNumberFromSubject\(subject\) \|\| extractedJsonData\.orderNumber/)
})

test('a failed order-number read is not a processing gate', () => {
  // The only thing that stops processing after extraction is a null response.
  assert.match(GS, /if \(!extractedJsonData\) \{/)
  assert.equal(/!extractedJsonData\.orderNumber/.test(GS), false)
})

test('order_number is optional to the API, so an unread RES- number still posts', () => {
  const r = validateIntake(payload({ order_number: undefined }))
  assert.equal(r.ok, true)
  assert.equal(rowFor(payload({ order_number: undefined })).workflow.intake.orderNumber, null)
})

test('no stale intake-mailbox variable survives anywhere', () => {
  // The queue is a Gmail label in the Apps Script project; the API has never
  // read a mailbox address, so documenting one invites a wrong assumption.
  for (const rel of ['../../../.env.example', '../../../api/README.md', '../README.md', '../apps-script-example.gs']) {
    const text = readFileSync(new URL(rel, import.meta.url), 'utf8')
    assert.equal(text.includes('TEST_INTAKE_EMAIL'), false, `TEST_INTAKE_EMAIL still referenced in ${rel}`)
  }
})

test('the Sheet log is optional and cannot affect the flow', () => {
  assert.match(GS, /if \(!SPREADSHEET_ID\) return/)
  // Opened lazily inside the logger's own try/catch, not up front.
  assert.equal((GS.match(/SpreadsheetApp\.openById/g) || []).length, 1)
  assert.match(GS, /catch \(loggingError\)/)
})

test('the Apps Script marks mail read in exactly one place, and only on success', () => {
  assert.equal((GS.match(/\.markRead\(\)/g) || []).length, 1)
  assert.match(GS, /outcome\.state === 'created' \|\| outcome\.state === 'duplicate'[\s\S]{0,80}markRead\(\)/)
})

test('the Apps Script never logs the intake secret', () => {
  // The secret is read only where it is put into a request header.
  const uses = [...GS.matchAll(/EMAIL_INTAKE_API_SECRET/g)]
  assert.equal(uses.length, 2, 'expected one doc mention and one header use')
  assert.match(GS, /"x-intake-secret": prop\('EMAIL_INTAKE_API_SECRET', true\)/)
  assert.equal(/Logger\.log\([^)]*SECRET/i.test(GS), false)
  // The API URL is configurable too — no hard-coded portal host.
  assert.match(GS, /prop\('INTAKE_API_URL', true\)/)
})

// ── contact_email ────────────────────────────────────────────────────────────
test('contact_email must look like an address', () => {
  assert.equal(validateIntake(required({ contact_email: 'not-an-email' })).field, 'contact_email')
  assert.equal(validateIntake(required({ contact_email: 'dana@lakewood' })).field, 'contact_email')
  assert.equal(validateIntake(required({ contact_email: 'dana@lakewood.com' })).ok, true)
})

// ── Message id ───────────────────────────────────────────────────────────────
test('normalizeMessageId strips angle brackets and preserves case', () => {
  assert.equal(normalizeMessageId('<CAB-1@mail.gmail.com>'), 'CAB-1@mail.gmail.com')
  assert.equal(normalizeMessageId('  18f2c9a4b1d0e5f7 '), '18f2c9a4b1d0e5f7')
  assert.equal(normalizeMessageId('<AbC@x>'), 'AbC@x')
  assert.equal(normalizeMessageId(''), null)
})

test('a Gmail message id passes through untouched', () => {
  assert.equal(validateIntake(required()).value.messageId, '18f2c9a4b1d0e5f7')
})

test('an over-long message id is rejected', () => {
  const r = validateIntake(required({ email_message_id: `${'x'.repeat(1000)}@mail` }))
  assert.equal(r.field, 'email_message_id')
})

// ── Field mapping onto the existing schema ───────────────────────────────────
test('required fields map onto existing columns and the existing intake keys', () => {
  const row = rowFor()
  assert.equal(row.state, 'TX')
  assert.equal(row.county, 'Harris')
  assert.equal(row.type, 'Full Search')
  assert.equal(row.priority, 'normal')
  assert.equal(row.client_code, 'CL01')
  const { intake } = row.workflow
  // Address parts are composed into one line exactly as the web form does.
  assert.equal(intake.propertyAddress, '880 Main St, Houston, TX, 77002')
  // Contact is packed into `from`, the key the portal already renders.
  assert.equal(intake.from, 'Dana Whitfield <dana@lakewoodtitle.com>')
  assert.equal(intake.messageId, '18f2c9a4b1d0e5f7')
})

test('the composed address omits an absent zip without leaving a gap', () => {
  assert.equal(rowFor(payload({ zip: undefined })).workflow.intake.propertyAddress, '880 Main St, Houston, TX')
})

test('optional fields map onto existing intake keys', () => {
  const { intake } = rowFor().workflow
  assert.equal(intake.parcelNumberAPN, '0660110000021')
  assert.equal(intake.buyer, 'Taylor Brooks')
  assert.equal(intake.borrowerName, 'Jordan Reyes')     // borrower → the existing borrowerName key
  assert.equal(intake.seller, 'Avery Banks')
  assert.equal(intake.company, 'Lakewood Title Group')
  assert.equal(intake.subject, 'Title search request — 880 Main St')
  assert.equal(intake.sourceEmail, 'Dana Whitfield <dana@lakewoodtitle.com>')
  assert.equal(intake.orderNumber, 'ORD-9911')
  assert.equal(intake.customerLink, 'https://client.example/orders/9911')
})

test('client_file_number maps to the existing client_file_no column', () => {
  assert.equal(rowFor().client_file_no, 'LOAN-42')
  assert.equal(rowFor(payload({ client_file_number: undefined })).client_file_no, null)
})

test('order_number and customer_link are surfaced in a rendered field, not dropped', () => {
  // No portal screen renders intake.orderNumber, so they also ride along in
  // specialInstructions, which Admin and the Screener do see.
  const text = rowFor().workflow.intake.specialInstructions
  assert.match(text, /Closing is tight\./)
  assert.match(text, /Client order number: ORD-9911/)
  assert.match(text, /Customer link: https:\/\/client\.example\/orders\/9911/)
})

test('instructions are null, never an empty string, when nothing was said', () => {
  const row = rowFor(payload({ special_instructions: undefined, order_number: undefined, customer_link: undefined }))
  assert.equal(row.workflow.intake.specialInstructions, null)
})

test('company falls back to the resolved client name when not supplied', () => {
  assert.equal(rowFor(payload({ company: undefined })).workflow.intake.company, 'Lakewood Title Group')
})

test('absent optional fields are null, not undefined or empty strings', () => {
  const { intake } = rowFor(required()).workflow
  for (const k of ['parcelNumberAPN', 'buyer', 'borrowerName', 'seller', 'subject', 'sourceEmail', 'orderNumber', 'customerLink']) {
    assert.equal(intake[k], null, k)
  }
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
  assert.equal(row.status, 'received')
  assert.equal(row.assigned_to, 'admin')
  assert.equal(row.progress, 5)
  assert.equal(row.clarification, null)
  assert.deepEqual(row.completed_dates, {})
  assert.deepEqual(row.completed_by, {})
  assert.deepEqual(
    [row.screener, row.examiner, row.typer, row.delivery, row.eta, row.completed],
    [null, null, null, null, null, null],
  )
  // Admin has not confirmed it — the client UI keys "Placed" vs "Received" on this.
  assert.equal(row.workflow.confirmed, undefined)
})

test('the created order writes exactly the columns a website order writes', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload(), deps)
  const row = calls.inserted[0]
  // Same column set as src/lib/backend.js insertOrder() — no column added to
  // mirror an intake field name.
  assert.deepEqual(Object.keys(row).sort(), [
    'assigned_to', 'clarification', 'client_code', 'client_file_no', 'completed',
    'completed_by', 'completed_dates', 'county', 'created', 'delivery', 'eta',
    'examiner', 'id', 'payment', 'priority', 'progress', 'screener', 'state',
    'status', 'type', 'typer', 'workflow',
  ])
  assert.equal(row.payment, 'Check')      // createOrder's default
  assert.equal(row.created, '2026-09-02')
  assert.equal(row.workflow.intake.source, 'email')
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

test('an unknown client code is rejected safely — no order, no phantom client', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ client_identifier: 'CL99' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'unknown_client')
  assert.equal(r.field, 'client_identifier')
  assert.equal(calls.inserted.length, 0)
})

test('client resolution is exact — no case-folding, no name or email fallback', async () => {
  for (const identifier of ['cl01', ' CL01 ', 'Lakewood Title Group', 'dana@lakewoodtitle.com']) {
    const { deps, calls } = makeDeps()
    const r = await processIntake(payload({ client_identifier: identifier }), deps)
    // ' CL01 ' trims to the real code and is fine; the rest must not resolve.
    if (identifier.trim() === 'CL01') {
      assert.equal(r.ok, true, identifier)
    } else {
      assert.equal(r.code, 'unknown_client', identifier)
      assert.equal(calls.inserted.length, 0, identifier)
    }
  }
})

test('the company name and sender address never establish identity', async () => {
  const { deps, calls } = makeDeps()
  // A correct company and sender cannot rescue a bad client code.
  const r = await processIntake(payload({ client_identifier: 'NOPE' }), deps)
  assert.equal(r.code, 'unknown_client')
  assert.deepEqual(calls.clients, ['NOPE'], 'only client_identifier is looked up')
  assert.equal(calls.inserted.length, 0)
})

test('a failure to allocate an order id creates nothing', async () => {
  const { deps, calls } = makeDeps({ nextOrderId: async () => null })
  const r = await processIntake(payload(), deps)
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
