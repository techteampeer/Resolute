// Validation + normalisation for the email-intake payload.
//
// The payload arrives already extracted (Google Apps Script → Gemini), so this
// module's whole job is to decide whether it is a complete, actionable order
// and to reshape it into the SAME order row the Client Portal produces. It is
// pure and dependency-free: no Supabase, no network, no env.
//
// Kept deliberately strict. A rejected message is safe — Apps Script leaves it
// unread and a human looks at it — while a half-guessed order is not: it would
// enter production carrying invented data. Where a client's wording can differ
// from ours (search type, turnaround) the mapping is an EXPLICIT table, never
// a fuzzy match.
import { PRODUCTS, PRODUCT_PRICE } from '../../src/data/products.js'

// The portal's real search catalog — the only values `orders.type` may take.
// Derived from the same single source of truth the Place Order form renders
// (PRODUCTS) plus the legacy short names carried by existing orders, so the
// catalog can never drift from what the portal actually sells.
export const SEARCH_CATALOG = [...new Set([
  ...PRODUCTS.map(p => p.name),
  ...Object.keys(PRODUCT_PRICE),
])]

// The official intake field set. Anything else in the payload is ignored rather
// than rejected, so a later Apps Script / Gemini revision adding a field cannot
// break intake.
export const REQUIRED_FIELDS = [
  'property_state', 'county', 'property_address', 'city', 'search_type',
  'turnaround', 'contact_first_name', 'contact_last_name', 'contact_email',
  'email_message_id',
]

// The client is identified by ONE of these, so each is optional on its own and
// validateIntake requires at least one: `company` (the name as written in the
// email — how normal email intake identifies the client) or `client_identifier`
// (an exact clients.code, for a trusted caller that already knows it).
export const OPTIONAL_FIELDS = [
  'zip', 'parcel_apn', 'client_file_number', 'buyer', 'borrower', 'seller',
  'special_instructions', 'company', 'order_number', 'customer_link',
  'email_subject', 'source_email', 'client_identifier',
]

export const INTAKE_KEYS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS]

// RFC 5322 caps a header line at 998 octets. Gmail's own message.getId() is a
// short hex string, so this only ever bites on a malformed payload.
const MAX_MESSAGE_ID = 998

// The same shape check the Place Order form applies to a contact email
// (ClientDashboard's stepValid) — one rule for both intake channels.
const EMAIL_RE = /\S+@\S+\.\S+/

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const fail = (field, error) => ({ ok: false, field, error })

// Fold a client's wording to a comparison key: case, punctuation and spacing
// are noise, everything else is meaning. Used only to look up an EXPLICIT
// table — it never turns an unknown value into a known one.
const key = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// A Message-ID is written `<local@domain>` in the header but handed around bare
// just as often. Strip the angle brackets so the two spellings dedupe to one
// key. NOT lower-cased: the local part is case-sensitive per RFC 5322, and
// folding it could collapse two genuinely different messages into one order.
export const normalizeMessageId = (raw) => {
  const s = str(raw)
  if (!s) return null
  return s.replace(/^<+/, '').replace(/>+$/, '').trim() || null
}

// ── Company name → the client match key ─────────────────────────────────────
// The ONE normalisation rule for matching a company name to a client. It is
// mirrored exactly by public.client_name_key() in
// 20260925000000_email_intake_client_resolution.sql, which is where the match
// actually happens; the tests hold the two in step. Deterministic, never fuzzy:
//
//   case-insensitive · '&' reads as 'and' · apostrophes and full stops are
//   dropped (L.L.C. = LLC, O'Brien = OBrien) · any other run of punctuation or
//   whitespace is one space
//
// Only A–Z is case-folded, on purpose: Postgres lower() folds other letters by
// the database's locale, so ASCII-only folding is what keeps this and the SQL
// identical on every database. Letters outside a–z / 0–9 count as separators.
//
// Returns null when nothing usable is left, so '---' cannot identify a client.
export const normalizeCompanyName = (raw) => {
  const s = str(raw)
  if (!s) return null
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim() || null
}

