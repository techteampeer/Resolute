// Validation + normalisation for website order intake.
//
// The payload is the public order form's own JSON (resolutetitleservices.com
// /order → the Google Apps Script web app), forwarded server-to-server by that
// Apps Script with one field added: a stable `submissionId`. There is no
// extraction and no AI — every value is what the customer typed or picked.
// Pure: no Supabase, no network, no env.
//
// Two tiers, on purpose:
//   REJECT  what makes an order impossible to create or route safely: no
//           submission id, no company to resolve the client from, no usable
//           contact, an unknown state, no product, a product name the website
//           does not sell, a tripped honeypot. The website form already
//           requires each of these, so a rejection means a broken or tampered
//           payload — the Apps Script marks the row `rejected` and a person
//           reviews it.
//   FLAG    what Admin settles at Confirm & price anyway: a product with no
//           confirmed portal equivalent, a custom search, a missing address.
//           The order still lands unconfirmed in Awaiting Approval and
//           `reviewNotes` (Admin's view only) say what to check. The client
//           hold and the clarification request are NOT used for this — both
//           are shown to the client.
import { normalizeCompanyName, normalizeTurnaround, SEARCH_CATALOG } from '../email_intake/schema.js'

// ── States ───────────────────────────────────────────────────────────────────
// Identical to US_STATES in src/data/mockData.js — a test holds the two in
// step. Not imported from there: mockData re-exports from the Vite-only
// '@domain' alias, which the plain-Node serverless runtime cannot resolve.
export const STATES = [
  ['AL','Alabama'],['AK','Alaska'],['AZ','Arizona'],['AR','Arkansas'],['CA','California'],
  ['CO','Colorado'],['CT','Connecticut'],['DE','Delaware'],['DC','District of Columbia'],
  ['FL','Florida'],['GA','Georgia'],['HI','Hawaii'],['ID','Idaho'],['IL','Illinois'],
  ['IN','Indiana'],['IA','Iowa'],['KS','Kansas'],['KY','Kentucky'],['LA','Louisiana'],
  ['ME','Maine'],['MD','Maryland'],['MA','Massachusetts'],['MI','Michigan'],['MN','Minnesota'],
  ['MS','Mississippi'],['MO','Missouri'],['MT','Montana'],['NE','Nebraska'],['NV','Nevada'],
  ['NH','New Hampshire'],['NJ','New Jersey'],['NM','New Mexico'],['NY','New York'],
  ['NC','North Carolina'],['ND','North Dakota'],['OH','Ohio'],['OK','Oklahoma'],['OR','Oregon'],
  ['PA','Pennsylvania'],['RI','Rhode Island'],['SC','South Carolina'],['SD','South Dakota'],
  ['TN','Tennessee'],['TX','Texas'],['UT','Utah'],['VT','Vermont'],['VA','Virginia'],
  ['WA','Washington'],['WV','West Virginia'],['WI','Wisconsin'],['WY','Wyoming'],
]
const STATE_CODES = new Set(STATES.map(([code]) => code))
const CODE_BY_STATE_NAME = new Map(STATES.map(([code, name]) => [name.toLowerCase(), code]))

// ── The website's product list ───────────────────────────────────────────────
// The seven products resolutetitleservices.com/order offers, exactly as the
// form sends them in `product` (resolute-website src/content/services.ts →
// `name`). `portalType` is the portal catalog product (src/data/products.js)
// that is the SAME service, and is set only once the business has confirmed
// the equivalence. None is confirmed today, so every one is null: the order
// keeps the website's own product name as its type, which Confirm & price
// treats as quote-only, so Admin agrees the price before work starts. Do not
// fill these in by resemblance — e.g. 'Legal & Vesting Report' overlaps
// 'Current Owner Search', but the portal product also carries requirements
// and exceptions the website product does not promise.
export const WEBSITE_PRODUCTS = [
  { name: 'Judgment & Lien Search', portalType: null },
  { name: 'Legal & Vesting Report', portalType: null },
  { name: 'Assignment Verification Report', portalType: null },
  { name: 'Mortgage & Assignment Search', portalType: null },
  { name: 'Vesting Deed & Chain of Title Search', portalType: null },
  { name: 'Attorney Opinion Letter', portalType: null },
  { name: 'Municipal Lien Search', portalType: null },
]

for (const p of WEBSITE_PRODUCTS) {
  // A typo in a confirmed mapping must fail loudly at import, not create an
  // order the portal cannot price.
  if (p.portalType != null && !SEARCH_CATALOG.includes(p.portalType)) {
    throw new Error(`website_intake: "${p.name}" maps to "${p.portalType}", which is not in the product catalog`)
  }
}

