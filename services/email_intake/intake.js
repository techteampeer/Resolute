// Email-intake core. Pure and dependency-injected — every side effect arrives
// through `deps`, so this runs in a unit test with no Supabase, no network and
// no env, and unchanged on Lambda after the AWS move.
//
//   validate → deduplicate → resolve client → build the row → insert
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

// Compose the special-instructions text Admin and the Screener actually read.
// order_number and customer_link have no field on any portal screen, so they
// are appended here rather than silently dropped — surfacing them in a rendered
// field is what keeps this feature free of frontend changes.
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
export function buildOrderRow(value, client, id, today = todayISO()) {
  return {
    id,
    client_code: client.code,
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
        company: value.company || client.name || null,
        specialInstructions: instructionsFor(value),
        requestedTurnaround: value.requestedTurnaround,
        // Kept structurally as well as in the instructions above, so a future
        // screen can render them without re-parsing prose.
        orderNumber: value.orderNumber,
        customerLink: value.customerLink,
        // The envelope sender, for provenance only. Never used to establish
        // client identity — see resolveClient below.
        sourceEmail: value.sourceEmail,
        // Idempotency key. The partial unique index on
        // workflow->'intake'->>'messageId' makes a replayed POST a database
        // conflict rather than a second order.
        messageId: value.messageId,
      },
    },
  }
}

// deps: { findByMessageId, resolveClient, nextOrderId, insertOrder, today? }
// Returns { ok: true, status: 'created' | 'duplicate', order }
//       | { ok: false, code, error, field? }
export async function processIntake(payload, deps) {
  const { findByMessageId, resolveClient, nextOrderId, insertOrder, today = todayISO } = deps

  const parsed = validateIntake(payload)
  if (!parsed.ok) {
    return { ok: false, code: 'invalid_payload', error: parsed.error, field: parsed.field }
  }
  const value = parsed.value

  // 1. Idempotency, before anything with a side effect. Apps Script and the
  //    network both retry; the same email must only ever become one order.
  const seen = await findByMessageId(value.messageId)
  if (seen) return { ok: true, status: 'duplicate', order: seen }

  // 2. Client identity. `orders.client_code` is a foreign key to clients(code),
  //    so an unresolvable identifier is rejected here rather than becoming a
  //    constraint violation — or worse, an order attributed to nobody. The
  //    caller must send a real clients.code: the company name and the sender
  //    address are recorded but never consulted for identity.
  const client = await resolveClient(value.clientIdentifier)
  if (!client) {
    return {
      ok: false, code: 'unknown_client', field: 'client_identifier',
      error: `No client matches client_identifier "${value.clientIdentifier}"`,
    }
  }

  const id = await nextOrderId()
  if (!id) return { ok: false, code: 'order_id_unavailable', error: 'Could not allocate an order id' }

  const row = buildOrderRow(value, client, id, today())
  try {
    const created = await insertOrder(row)
    return { ok: true, status: 'created', order: created || row }
  } catch (err) {
    // Two identical POSTs can both pass the pre-check above. The unique index
    // lets exactly one insert win; the loser reports the winner's order rather
    // than an error, so a retrying caller sees the same result either way.
    if (isDuplicateKey(err)) {
      const winner = await findByMessageId(value.messageId)
      if (winner) return { ok: true, status: 'duplicate', order: winner }
    }
    throw err
  }
}