// ── Search type ──────────────────────────────────────────────────────────────
// Resolution is a three-step lookup on the folded key, in this order:
//
//   1. the CURRENT catalog — the products the Place Order form offers today
//   2. the explicit alias table below
//   3. the LEGACY short names, for products that only exist under one
//
// The order matters because folding punctuation makes the legacy 'Two-Owner'
// and the current 'Two Owner Search' share a key. A new order should carry the
// name the website would write, so the current catalog and the alias table both
// outrank the legacy spelling, and 'Two-Owner' normalises forward to
// 'Two Owner Search' — the same product at the same price, not a guess.
// Legacy-only products ('Lien Search', 'Tax Certificate', 'HOA Estoppel') have
// unique keys and still resolve to themselves.
const CURRENT_NAMES = PRODUCTS.map(p => p.name)
const LEGACY_NAMES = Object.keys(PRODUCT_PRICE).filter(n => !CURRENT_NAMES.includes(n))

const SEARCH_BY_KEY = new Map()
for (const name of CURRENT_NAMES) {
  // Two current products folding to one key would make resolution arbitrary.
  if (SEARCH_BY_KEY.has(key(name))) {
    throw new Error(`email_intake: product catalog has two names folding to "${key(name)}"`)
  }
  SEARCH_BY_KEY.set(key(name), name)
}

// Wordings clients and Gemini actually use for a product we sell. Deliberately
// finite and hand-checked: an unlisted wording is REJECTED, never guessed at.
// Note what is absent — 'Tax Search' and the legacy 'Tax Certificate' are
// different products, so neither is aliased to the other.
const SEARCH_ALIASES = {
  'current owner': 'Current Owner Search',
  'current owner rundown': 'Current Owner Search',
  'two owner': 'Two Owner Search',
  'full': 'Full Search',
  'full title search': 'Full Search',
  'update': 'Update / Bringdown',
  'bringdown': 'Update / Bringdown',
  'bring down': 'Update / Bringdown',
  'update bring down': 'Update / Bringdown',
  'commercial': 'Commercial Search',
  'energy': 'Energy / Infrastructure',
  'infrastructure': 'Energy / Infrastructure',
  'patriot': 'Patriot Name Search',
  'patriot act search': 'Patriot Name Search',
  'ofac': 'Patriot Name Search',
  'ofac search': 'Patriot Name Search',
  'bankruptcy': 'Bankruptcy Name Search',
  'bankruptcy search': 'Bankruptcy Name Search',
  'doc retrieval': 'Document Retrieval',
  'document retrieval request': 'Document Retrieval',
}

for (const [k, name] of Object.entries(SEARCH_ALIASES)) {
  // A typo in the table above must fail loudly at import, not silently accept
  // a product the portal cannot price.
  if (!SEARCH_CATALOG.includes(name)) {
    throw new Error(`email_intake: alias "${k}" targets "${name}", which is not in the product catalog`)
  }
  if (!SEARCH_BY_KEY.has(k)) SEARCH_BY_KEY.set(k, name)
}

// Step 3: legacy short names claim only the keys still unspoken for.
for (const name of LEGACY_NAMES) {
  if (!SEARCH_BY_KEY.has(key(name))) SEARCH_BY_KEY.set(key(name), name)
}

// Returns an exact catalog name, or null when the wording is not one we know.
export const normalizeSearchType = (raw) => {
  const s = str(raw)
  return s ? SEARCH_BY_KEY.get(key(s)) || null : null
}

