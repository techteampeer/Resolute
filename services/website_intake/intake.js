// Website-intake core. Pure and dependency-injected — the same shape as
// services/email_intake/intake.js, and deliberately a sibling of it rather than
// a change to it: the email/Vertex path keeps its own schema untouched.
//
//   validate → deduplicate → build the row → [ resolve/create client + insert ]
//                                               intake_create_order, one transaction
//
// The row is a NORMAL Resolute order — the same columns and the same initial
// state as every other order: status 'received', parked with Admin, awaiting
// approval. Only workflow.intake.source differs ('website'). Because it is not
// 'web' (the Client Portal), Admin's Confirm & price step applies to it exactly
// as it does to email orders.
import { validateWebsiteOrder } from './schema.js'

const todayISO = () => new Date().toISOString().slice(0, 10)

// Postgres unique_violation — same test as email intake: the code, or the
// message when a transport drops the code.
const isDuplicateKey = (err) =>
  err?.code === '23505' || /duplicate key value violates unique constraint/i.test(err?.message || '')

// The text Admin and the Screener read as special instructions — the
// customer's own words only. A custom search's description goes here because
// it IS the order; internal review notes never do.
function instructionsFor(value) {
  const parts = [
    value.specialInstructions,
    value.customSearch ? `Custom search requested: ${value.customSearch}` : null,
  ].filter(Boolean)
  return parts.length ? parts.join('\n\n') : null
}

// Map the validated payload onto the column set intake_create_order inserts,
// with the same defaults email intake and OrderContext.createOrder() use.
// `id` and `client_code` stay null: the database fills them in the transaction
// that resolves the client.
export function buildWebsiteOrderRow(value, today = todayISO()) {
  return {
    id: null,
    client_code: null,
    state: value.propertyState,
    county: value.county,
    type: value.type,
    status: 'received',
    priority: value.priority,
    payment: 'Check',               // createOrder's default; Admin sets the real terms
    clarification: null,
    client_file_no: value.clientFileNumber,
    assigned_to: 'admin',
    screener: null, examiner: null, typer: null, delivery: null,
    progress: 5,
    created: today,
    eta: null,                      // no ETA until Admin confirms
    completed: null,
    completed_dates: {},
    completed_by: {},
    workflow: {
      intake: {
        source: 'website',
        // The same intake keys Admin's order view already renders.
        propertyAddress: [value.propertyAddress, value.city, value.propertyState, value.zip]
          .filter(Boolean).join(', '),
        propertyType: value.propertyType,
        parcelNumberAPN: value.parcelApn,
        buyer: value.buyer,
        seller: value.seller,
        borrowerName: value.borrower,
        orderType: value.type,
        from: `${value.contactName} <${value.contactEmail}>`,
        company: value.company,
        contactName: value.contactName,
        contactFirstName: value.contactFirstName,
        contactLastName: value.contactLastName,
        contactEmail: value.contactEmail,
        specialInstructions: instructionsFor(value),
        requestedTurnaround: value.requestedPriority,
        // Everything the customer selected, verbatim, so nothing is lost to the
        // mapping above.
        website: {
          submissionId: value.submissionId,
          submittedAt: value.submittedAt,
          product: value.websiteProduct,
          productMapped: value.productMapped,
          customSearch: value.customSearch,
          searchType: value.searchType,
          parties: value.partiesText,
        },
        // Internal — Admin's order view only, never client-facing.
        reviewNotes: value.reviewNotes,
        // Idempotency key, shared with email intake's partial unique index on
        // workflow->'intake'->>'messageId'. The 'website:' prefix keeps it
        // disjoint from every Gmail id.
        messageId: value.messageId,
      },
    },
  }
}

// deps: { findByMessageId, createIntakeOrder, today? } — services/email_intake/store.js
// createDeps() provides both, unchanged.
// Returns { ok: true, status: 'created' | 'duplicate', order, clientMatch?, clientCode?, reviewNotes? }
//       | { ok: false, code, error, field? }
export async function processWebsiteIntake(payload, deps) {
  const { findByMessageId, createIntakeOrder, today = todayISO } = deps

  const parsed = validateWebsiteOrder(payload)
  if (!parsed.ok) {
    return { ok: false, code: 'invalid_payload', error: parsed.error, field: parsed.field }
  }
  const value = parsed.value

  // 1. Idempotency before any side effect: the Apps Script's retry re-sends the
  //    same submissionId, and it must only ever become one order.
  const seen = await findByMessageId(value.messageId)
  if (seen) return { ok: true, status: 'duplicate', order: seen }

  // 2. Client + order in ONE transaction, by the existing rules: the company
  //    name is the only match key (exact on the normalised name; several → no
  //    order; none → a new client). The contact name and email only populate a
  //    NEW client's record. Never a client code: public input does not choose
  //    a client.
  let r
  try {
    r = await createIntakeOrder({
      row: buildWebsiteOrderRow(value, today()),
      clientIdentifier: null,
      company: value.company,
      contact: value.contactName,
      email: value.contactEmail,
    })
  } catch (err) {
    // Two identical POSTs can both pass the pre-check; the unique index lets
    // one win and rolls the other back whole. Report the winner.
    if (isDuplicateKey(err)) {
      const winner = await findByMessageId(value.messageId)
      if (winner) return { ok: true, status: 'duplicate', order: winner }
    }
    throw err
  }

  if (r.status === 'ambiguous') {
    return {
      ok: false, code: 'ambiguous_client', field: 'businessName',
      error: `businessName "${value.company}" matches ${r.codes.length} existing clients (${r.codes.join(', ')}). ` +
        'Merge or rename the duplicate client records, then retry.',
    }
  }
  if (r.status !== 'created') {
    // unknown_client needs a client code, which this path never sends.
    throw new Error(`website_intake: unexpected order creation result "${r.status}"`)
  }
  return {
    ok: true, status: 'created', order: r.order,
    clientMatch: r.clientMatch, clientCode: r.clientCode, reviewNotes: value.reviewNotes,
  }
}
