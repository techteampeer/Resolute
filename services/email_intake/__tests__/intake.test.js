// Unit tests for the email-intake pipeline and its HTTP adapter.
// Run: npm test
// Everything is faked — no Supabase, no network, no Gmail, no Gemini.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import {
  validateIntake, normalizeMessageId, normalizeSearchType, normalizeTurnaround,
  normalizeCompanyName, SEARCH_CATALOG, REQUIRED_FIELDS, OPTIONAL_FIELDS,
} from '../schema.js'
import { processIntake, buildOrderRow, CLIENT_MATCH } from '../intake.js'
import { createDeps } from '../store.js'
import { PRODUCTS } from '../../../src/data/products.js'
import { displayClient } from '../../../src/data/mockData.js'
import handler from '../../../api/orders/email-intake.js'

// ── Fixtures / mock factory ──────────────────────────────────────────────────
const CLIENT = { code: 'CL01', name: 'Lakewood Title Group' }

// Every required field, and nothing else. `company` is the client key: it is
// how normal email intake identifies the client (client_identifier is the
// alternative for a trusted caller).
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
  company: 'Lakewood Title Group',
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
  order_number: 'ORD-9911',
  customer_link: 'https://client.example/orders/9911',
  email_subject: 'Title search request — 880 Main St',
  source_email: 'Dana Whitfield <dana@lakewoodtitle.com>',
  ...extra,
})

// A fake intake_create_order with the database function's semantics, its
// transaction included: exact match on the normalised name, ambiguity when
// several match, otherwise the next CL code — and a new client lands only
// together with its order. (The real function is exercised against Postgres;
// the migration tests below hold it to these rules.)
function makeDeps(overrides = {}, clients = [CLIENT, { code: 'CL02', name: 'Apex Lending Partners' }]) {
  const calls = { writes: [], inserted: [], lookups: [], created: [] }
  const table = clients.map(c => ({ ...c }))
  const byMessageId = new Map()
  let nextId = 10049
  const deps = {
    findByMessageId: async (id) => { calls.lookups.push(id); return byMessageId.get(id) || null },
    createIntakeOrder: async (args) => {
      calls.writes.push(args)
      const { row, clientIdentifier, company, contact, email } = args
      let client, clientMatch
      if (clientIdentifier) {
        client = table.find(c => c.code === clientIdentifier)
        if (!client) return { status: 'unknown_client' }
        clientMatch = 'code'
      } else {
        const hits = table.filter(c => normalizeCompanyName(c.name) === normalizeCompanyName(company))
        if (hits.length > 1) return { status: 'ambiguous', codes: hits.map(c => c.code) }
        client = hits[0] || { code: `CL${String(table.length + 1).padStart(2, '0')}`, name: company }
        clientMatch = hits[0] ? 'name' : 'created'
      }
      const intake = {
        ...row.workflow.intake, company: row.workflow.intake.company ?? client.name,
        clientMatch, clientCode: client.code, clientCreated: clientMatch === 'created',
      }
      const saved = { ...row, id: `RTS-${nextId++}`, client_code: client.code, workflow: { ...row.workflow, intake } }
      // Commit: the new client and its order land together.
      if (clientMatch === 'created') { table.push(client); calls.created.push({ ...client, contact, email }) }
      calls.inserted.push(saved)
      const order = { id: saved.id, status: saved.status, assigned_to: saved.assigned_to, client_code: saved.client_code, type: saved.type }
      byMessageId.set(intake.messageId, order)
      return { status: 'created', clientMatch, clientCode: client.code, order }
    },
    today: () => '2026-09-02',
    ...overrides,
  }
  return { deps, calls }
}

const rowFor = (p = payload()) => {
  const r = validateIntake(p)
  assert.equal(r.ok, true, `expected a valid payload, got ${r.error}`)
  return buildOrderRow(r.value, '2026-09-02')
}

// ── The official field set ───────────────────────────────────────────────────
test('the required field list is exactly the official one', () => {
  assert.deepEqual(REQUIRED_FIELDS, [
    'property_state', 'county', 'property_address', 'city', 'search_type',
    'turnaround', 'contact_first_name', 'contact_last_name', 'contact_email',
    'email_message_id',
  ])
})