// ── Turnaround → the existing order_priority enum ────────────────────────────
// The portal has exactly two priorities ('normal' | 'rush'), so the client's
// two turnaround options map straight onto them. No new column, no new enum.
const TURNAROUND_PRIORITY = {
  'standard': 'normal',
  'standard 48 hours': 'normal',
  'standard 48 hrs': 'normal',
  'standard 48 hour': 'normal',
  'standard 48': 'normal',
  '48 hours': 'normal',
  '48 hrs': 'normal',
  '48 hour': 'normal',
  '48': 'normal',
  'normal': 'normal',
  'rush': 'rush',
  'rush 24 hours': 'rush',
  'rush 24 hrs': 'rush',
  'rush 24 hour': 'rush',
  'rush 24': 'rush',
  '24 hours': 'rush',
  '24 hrs': 'rush',
  '24 hour': 'rush',
  '24': 'rush',
}

export const normalizeTurnaround = (raw) => {
  const s = str(raw)
  return s ? TURNAROUND_PRIORITY[key(s)] || null : null
}

// Validate + normalise. Returns { ok: true, value } or { ok: false, field, error }.
// `value` uses the app's own camelCase intake vocabulary so the caller can hand
// it straight to buildOrderRow.
export function validateIntake(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(null, 'Payload must be a JSON object')
  }

  for (const field of REQUIRED_FIELDS) {
    if (!str(raw[field])) return fail(field, `${field} is required`)
  }

  const messageId = normalizeMessageId(raw.email_message_id)
  if (!messageId) return fail('email_message_id', 'email_message_id is required')
  if (messageId.length > MAX_MESSAGE_ID) {
    return fail('email_message_id', `email_message_id exceeds ${MAX_MESSAGE_ID} characters`)
  }

  // orders.state is a 2-letter code everywhere else (STATE_ORDERS, regionOf),
  // so an unusable value is rejected rather than stored and left to break a
  // dashboard aggregation later.
  const propertyState = str(raw.property_state)
  if (!/^[A-Za-z]{2}$/.test(propertyState)) {
    return fail('property_state', 'property_state must be a 2-letter state code')
  }

  const searchType = normalizeSearchType(raw.search_type)
  if (!searchType) {
    return fail('search_type', `search_type is not a Resolute product. Expected one of: ${SEARCH_CATALOG.join(', ')}`)
  }

  const priority = normalizeTurnaround(raw.turnaround)
  if (!priority) {
    return fail('turnaround', "turnaround must be 'Standard (48 hours)' or 'Rush (24 hours)'")
  }

  const contactEmail = str(raw.contact_email)
  if (!EMAIL_RE.test(contactEmail)) {
    return fail('contact_email', 'contact_email is not a valid email address')
  }

  // Client identity. An explicit code is looked up exactly; otherwise the
  // company name is the key, and it must survive normalisation. The sender and
  // contact addresses are never an alternative.
  const clientIdentifier = str(raw.client_identifier)
  if (!clientIdentifier && !normalizeCompanyName(raw.company)) {
    return fail('company', 'company is required: the client company name as written in the email')
  }

  return {
    ok: true,
    value: {
      messageId,
      clientIdentifier,
      searchType,
      priority,
      requestedTurnaround: str(raw.turnaround),   // the client's own wording, kept verbatim
      // Address parts. Composed into one line by buildOrderRow, exactly as the
      // Place Order form composes its own four fields.
      propertyAddress: str(raw.property_address),
      city: str(raw.city),
      propertyState: propertyState.toUpperCase(),
      zip: str(raw.zip),
      county: str(raw.county),
      parcelNumberAPN: str(raw.parcel_apn),
      // Contact — packed into one `from` line by buildOrderRow, again matching
      // the web form.
      contactFirstName: str(raw.contact_first_name),
      contactLastName: str(raw.contact_last_name),
      contactEmail,
      company: str(raw.company),
      buyer: str(raw.buyer),
      borrower: str(raw.borrower),
      seller: str(raw.seller),
      clientFileNumber: str(raw.client_file_number),
      orderNumber: str(raw.order_number),
      customerLink: str(raw.customer_link),
      specialInstructions: str(raw.special_instructions),
      emailSubject: str(raw.email_subject),
      sourceEmail: str(raw.source_email),
    },
  }
}
