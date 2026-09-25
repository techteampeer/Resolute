// Email-intake core. Pure and dependency-injected — every side effect arrives
// through `deps`, so this runs in a unit test with no Supabase, no network and
// no env, and unchanged on Lambda after the AWS move.
//
//   validate → deduplicate → build the row → [ resolve/create client + insert ]
//                                               one database transaction
//
// The row it builds is a NORMAL Resolute order: the same columns and the same
// initial state as an order placed through the Client Portal, differing only in
// workflow.intake.source ('email' instead of 'web'). There is deliberately no
// email-only lifecycle — the order parks with Admin exactly like any other and
// the existing orders_log_created trigger writes the audit event and raises the
// 'order.new' notification off the insert itself.
import { validateIntake } from './schema.js'

const todayISO = () => new Date().toISOString().slice(0, 10)

// Postgres unique_violation. supabase-js surfaces it as error.code; fall back
// to the message so a transport that drops the code still dedupes correctly.
const isDuplicateKey = (err) =>
  err?.code === '23505' || /duplicate key value violates unique constraint/i.test(err?.message || '')

// How the order's client was established. The database records it — with the
// code and a clientCreated flag — at workflow.intake.clientMatch / clientCode /
// clientCreated: internal metadata, shown only on Admin's order view, never
// written into anything a client or restricted role reads.
//   code    an explicit client_identifier, looked up exactly
//   name    the email's company name matched exactly one existing client
//   created no client matched, so intake created one
export const CLIENT_MATCH = ['code', 'name', 'created']

// Compose the special-instructions text Admin and the Screener actually read —
// client content only. order_number and customer_link have no field on any
// portal screen, so the client's own references are appended here rather than
// silently dropped. Internal intake information never goes in here.
function instructionsFor(value) {
  const refs = [
    value.orderNumber ? `Client order number: ${value.orderNumber}` : null,
    value.customerLink ? `Customer link: ${value.customerLink}` : null,
  ].filter(Boolean)
  const lines = [value.specialInstructions, refs.length ? refs.join('\n') : null].filter(Boolean)
  return lines.length ? lines.join('\n\n') : null
}

// Map the validated payload onto the exact column set src/lib/backend.js
// insertOrder() writes, with the defaults src/context/OrderContext.jsx
// createOrder() applies. Exported so tests can assert the shape directly.
//
// `id` and `client_code` are left null on purpose: intake_create_order fills
// them — and the intake client metadata — inside the transaction that resolves
// the client, because only the database knows them at that point.
export function buildOrderRow(value, today = todayISO()) {
  return {
    id: null,
    client_code: null,
    state: value.propertyState,
    county: value.county,
    type: value.searchType,
    // Same initial state as a website order: parked with Admin, unconfirmed,
    // for acknowledgement and pricing before it enters production.
    status: 'received',
    priority: value.priority,       // from turnaround: Standard → normal, Rush → rush
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
        // 'email' is a source the portal already understands — FulfillmentScreen
        // renders the "via email" marker and the From/Subject block for it.
        source: 'email',
        // One line from the four address parts, composed exactly as the Place
        // Order form composes [address, city, state, zip].
        propertyAddress: [value.propertyAddress, value.city, value.propertyState, value.zip]
          .filter(Boolean).join(', '),
        parcelNumberAPN: value.parcelNumberAPN,
        borrowerName: value.borrower,
        buyer: value.buyer,
        seller: value.seller,
        orderType: value.searchType,
        // "First Last <email>", the same shape the web form writes.
        from: `${value.contactFirstName} ${value.contactLastName} <${value.contactEmail}>`,
        subject: value.emailSubject,
        // The company as the email wrote it. With an explicit code and no
        // company, the database falls back to the client's own name.
        company: value.company,
        specialInstructions: instructionsFor(value),
        requestedTurnaround: value.requestedTurnaround,
        // Kept structurally as well as in the instructions above, so a future
        // screen can render them without re-parsing prose.
        orderNumber: value.orderNumber,
        customerLink: value.customerLink,
        // The envelope sender, for provenance only. Never used to establish
        // client identity — see processIntake below.
        sourceEmail: value.sourceEmail,
        // Idempotency key. The partial unique index on
        // workflow->'intake'->>'messageId' makes a replayed POST a database
        // conflict rather than a second order.
        messageId: value.messageId,
      },
    },
  }
}

// deps: { findByMessageId, createIntakeOrder, today? }
// Returns { ok: true, status: 'created' | 'duplicate', order, clientMatch?, clientCode? }
//       | { ok: false, code, error, field? }
export async function processIntake(payload, deps) {
  const { findByMessageId, createIntakeOrder, today = todayISO } = deps

  const parsed = validateIntake(payload)
  if (!parsed.ok) {
    return { ok: false, code: 'invalid_payload', error: parsed.error, field: parsed.field }
  }
  const value = parsed.value

  // 1. Idempotency, before anything with a side effect — creating a client
  //    included. Apps Script and the network both retry; the same email must
  //    only ever become one order, and never a second client.
  const seen = await findByMessageId(value.messageId)
  if (seen) return { ok: true, status: 'duplicate', order: seen }

  // 2. Client + order in ONE database transaction (intake_create_order): the
  //    client is matched — or created — and the order inserted together, so a
  //    failed insert can never leave a new client behind. An explicit
  //    client_identifier is an exact code lookup with no fallback to the name;
  //    otherwise the company name is the only match key. The contact name and
  //    email only populate a NEW client's record — nothing matches on an address.
  let r
  try {
    r = await createIntakeOrder({
      row: buildOrderRow(value, today()),
      clientIdentifier: value.clientIdentifier,
      company: value.clientIdentifier ? null : value.company,
      contact: `${value.contactFirstName} ${value.contactLastName}`,
      email: value.contactEmail,
    })
  } catch (err) {
    // Two identical POSTs can both pass the pre-check above. The unique index
    // lets exactly one insert win — and the loser's whole transaction, any
    // client it created included, rolls back. It reports the winner's order
    // rather than an error, so a retrying caller sees the same result either way.
    if (isDuplicateKey(err)) {
      const winner = await findByMessageId(value.messageId)
      if (winner) return { ok: true, status: 'duplicate', order: winner }
    }
    throw err
  }

  if (r.status === 'unknown_client') {
    // orders.client_code is a foreign key to clients(code); nothing was written.
    return {
      ok: false, code: 'unknown_client', field: 'client_identifier',
      error: `No client matches client_identifier "${value.clientIdentifier}"`,
    }
  }
  if (r.status === 'ambiguous') {
    return {
      ok: false, code: 'ambiguous_client', field: 'company',
      error: `company "${value.company}" matches ${r.codes.length} existing clients (${r.codes.join(', ')}). ` +
        'Merge or rename the duplicate client records, then re-send.',
    }
  }
  return { ok: true, status: 'created', order: r.order, clientMatch: r.clientMatch, clientCode: r.clientCode }
}