test('the optional field list is exactly the official one', () => {
  assert.deepEqual(OPTIONAL_FIELDS, [
    'zip', 'parcel_apn', 'client_file_number', 'buyer', 'borrower', 'seller',
    'special_instructions', 'company', 'order_number', 'customer_link',
    'email_subject', 'source_email', 'client_identifier',
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
    // company is optional only when client_identifier stands in for it.
    const extra = field === 'company' ? { client_identifier: 'CL01' } : {}
    const r = validateIntake(payload({ [field]: undefined, ...extra }))
    assert.equal(r.ok, true, `${field} should be optional`)
  }
})

test('the client must be identified: company, or an explicit client_identifier', () => {
  for (const company of [undefined, '', '   ', '---', "''"]) {
    const r = validateIntake(required({ company }))
    assert.equal(r.ok, false, JSON.stringify(company))
    assert.equal(r.field, 'company')
  }
  // A trusted caller's exact code is the alternative…
  assert.equal(validateIntake(required({ company: undefined, client_identifier: 'CL01' })).ok, true)
  // …and an address never is.
  assert.equal(validateIntake(required({ company: undefined, source_email: 'dana@lakewoodtitle.com' })).field, 'company')
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
  // The message id is supplied by Gmail; every other required API field must
  // be something the model is asked for.
  const supplied = { email_message_id: 'message.getId()' }
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
  // The client is extracted as a NAME, for the portal to resolve.
  assert.ok(schema.includes('"customer"'))
  assert.match(GS, /Do NOT output a client code[\s\S]{0,120}CL01/)
  // …and stripped defensively even so.
  assert.match(GS, /delete extractedJsonData\.client_identifier/)
})

test('Apps Script sends the company name and never a client code', () => {
  assert.match(GS, /company:\s+x\.customer \|\| null/)
  assert.equal(/client_identifier:/.test(GS), false, 'the payload must not carry a client code')
  assert.match(GS, /email_message_id:\s+messageId/)
  assert.match(GS, /const messageId = message\.getId\(\)/)
})

test('CLIENT_CODE_MAP and the unmapped-client path are gone', () => {
  assert.equal(/CLIENT_CODE_MAP/.test(GS), false)
  assert.equal(/clientCodeFor/.test(GS), false)
  assert.equal(/unmapped/i.test(GS), false)
  // Nothing between extraction and the POST can stop a message any more.
  assert.match(GS, /delete extractedJsonData\.clientCode;\s*payload = buildIntakePayload\(extractedJsonData, message, messageId\);/)
})

test('the lead script Gmail behaviour is preserved', () => {
  assert.match(GS, /const GMAIL_SEARCH_QUERY = 'label:resolute is:unread'/)
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

test('there is no AI is-this-an-order gate', () => {
  assert.equal(/is_order_request/.test(GS), false)
})

test('every unread message under the label reaches Vertex — there is no RES- subject gate', () => {
  // Clients send unstructured emails; the model reads them, the API validates.
  assert.equal(/SUBJECT_MUST_CONTAIN/.test(GS), false)
  assert.equal(/subject\.includes\(/.test(GS), false)
  assert.equal(/Skipping non-Resolute/.test(GS), false)
  // The only skip left in the loop is the unread check.
  assert.match(GS, /if \(!message\.isUnread\(\)\) continue;\s*(\/\/[^\n]*\s*)*processResoluteMessage\(message, message\.getSubject\(\)\);/)
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
  // Carries the RES- marker but no readable number.
  assert.equal(from('RES- please advise'), null)
  // The usual unstructured client email: no RES- number at all, still processed.
  assert.equal(from('Title search needed — 880 Main St, Houston'), null)
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
  // Every call site — not the definition — passes the message id as the key.
  const calls = [...GS.matchAll(/(?<!function )logToTestSheet\((\w+),/g)].map(m => m[1])
  assert.equal(calls.length, 3)
  assert.deepEqual([...new Set(calls)], ['messageId'])
})

// ── The test sheet's own duplicate protection ────────────────────────────────
// The logger is lifted out of the .gs and executed against a fake Spreadsheet,
// so these assert real behaviour rather than the shape of the source.
function loadSheetLogger(sheet) {
  const pick = (re, what) => {
    const m = GS.match(re)
    assert.ok(m, `${what} not found in apps-script-example.gs`)
    return m[0]
  }
  const src = [
    pick(/const SHEET_HEADERS = \[[\s\S]*?\n\];/, 'SHEET_HEADERS'),
    pick(/const MESSAGE_ID_COLUMN = \d+;/, 'MESSAGE_ID_COLUMN'),
    pick(/function logToTestSheet\([\s\S]*?\n\}/, 'logToTestSheet'),
    pick(/function findRowByMessageId\([\s\S]*?\n\}/, 'findRowByMessageId'),
  ].join('\n')
  const factory = new Function(
    'SpreadsheetApp', 'Logger', 'SPREADSHEET_ID', 'TARGET_SHEET_NAME',
    `${src}\nreturn { logToTestSheet, SHEET_HEADERS };`,
  )
  return factory(
    { openById: () => ({ getSheetByName: () => sheet }) },
    { log: () => {} },
    'sheet-id', 'Sheet1',
  )
}

function fakeSheet() {
  const rows = []
  return {
    rows,
    getLastRow: () => rows.length,
    appendRow: (r) => rows.push(r),
    getRange: (row, col, numRows, numCols) => ({
      getValues: () => rows.slice(row - 1, row - 1 + numRows).map(r => r.slice(col - 1, col - 1 + numCols)),
      setValues: (vals) => vals.forEach((v, i) => { rows[row - 1 + i] = v }),
    }),
  }
}

const EXTRACTED = {
  orderNumber: 'RES-2026-1937',
  customer: 'Atlantic Closing & Escrow, LLC',
  contactEmail: 'dana@lakewoodtitle.com',
  customerFile: 'ACE-26-13155',
  customerLink: 'https://client.example/orders/9911',
  propertyAddress: '880 Main St',
}

test('the same Gmail message id logged twice produces one sheet row', () => {
  const sheet = fakeSheet()
  const { logToTestSheet } = loadSheetLogger(sheet)
  logToTestSheet('18f2c9a4b1d0e5f7', EXTRACTED, 'unavailable', 'HTTP 500')
  logToTestSheet('18f2c9a4b1d0e5f7', EXTRACTED, 'created', 'RTS-10049')
  // header + exactly one data row
  assert.equal(sheet.rows.length, 2)
  // …and the row carries the LATEST outcome, not the stale first attempt.
  assert.match(sheet.rows[1][8], /created — RTS-10049/)
})

test('different Gmail message ids produce separate rows', () => {
  const sheet = fakeSheet()
  const { logToTestSheet } = loadSheetLogger(sheet)
  logToTestSheet('id-one', EXTRACTED, 'created', 'RTS-1')
  logToTestSheet('id-two', EXTRACTED, 'created', 'RTS-2')
  logToTestSheet('id-three', EXTRACTED, 'rejected', 'HTTP 422')
  assert.equal(sheet.rows.length, 4)                      // header + 3
  assert.deepEqual(sheet.rows.slice(1).map(r => r[1]), ['id-one', 'id-two', 'id-three'])
})

test('the sheet records the Gmail message id and the extracted client email', () => {
  const sheet = fakeSheet()
  const { logToTestSheet, SHEET_HEADERS } = loadSheetLogger(sheet)
  logToTestSheet('18f2c9a4b1d0e5f7', EXTRACTED, 'created', 'RTS-10049')
  assert.deepEqual(sheet.rows[0], SHEET_HEADERS)
  assert.deepEqual(SHEET_HEADERS, [
    'Processing Timestamp', 'Gmail Message ID', 'Order Number', 'Customer',
    'Client Email', 'Customer File', 'Customer Link', 'Property Address',
    'API Result / Detail',
  ])
  const row = sheet.rows[1]
  assert.ok(row[0] instanceof Date)
  assert.equal(row[1], '18f2c9a4b1d0e5f7')
  assert.equal(row[2], 'RES-2026-1937')
  assert.equal(row[3], 'Atlantic Closing & Escrow, LLC')
  assert.equal(row[4], 'dana@lakewoodtitle.com', 'Client Email comes from the extracted contactEmail')
  assert.equal(row[5], 'ACE-26-13155')
  assert.equal(row[6], 'https://client.example/orders/9911')
  assert.equal(row[7], '880 Main St')
})

test('a message with no extracted contact email logs a blank, never the sender', () => {
  const sheet = fakeSheet()
  const { logToTestSheet } = loadSheetLogger(sheet)
  logToTestSheet('id-x', { ...EXTRACTED, contactEmail: undefined }, 'rejected', 'HTTP 400')
  assert.equal(sheet.rows[1][4], '')
})

test('a header-less legacy sheet is not given a header row mid-stream', () => {
  const sheet = fakeSheet()
  const { logToTestSheet } = loadSheetLogger(sheet)
  sheet.rows.push(['old', 'row', 'from', 'a', 'previous', 'layout', '', '', ''])
  logToTestSheet('id-new', EXTRACTED, 'created', 'RTS-1')
  assert.equal(sheet.rows.length, 2)
  assert.equal(sheet.rows[1][1], 'id-new')
})

test('message.getFrom() is never the client email or the client identity', () => {
  // getFrom() is used in exactly one line of code — comments aside — and that
  // line is source_email, envelope provenance only. A forwarded order carries
  // the forwarder's address, not the client's.
  const codeUses = GS.split('\n')
    .filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line) && line.includes('message.getFrom()'))
  assert.equal(codeUses.length, 1)
  assert.match(codeUses[0], /source_email:/)
  assert.equal(/contact_email:\s+message\.getFrom\(\)/.test(GS), false)
  // The sheet's Client Email cell reads the extracted value.
  assert.match(GS, /x\.contactEmail \|\| ""/)
  // Identity comes from the extracted company name, resolved by the portal.
  assert.match(GS, /company:\s+x\.customer \|\| null/)
})

test('contactEmail remains a required extraction field', () => {
  assert.ok(REQUIRED_FIELDS.includes('contact_email'))
  assert.equal(validateIntake(required({ contact_email: undefined })).field, 'contact_email')
  assert.match(GS_PROMPT_SCHEMA[1], /"contactEmail"/)
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
  // Filled by the database, inside the transaction that resolves the client.
  assert.equal(row.id, null)
  assert.equal(row.client_code, null)
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

test('company falls back to the resolved client name when not supplied', async () => {
  const p = payload({ company: undefined, client_identifier: 'CL01' })
  assert.equal(rowFor(p).workflow.intake.company, null, 'the API sends what the email said')
  const { deps, calls } = makeDeps()
  await processIntake(p, deps)
  assert.equal(calls.inserted[0].workflow.intake.company, 'Lakewood Title Group', 'the database fills the name in')
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
  assert.equal(calls.lookups.length, 0, 'validation runs before any lookup')
  assert.equal(calls.writes.length, 0, 'validation runs before any client is matched or created')
})

test('an unknown client code is rejected safely — no order, no phantom client', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ client_identifier: 'CL99' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'unknown_client')
  assert.equal(r.field, 'client_identifier')
  assert.equal(calls.inserted.length, 0)
})

test('an explicit client_identifier is exact — no case-folding, no fallback to the name', async () => {
  for (const identifier of ['cl01', ' CL01 ', 'Lakewood Title Group', 'dana@lakewoodtitle.com']) {
    const { deps, calls } = makeDeps()
    // payload() also carries the matching company name; it must not rescue a bad code.
    const r = await processIntake(payload({ client_identifier: identifier }), deps)
    // ' CL01 ' trims to the real code and is fine; the rest must not resolve.
    if (identifier.trim() === 'CL01') {
      assert.equal(r.ok, true, identifier)
      assert.equal(r.clientMatch, 'code', identifier)
    } else {
      assert.equal(r.code, 'unknown_client', identifier)
      assert.equal(calls.inserted.length, 0, identifier)
    }
    assert.equal(calls.writes[0].company, null, `${identifier}: an explicit code never falls back to the name`)
    assert.equal(calls.created.length, 0, identifier)
  }
})

test('a sender or contact address never establishes identity', async () => {
  // Every address on this email belongs to CL01, but the company is new: the
  // result is a NEW client, because only the company name is a match key.
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({
    company: 'Harbor Point Escrow',
    contact_email: 'dana@lakewoodtitle.com',
    source_email: 'Dana Whitfield <dana@lakewoodtitle.com>',
  }), deps)
  assert.equal(r.clientMatch, 'created')
  assert.notEqual(calls.inserted[0].client_code, 'CL01')
  // The database is handed the row, the name to match and the contact details
  // to store — no code, and nothing else.
  assert.deepEqual(Object.keys(calls.writes[0]).sort(), ['clientIdentifier', 'company', 'contact', 'email', 'row'])
  assert.equal(calls.writes[0].clientIdentifier, null)
  assert.equal(calls.writes[0].company, 'Harbor Point Escrow')
})

// ── Client resolution by company name ────────────────────────────────────────
test('normalizeCompanyName folds case, punctuation, spacing and & — nothing more', () => {
  const same = [
    ['Lakewood Title Group', 'LAKEWOOD   title group.'],
    ['Lakewood Title Group', '  Lakewood Title-Group '],
    ['Atlantic Closing & Escrow, LLC', 'Atlantic Closing and Escrow L.L.C.'],
    ["O'Brien Title", 'O’Brien Title'],
    ["O'Brien Title", 'OBrien Title'],
    ['Smith&Jones Title', 'Smith and Jones Title'],
    ['Premier Title (MD)', 'premier title md'],
  ]
  for (const [a, b] of same) assert.equal(normalizeCompanyName(a), normalizeCompanyName(b), `${a} ≡ ${b}`)
  assert.equal(normalizeCompanyName('Atlantic Closing & Escrow, LLC'), 'atlantic closing and escrow llc')
  // Never fuzzy: a prefix, a missing word or a typo is a different client.
  const different = [
    ['Lakewood Title', 'Lakewood Title Group'],
    ['Lakewood Title Group', 'Lakewod Title Group'],
    ['Meridian Mortgage', 'Meridian Mortgage LLC'],
  ]
  for (const [a, b] of different) assert.notEqual(normalizeCompanyName(a), normalizeCompanyName(b), `${a} ≠ ${b}`)
  for (const empty of [undefined, null, '', '   ', '---', '...', "''"]) {
    assert.equal(normalizeCompanyName(empty), null, JSON.stringify(empty))
  }
})

test('exactly one normalised-name match uses the existing client', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ company: 'LAKEWOOD title group.' }), deps)
  assert.equal(r.ok, true)
  assert.equal(r.clientMatch, 'name')
  assert.equal(calls.inserted[0].client_code, 'CL01')
  assert.equal(calls.inserted[0].workflow.intake.clientMatch, 'name')
  assert.equal(calls.created.length, 0, 'no client was created')
})