const PRODUCT_BY_NAME = new Map(WEBSITE_PRODUCTS.map(p => [p.name.toLowerCase(), p]))

// The order type for a custom search (no product picked). The label the
// website itself shows for one, so Admin reads the customer's own words.
export const CUSTOM_SEARCH_TYPE = 'Custom search'

// ── Field set ────────────────────────────────────────────────────────────────
// Every key the website form sends (src/routes/order.tsx `payload`), plus the
// Apps Script's `submissionId`, with a length cap each. Anything else is
// ignored — a client code above all: public input never picks a client.
const LINE = 200
const LONG = 10000
export const FIELD_LIMITS = {
  submissionId: 64, submittedAt: 40, website: LINE,
  businessName: LINE, contactName: LINE, workEmail: 254,
  propertyState: 40, county: LINE, address: LINE, city: LINE, zip: 20,
  parcelApn: LINE, yourFileRef: LINE, propertyType: LINE, parties: 2000,
  searchType: LINE, product: LINE, customSearch: LONG, priority: 40,
  specialInstructions: LONG,
}
const MULTILINE = new Set(['customSearch', 'specialInstructions'])

export const REQUIRED_FIELDS = [
  'submissionId', 'businessName', 'contactName', 'workEmail',
  'propertyState', 'county', 'priority',
]

// Apps Script's Utilities.getUuid(). Lower-cased before use so two spellings of
// one id can never become two orders.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// The website's own check (order.tsx emailOk), minus the characters that would
// let an address break out of the "Name <email>" line it is written into.
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/

const ZIP_RE = /^\d{5}(-\d{4})?$/

// The website's party roles, sent as "Buyer: A; Seller: B; Borrower: C".
const PARTY_RE = /^(buyer|seller|borrower)\s*:\s*(.+)$/i

// The website marks submissions with this prefix in the shared messageId
// idempotency key. A Gmail id is hex and an RFC 5322 Message-ID always has an
// '@'; a website key is 'website:' + a UUID, so the two can never collide.
export const WEBSITE_MESSAGE_PREFIX = 'website:'
export const websiteMessageId = (submissionId) => `${WEBSITE_MESSAGE_PREFIX}${submissionId}`

const fail = (field, error) => ({ ok: false, field, error })

// Text in, text out. Numbers are accepted for the fields a spreadsheet may
// have turned numeric (a ZIP, a parcel number) and become strings; any other
// non-string is a type error (undefined). Control characters never survive: a
// one-line field collapses all whitespace, a free-text field keeps its line
// breaks and tabs.
function clean(v, multiline) {
  if (v == null) return null
  if (typeof v === 'number' && Number.isFinite(v)) v = String(v)
  if (typeof v !== 'string') return undefined
  const s = multiline
    ? v.replace(/\r\n?/g, '\n').replace(/\p{Cc}/gu, c => (c === '\n' || c === '\t' ? c : '')).trim()
    : v.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return s === '' ? null : s
}

// Full state name ("Florida", as the website sends it) or code → the 2-letter
// code orders.state carries everywhere else. Null when it is neither.
export const toStateCode = (raw) => {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim()
  if (STATE_CODES.has(s.toUpperCase())) return s.toUpperCase()
  return CODE_BY_STATE_NAME.get(s.toLowerCase()) || null
}

