// Validation + normalisation for the email-intake payload.
//
// The payload arrives already extracted (Google Apps Script → Gemini), so this
// module's whole job is to decide whether it is a complete, actionable order
// and to reshape it into the SAME order row the Client Portal produces. It is
// pure and dependency-free: no Supabase, no network, no env.
//
// Kept deliberately strict. A rejected message is safe (Apps Script can retry
// after the sender clarifies); a half-guessed order is not — it would enter
// production carrying invented data.
import { PRODUCTS, PRODUCT_PRICE } from '../../src/data/products.js'

// The portal's real search catalog — the only values `orders.type` may take.
// Derived from the same single source of truth the Place Order form renders
// (PRODUCTS) plus the legacy short names carried by existing orders, so the
// catalog can never drift from what the portal actually sells.
export const SEARCH_CATALOG = [...new Set([
  ...PRODUCTS.map(p => p.name),
  ...Object.keys(PRODUCT_PRICE),
])]

// Fields the caller may send. Anything else is ignored rather than rejected, so
// a future Apps Script/Gemini revision adding a field cannot break intake.
export const INTAKE_KEYS = [
  'email_message_id', 'client_identifier', 'search_type', 'property_address',
  'county', 'state', 'parcel_apn', 'parties', 'instructions', 'source_email',
  'subject', 'client_file_no', 'priority', 'received_at',
]

// Required for an order to be actionable. `county` is in the list because the
// Place Order form requires it too and several dashboards aggregate on it.
const REQUIRED = ['email_message_id', 'client_identifier', 'search_type', 'property_address', 'county']

// RFC 5322 caps a header line at 998 octets; anything longer is not a Message-ID.
const MAX_MESSAGE_ID = 998

const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const fail = (field, error) => ({ ok: false, field, error })

// A Message-ID is written `<local@domain>` in the header but handed around bare
// just as often. Strip the angle brackets so the two spellings dedupe to one
// key. NOT lower-cased: the local part is case-sensitive per RFC 5322, and
// folding it could collapse two genuinely different messages into one order.
export const normalizeMessageId = (raw) => {
  const s = str(raw)
  if (!s) return null
  return s.replace(/^<+/, '').replace(/>+$/, '').trim() || null
}

// Roles we can map onto the three party fields the portal already renders
// (workflow.intake.buyer / borrowerName / seller — see AdminDashboard's intake
// panel). Anything else keeps its name but not a field.
export const PARTY_FIELD = {
  buyer: 'buyer', purchaser: 'buyer', grantee: 'buyer',
  seller: 'seller', grantor: 'seller',
  borrower: 'borrowerName', owner: 'borrowerName', vesting: 'borrowerName',
}

// Accepts ['Jane Doe'] or [{ role: 'buyer', name: 'Jane Doe' }] — Gemini may
// return either. Always returns [{ role, name }] with role possibly null.
export function normalizeParties(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const p of raw) {
    if (typeof p === 'string') {
      const name = str(p)
      if (name) out.push({ role: null, name })
      continue
    }
    if (p && typeof p === 'object') {
      const name = str(p.name) || str(p.full_name) || str(p.party_name)
      if (!name) continue
      const role = (str(p.role) || str(p.type) || '').toLowerCase() || null
      out.push({ role, name })
    }
  }
  return out
}

// Validate + normalise. Returns { ok: true, value } or { ok: false, field, error }.
// `value` uses the app's own camelCase intake vocabulary so the caller can hand
// it straight to buildOrderRow.
export function validateIntake(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return fail(null, 'Payload must be a JSON object')
  }

  for (const key of REQUIRED) {
    if (!str(raw[key])) return fail(key, `${key} is required`)
  }

  const messageId = normalizeMessageId(raw.email_message_id)
  if (!messageId) return fail('email_message_id', 'email_message_id is required')
  if (messageId.length > MAX_MESSAGE_ID) {
    return fail('email_message_id', `email_message_id exceeds ${MAX_MESSAGE_ID} characters`)
  }

  // Off-catalog products are rejected, never defaulted. The old ingest's rule
  // — "never auto-create on low confidence" — applies just as much when the
  // uncertainty is ours: a guessed search type is a mispriced, mis-scoped order.
  const searchType = str(raw.search_type)
  if (!SEARCH_CATALOG.includes(searchType)) {
    return fail('search_type', `search_type must be one of: ${SEARCH_CATALOG.join(', ')}`)
  }

  const priority = str(raw.priority)?.toLowerCase() || 'normal'
  if (!['normal', 'rush'].includes(priority)) {
    return fail('priority', "priority must be 'normal' or 'rush'")
  }

  // orders.state is a 2-letter code everywhere else (STATE_ORDERS, regionOf).
  // The email payload has no state field, and the Place Order form defaults to
  // '' when unknown, so match that rather than inventing one from the address.
  const rawState = str(raw.state)
  if (rawState && !/^[A-Za-z]{2}$/.test(rawState)) {
    return fail('state', 'state must be a 2-letter code when supplied')
  }

  const parties = normalizeParties(raw.parties)

  return {
    ok: true,
    value: {
      messageId,
      clientIdentifier: str(raw.client_identifier),
      searchType,
      propertyAddress: str(raw.property_address),
      county: str(raw.county),
      state: rawState ? rawState.toUpperCase() : '',
      parcelNumberAPN: str(raw.parcel_apn),
      parties,
      instructions: str(raw.instructions),
      sourceEmail: str(raw.source_email),
      subject: str(raw.subject),
      clientFileNo: str(raw.client_file_no),
      priority,
      receivedAt: str(raw.received_at),
    },
  }
}