test('several matching clients are rejected as ambiguous — no order, no new client', async () => {
  const dupes = [CLIENT, { code: 'CL07', name: 'Coastal Title Services' }, { code: 'CL09', name: 'Coastal Title Services.' }]
  const { deps, calls } = makeDeps({}, dupes)
  const r = await processIntake(payload({ company: 'coastal title services' }), deps)
  assert.equal(r.ok, false)
  assert.equal(r.code, 'ambiguous_client')
  assert.equal(r.field, 'company')
  assert.match(r.error, /matches 2 existing clients \(CL07, CL09\)/)
  assert.equal(calls.inserted.length, 0)
  assert.equal(calls.created.length, 0)
})

test('no match creates the client from the email, then a normal order for it', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ company: 'Harbor Point Escrow, LLC' }), deps)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'created')
  assert.equal(r.clientMatch, 'created')
  // The new client carries the email's company and contact details.
  assert.deepEqual(calls.created, [{
    code: 'CL03', name: 'Harbor Point Escrow, LLC',
    contact: 'Dana Whitfield', email: 'dana@lakewoodtitle.com',
  }])
  // …and the order is an ordinary one, parked with Admin for approval.
  const row = calls.inserted[0]
  assert.equal(row.client_code, 'CL03')
  assert.equal(row.status, 'received')
  assert.equal(row.assigned_to, 'admin')
  assert.equal(row.workflow.intake.clientMatch, 'created')
})