// One name field → first + last, without guessing. The first word is the first
// name and the rest is the last name; a single word has no last name. Nothing
// is reordered, dropped or title-cased, and the full name is always kept
// verbatim beside the parts. Angle brackets and quotes are removed because the
// name is written into a "Name <email>" line. Null when no letter remains.
export function splitContactName(raw) {
  const full = String(raw ?? '').replace(/[<>"]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!/\p{L}/u.test(full)) return null
  const i = full.indexOf(' ')
  return i === -1
    ? { full, first: full, last: null }
    : { full, first: full.slice(0, i), last: full.slice(i + 1) }
}

// "Buyer: A; Seller: B; Buyer: C" → { buyer: 'A, C', seller: 'B', borrower: null }.
// A segment that is not "Role: Name" is returned in `unparsed` (and flagged for
// review) rather than assigned to a role by guesswork.
export function parseParties(raw) {
  const roles = { buyer: [], seller: [], borrower: [] }
  const unparsed = []
  for (const part of String(raw ?? '').split(';')) {
    const s = part.trim()
    if (!s) continue
    const m = PARTY_RE.exec(s)
    if (m) roles[m[1].toLowerCase()].push(m[2].trim())
    else unparsed.push(s)
  }
  const join = (names) => (names.length ? names.join(', ') : null)
  return { buyer: join(roles.buyer), seller: join(roles.seller), borrower: join(roles.borrower), unparsed }
}

// Validate + normalise. Returns { ok: true, value } or { ok: false, field, error }.
export function validateWebsiteOrder(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(null, 'Payload must be a JSON object')
  }

  const v = {}
  for (const [key, max] of Object.entries(FIELD_LIMITS)) {
    const c = clean(raw[key], MULTILINE.has(key))
    if (c === undefined) return fail(key, `${key} must be text`)
    if (c && c.length > max) return fail(key, `${key} exceeds ${max} characters`)
    v[key] = c
  }

  // The website's spam trap. The Apps Script already drops these; refusing
  // here too means a bot submission can never become an order.
  if (v.website) return fail('website', 'Rejected: the spam-trap field is filled')

  for (const field of REQUIRED_FIELDS) {
    if (!v[field]) return fail(field, `${field} is required`)
  }

  if (!UUID_RE.test(v.submissionId)) {
    return fail('submissionId', 'submissionId must be a UUID (Apps Script Utilities.getUuid())')
  }
  const submissionId = v.submissionId.toLowerCase()

  // The company is the only client key, matched by the existing rules in
  // intake_create_order. It must survive the same normalisation.
  if (!normalizeCompanyName(v.businessName)) {
    return fail('businessName', 'businessName must contain letters or digits')
  }

  const contact = splitContactName(v.contactName)
  if (!contact) return fail('contactName', 'contactName must contain a name')

  if (!EMAIL_RE.test(v.workEmail)) {
    return fail('workEmail', 'workEmail is not a valid email address')
  }

  const propertyState = toStateCode(v.propertyState)
  if (!propertyState) {
    return fail('propertyState', 'propertyState must be a US state name or 2-letter code')
  }

  // 'Standard' → normal, 'Rush' → rush: the same table email intake uses.
  const priority = normalizeTurnaround(v.priority)
  if (!priority) return fail('priority', "priority must be 'Standard' or 'Rush'")

  let product = null
  if (v.product) {
    product = PRODUCT_BY_NAME.get(v.product.toLowerCase())
    if (!product) {
      return fail('product', `product "${v.product}" is not a website product. Expected one of: ${WEBSITE_PRODUCTS.map(p => p.name).join(', ')}`)
    }
  } else if (!v.customSearch) {
    return fail('product', 'product or customSearch is required')
  }

  // What the order's type becomes. A confirmed equivalent → the portal product;
  // otherwise the customer's own selection, verbatim.
  const type = product ? (product.portalType || product.name) : CUSTOM_SEARCH_TYPE
  const productMapped = Boolean(product?.portalType)

  const parties = parseParties(v.parties)

  // Admin-only notes: what to check before confirming. Never client content.
  const reviewNotes = []
  if (product && !productMapped) {
    reviewNotes.push(`Website product "${product.name}" has no confirmed portal equivalent — agree the service and set the price at Confirm & price.`)
  }
  if (!product) {
    reviewNotes.push('Custom search requested — read the description in the special instructions, then agree the service and set the price at Confirm & price.')
  }
  const missing = [!v.address && 'street address', !v.city && 'city'].filter(Boolean)
  if (missing.length) reviewNotes.push(`No ${missing.join(' or ')} given — confirm the property before approving.`)
  if (v.zip && !ZIP_RE.test(v.zip)) reviewNotes.push(`ZIP "${v.zip}" is not a 5-digit US ZIP — confirm it.`)
  if (parties.unparsed.length) {
    reviewNotes.push(`Some parties are not in "Role: Name" form — check the original parties text: ${parties.unparsed.join('; ')}`)
  }

  return {
    ok: true,
    value: {
      submissionId,
      messageId: websiteMessageId(submissionId),
      company: v.businessName,
      contactName: contact.full,
      contactFirstName: contact.first,
      contactLastName: contact.last,
      contactEmail: v.workEmail,
      propertyState,
      county: v.county,
      propertyAddress: v.address,
      city: v.city,
      zip: v.zip,
      parcelApn: v.parcelApn,
      clientFileNumber: v.yourFileRef,
      propertyType: v.propertyType,
      buyer: parties.buyer,
      seller: parties.seller,
      borrower: parties.borrower,
      partiesText: v.parties,
      type,
      productMapped,
      websiteProduct: product ? product.name : null,
      customSearch: v.customSearch,
      searchType: v.searchType,
      priority,
      requestedPriority: v.priority,       // the customer's own wording
      specialInstructions: v.specialInstructions,
      submittedAt: v.submittedAt,
      reviewNotes,
    },
  }
}