test('a created client is recorded as internal intake metadata', async () => {
  const { deps, calls } = makeDeps()
  const r = await processIntake(payload({ company: 'Harbor Point Escrow, LLC' }), deps)
  const { intake } = calls.inserted[0].workflow
  assert.equal(intake.clientMatch, 'created')
  assert.equal(intake.clientCode, 'CL03')
  assert.equal(intake.clientCreated, true)
  assert.equal(r.clientCode, 'CL03')
})

test('special instructions carry only the client’s own content — never an intake note', async () => {
  for (const company of ['Harbor Point Escrow, LLC', 'Lakewood Title Group']) {   // created, then matched
    const { deps, calls } = makeDeps()
    await processIntake(payload({ company }), deps)
    const text = calls.inserted[0].workflow.intake.specialInstructions
    assert.equal(text, 'Closing is tight.\n\nClient order number: ORD-9911\nCustomer link: https://client.example/orders/9911', company)
    assert.equal(/new client|created automatically|CL0\d/i.test(text), false, company)
  }
  // …and with nothing said, still nothing.
  const { deps, calls } = makeDeps()
  await processIntake(payload({ company: 'Harbor Point Escrow', special_instructions: undefined,
    order_number: undefined, customer_link: undefined }), deps)
  assert.equal(calls.inserted[0].workflow.intake.specialInstructions, null)
})

test('a matched client is recorded as not created', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload(), deps)
  const { intake } = calls.inserted[0].workflow
  assert.deepEqual([intake.clientMatch, intake.clientCode, intake.clientCreated], ['name', 'CL01', false])
})

test('clientMatch is always one of code | name | created', async () => {
  assert.deepEqual(CLIENT_MATCH, ['code', 'name', 'created'])
  for (const extra of [{ client_identifier: 'CL01' }, {}, { company: 'Brand New Title Co' }]) {
    const { deps, calls } = makeDeps()
    const r = await processIntake(payload(extra), deps)
    assert.ok(CLIENT_MATCH.includes(r.clientMatch), JSON.stringify(extra))
    assert.equal(calls.inserted[0].workflow.intake.clientMatch, r.clientMatch)
  }
})

test('a replayed email creates neither a second order nor a second client', async () => {
  const { deps, calls } = makeDeps()
  const first = await processIntake(payload({ company: 'Harbor Point Escrow' }), deps)
  const second = await processIntake(payload({ company: 'Harbor Point Escrow' }), deps)
  assert.equal(first.clientMatch, 'created')
  assert.equal(second.status, 'duplicate')
  assert.equal(calls.created.length, 1)
  assert.equal(calls.writes.length, 1, 'the duplicate check runs before the database write')
  assert.equal(calls.inserted.length, 1)
})

test('two emails from one new company share a single new client', async () => {
  const { deps, calls } = makeDeps()
  const a = await processIntake(payload({ company: 'Harbor Point Escrow, LLC', email_message_id: 'm-1' }), deps)
  const b = await processIntake(payload({ company: 'harbor point escrow llc', email_message_id: 'm-2' }), deps)
  assert.deepEqual([a.clientMatch, b.clientMatch], ['created', 'name'])
  assert.equal(calls.created.length, 1)
  assert.deepEqual(calls.inserted.map(o => o.client_code), ['CL03', 'CL03'])
})

test('client and order are one database write — there is no separate client step', async () => {
  const { deps, calls } = makeDeps()
  await processIntake(payload({ company: 'Harbor Point Escrow' }), deps)
  assert.equal(calls.writes.length, 1)
  // The deps surface has no way to create a client on its own.
  assert.deepEqual(Object.keys(deps).sort(), ['createIntakeOrder', 'findByMessageId', 'today'])
})

test('a failed order write propagates and leaves no client behind', async () => {
  // The database rolls a new client back with its failed order; processIntake
  // must not paper over the error or retry the client some other way.
  const { deps, calls } = makeDeps({
    createIntakeOrder: async () => { const e = new Error('insert or update on table "orders" violates foreign key constraint'); e.code = '23503'; throw e },
  })
  await assert.rejects(() => processIntake(payload({ company: 'Harbor Point Escrow' }), deps), /foreign key/)
  assert.equal(calls.created.length, 0)
  assert.equal(calls.inserted.length, 0)
})

test('an ambiguous or unknown client writes nothing', async () => {
  const dupes = [CLIENT, { code: 'CL07', name: 'Coastal Title Services' }, { code: 'CL09', name: 'Coastal Title Services.' }]
  for (const [extra, code] of [[{ company: 'Coastal Title Services' }, 'ambiguous_client'], [{ client_identifier: 'CL99' }, 'unknown_client']]) {
    const { deps, calls } = makeDeps({}, dupes)
    const r = await processIntake(payload(extra), deps)
    assert.equal(r.code, code)
    assert.equal(calls.inserted.length, 0)
    assert.equal(calls.created.length, 0)
  }
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
  assert.equal(calls.writes.length, 0, 'no client is matched or created for a duplicate')
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
    // The loser's whole transaction — any client it created included — rolled back.
    createIntakeOrder: async () => { const e = new Error('duplicate key value violates unique constraint'); e.code = '23505'; throw e },
  })
  const r = await processIntake(payload(), deps)
  assert.equal(r.ok, true)
  assert.equal(r.status, 'duplicate')
  assert.equal(r.order.id, 'RTS-10049')
  assert.equal(calls.inserted.length, 0)
})

test('a real insert failure propagates instead of being reported as a duplicate', async () => {
  const { deps } = makeDeps({ createIntakeOrder: async () => { throw new Error('connection reset') } })
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

// ── The database half: intake_resolve_client ─────────────────────────────────
// The match and the create run in Postgres, which these tests cannot reach, so
// they pin the migration's rules instead. (The SQL itself was exercised against
// a real Postgres 16 when it was written.)
const SQL = readFileSync(
  new URL('../../../supabase/migrations/20260925000000_email_intake_client_resolution.sql', import.meta.url), 'utf8')
const sqlFn = (name) => {
  const m = SQL.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$\\$;`))
  assert.ok(m, `${name} not found in the migration`)
  return m[0]
}
const squash = (s) => s.replace(/\s+/g, ' ')

test('client_name_key applies exactly the normalizeCompanyName rule', () => {
  // Step for step: A–Z folding, & → and, drop apostrophes and full stops, other
  // runs of punctuation/whitespace → one space, trim, empty → null.
  assert.ok(squash(sqlFn('client_name_key')).includes(squash(`
    select nullif(btrim(regexp_replace(regexp_replace(
      replace(translate(coalesce(p_name, ''), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
                                              'abcdefghijklmnopqrstuvwxyz'), '&', ' and '),
      '[''’.]', '', 'g'),
      '[^a-z0-9]+', ' ', 'g')), '')`)), 'client_name_key drifted from normalizeCompanyName')
  const js = normalizeCompanyName.toString()
  for (const step of [`/[A-Z]/g`, `/&/g, ' and '`, `/['’.]/g, ''`, `/[^a-z0-9]+/g, ' '`, '.trim() || null']) {
    assert.ok(js.includes(step), `normalizeCompanyName lost the step ${step}`)
  }
})

test('the database matches on the normalised company name only — never an address', () => {
  const body = sqlFn('intake_resolve_client')
  assert.match(body, /where public\.client_name_key\(name\) = v_key;/)
  assert.equal(/where[^;]*(email|contact)/i.test(body), false, 'no WHERE may consult an email or contact')
})

test('match-or-create runs under a per-name lock taken before the lookup', () => {
  const body = sqlFn('intake_resolve_client')
  const lock = body.indexOf("pg_advisory_xact_lock(hashtextextended('email_intake.client:' || v_key, 0))")
  assert.ok(lock > 0, 'the per-name advisory lock is missing')
  assert.ok(lock < body.indexOf('from public.clients'), 'the lock must be taken before the match query')
  assert.equal(/\b(stable|immutable)\b/i.test(body.split('as $$')[0]), false,
    'must stay volatile: each statement needs a fresh snapshot after the lock')
})

test('the CL sequence starts above the highest CL code actually in the table', () => {
  const setval = SQL.match(/select setval\('public\.client_code_seq'[\s\S]*?;/)
  assert.ok(setval, 'the sequence is never positioned')
  assert.match(setval[0], /from public\.clients/, 'must read the live table, not assume the seed')
  assert.match(setval[0], /'\^CL\(\[0-9\]\{1,18\}\)\$'/)
  assert.match(setval[0], /greatest\(m\.n, s\.last_value\)/, 'must never move the sequence backwards')
})

test('client codes widen past CL99 instead of truncating', () => {
  const body = sqlFn('next_client_code')
  // lpad(text, 2) would turn 100 into '10' — a duplicate of CL10.
  assert.ok(body.includes("'CL' || lpad(n::text, greatest(length(n::text), 2), '0')"))
  assert.equal(/lpad\(n::text, 2,/.test(body), false)
  // A code entered by hand is skipped, not reissued.
  assert.match(body, /exit when not exists \(select 1 from public\.clients where upper\(btrim\(code\)\) = v_code\)/)
})

test('a new client gets the email details and keeps every other default', () => {
  // Exactly these columns — payment_terms, created_at and the rest keep their defaults.
  assert.match(sqlFn('intake_resolve_client'),
    /insert into public\.clients \(code, name, contact, email, registered\)\s*values \(v_code, v_name, /)
})

test('only the service role may call intake_create_order; the rest are internal', () => {
  for (const fn of ['client_name_key(text)', 'next_client_code()', 'intake_resolve_client(text, text, text)',
                    'intake_create_order(jsonb, text, text, text, text)']) {
    assert.ok(SQL.includes(`revoke all on function public.${fn} from public, anon, authenticated;`), `${fn} is not revoked`)
  }
  assert.ok(SQL.includes('revoke all on sequence public.client_code_seq from public, anon, authenticated;'))
  const grants = [...SQL.matchAll(/^grant execute on function public\.(\w+)\(/gm)].map(m => m[1])
  assert.deepEqual(grants, ['intake_create_order'], 'the API has exactly one entry point')
})

// ── Atomic client + order: intake_create_order ───────────────────────────────
test('intake_create_order resolves the client and inserts the order in one function', () => {
  const body = sqlFn('intake_create_order')
  const resolve = body.indexOf('public.intake_resolve_client(p_company, p_contact, p_email)')
  const insert = body.indexOf('insert into public.orders')
  assert.ok(resolve > 0 && insert > resolve, 'client resolution must precede the order insert, in the same function')
  // No exception handler: catching an insert error would commit the client
  // and drop the order — the exact orphan this function prevents.
  assert.equal(/\bexception\b/i.test(body), false, 'intake_create_order must not trap errors')
})

test('an ambiguous or unknown client returns before an order id is drawn or anything is written', () => {
  const body = sqlFn('intake_create_order')
  const nextId = body.indexOf('public.next_order_id()')
  assert.ok(nextId > 0)
  assert.ok(body.indexOf("return jsonb_build_object('status', 'unknown_client')") < nextId)
  assert.ok(body.indexOf("if v_resolved->>'status' = 'ambiguous' then\n      return v_resolved;") < nextId)
})

test('the database inserts exactly the columns the API row carries — a website order’s columns', () => {
  const body = sqlFn('intake_create_order')
  const cols = body.match(/insert into public\.orders \(([^)]*)\)/)[1].split(',').map(c => c.trim())
  assert.deepEqual([...cols].sort(), Object.keys(rowFor()).sort())
})

test('the database records clientMatch, clientCode and clientCreated in workflow.intake', () => {
  const body = squash(sqlFn('intake_create_order'))
  for (const piece of [
    "'clientMatch', v_match", "'clientCode', v_code", "'clientCreated', v_match = 'created'",
    "'company', coalesce(p_order #>> '{workflow,intake,company}', v_name)",
    "'id', public.next_order_id()", "'client_code', v_code",
  ]) assert.ok(body.includes(piece), `missing: ${piece}`)
  // An explicit code is exact, with no fallback to the name.
  assert.match(body, /if p_client_code is not null then select code, name into v_code, v_name from public\.clients where code = p_client_code;/)
})

// ── store.js: the one database call and its result mapping ───────────────────
const fakeDb = (reply) => {
  const seen = []
  return { seen, client: { rpc: async (fn, args) => { seen.push({ fn, args }); return reply } } }
}

test('createIntakeOrder makes exactly one intake_create_order call', async () => {
  const order = { id: 'RTS-10060', status: 'received', assigned_to: 'admin', client_code: 'CL08', type: 'Full Search' }
  const db = fakeDb({ data: { status: 'created', clientMatch: 'created', clientCode: 'CL08', order }, error: null })
  const row = rowFor()
  const r = await createDeps(db.client).createIntakeOrder({
    row, company: 'Harbor Point Escrow', contact: 'Dana Whitfield', email: 'dana@lakewoodtitle.com',
  })
  assert.deepEqual(db.seen, [{
    fn: 'intake_create_order',
    args: { p_order: row, p_company: 'Harbor Point Escrow', p_contact: 'Dana Whitfield',
      p_email: 'dana@lakewoodtitle.com', p_client_code: null },
  }])
  assert.deepEqual(r, { status: 'created', clientMatch: 'created', clientCode: 'CL08', order })
})

test('createIntakeOrder maps ambiguous and unknown, and keeps the Postgres error code', async () => {
  const deps = (reply) => createDeps(fakeDb(reply).client)
  const args = { row: {}, company: 'x' }
  assert.deepEqual(await deps({ data: { status: 'ambiguous', codes: ['CL07', 'CL09'] }, error: null }).createIntakeOrder(args),
    { status: 'ambiguous', codes: ['CL07', 'CL09'] })
  assert.deepEqual(await deps({ data: { status: 'unknown_client' }, error: null }).createIntakeOrder(args),
    { status: 'unknown_client' })
  await assert.rejects(() => deps({ data: { status: 'created' }, error: null }).createIntakeOrder(args), /unexpected result/)
  // 23505 must survive the trip so processIntake can turn a lost race into "duplicate".
  await assert.rejects(() => deps({ data: null, error: { message: 'dup', code: '23505' } }).createIntakeOrder(args),
    (err) => err.code === '23505' && /order creation failed: dup/.test(err.message))
})

test('the HTTP adapter answers 422 for an ambiguous client and reports clientMatch', () => {
  const API = readFileSync(new URL('../../../api/orders/email-intake.js', import.meta.url), 'utf8')
  assert.match(API, /ambiguous_client: 422/)
  assert.match(API, /clientMatch: duplicate \? null : \(result\.clientMatch \?\? null\)/)
})

// ── Client privacy: restricted roles see the database code ───────────────────
const restricted = { role: 'screener', superAdmin: false }
const superAdmin = { role: 'admin', superAdmin: true }

test('restricted roles see the order’s own client code, even for a client created by intake', () => {
  assert.equal(displayClient('Harbor Point Escrow, LLC', restricted, 'CL08'), 'CL08')
  // The database code wins over the demo name table.
  assert.equal(displayClient('Lakewood Title Group', restricted, 'CL42'), 'CL42')
})

test('super admins still see the client name', () => {
  assert.equal(displayClient('Harbor Point Escrow, LLC', superAdmin, 'CL08'), 'Harbor Point Escrow, LLC')
})

test('mock mode, where orders carry no clientCode, still resolves the demo codes', () => {
  assert.equal(displayClient('Lakewood Title Group', restricted), 'CL01')
})

test('every order call site passes the order’s clientCode', () => {
  const root = new URL('../../../src/', import.meta.url)
  const sources = readdirSync(root, { recursive: true })
    .filter(f => /\.(jsx?|tsx?)$/.test(f))
    .map(f => [f, readFileSync(new URL(f, root), 'utf8')])
  let calls = 0
  for (const [file, text] of sources) {
    for (const m of text.matchAll(/displayClient\((\w+)\.client, user(, (\w+)\.clientCode)?\)/g)) {
      calls++
      assert.ok(m[2] && m[3] === m[1], `${file}: displayClient(${m[1]}.client, user) must pass ${m[1]}.clientCode`)
    }
  }
  assert.ok(calls >= 22, `expected the order call sites, found ${calls}`)
})

test('the new-client indication renders only on Admin’s order view, by code', () => {
  const root = new URL('../../../src/', import.meta.url)
  const hits = readdirSync(root, { recursive: true })
    .filter(f => /\.(jsx?|tsx?)$/.test(f))
    .filter(f => /clientCreated|New client created from email/.test(readFileSync(new URL(f, root), 'utf8')))
  assert.deepEqual(hits.map(f => f.replace(/\\/g, '/')), ['pages/admin/AdminDashboard.jsx'])
  const admin = readFileSync(new URL('pages/admin/AdminDashboard.jsx', root), 'utf8')
  assert.match(admin, /\{intake\.clientCreated && \([\s\S]{0,200}New client created from email: \{intake\.clientCode\}/)
  // …and that page is admin-only.
  const app = readFileSync(new URL('App.jsx', root), 'utf8')
  assert.match(app, /path="\/admin\/\*" element=\{\s*<ProtectedRoute allowedRole="admin"><AdminDashboard \/>/)
})

// ── Admin client directory: the clients table, not the demo list ─────────────
test('Admin’s client picker lists the clients table when Supabase is live', () => {
  const root = new URL('../../../src/', import.meta.url)
  const backend = readFileSync(new URL('lib/backend.js', root), 'utf8')
  assert.match(backend, /export async function fetchClients\(\) \{\s*const \{ data, error \} = await supabase\.from\('clients'\)\.select\('code, name'\)/)
  const admin = readFileSync(new URL('pages/admin/AdminDashboard.jsx', root), 'utf8')
  // Live → the table; mock → the demo registry, kept for explicit mock mode.
  assert.match(admin, /useState\(isSupabaseConfigured \? \[\] : CLIENTS\)/)
  assert.match(admin, /fetchClients\(\)\.then\(rows => \{ if \(live && rows\) setClients\(rows\) \}\)/)
  const modal = admin.match(/function NewOrderModal\([\s\S]*?\n\}\n/)[0]
  assert.match(modal, /const clients = useClientDirectory\(\)/)
  assert.equal(/CLIENTS\.map/.test(modal), false, 'the picker must not list the hard-coded demo clients')
  // The picked value is the real code; restricted admins see only the code.
  assert.match(modal, /clientCode: f\.client,/)
  assert.match(modal, /user\?\.superAdmin \? `\$\{c\.code\} · \$\{c\.name\}` : c\.code/)
})
