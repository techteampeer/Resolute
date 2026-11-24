// Additional-fee data access (B1). Each function takes a pg client ALREADY inside
// a withUserClaims transaction, so RLS scopes every row and SECURITY DEFINER
// functions behave EXACTLY as on Supabase/PostgREST — the authorization is the
// database's, re-checked here only for a fast, clear HTTP status.
//
// Invariants (B1 spec §1): approval is consent-to-bill, never a payment (we touch
// only workflow.pendingCharges, never workflow.payment); the invoice counts an
// approved charge exactly once because the total is DERIVED (money.ts
// approvedChargesTotal), not accumulated, and a charge has one immutable
// transition; declining is non-blocking.
import { getOrder } from './orders.js'
import { buildPendingCharge, raiseEventAction } from '../charges.js'
import { HttpError } from '../errors.js'

// Raise — Admin or the owning production `user` (typer stage) adds a pending fee.
// Mirrors the Supabase path: append to workflow.pendingCharges + a durable,
// client-visible order_events line. Bills nothing until the client approves.
export async function raiseCharge(client, orderId, { label, amount, user }) {
  // Visibility under the SELECT policy (orders_read = is_staff() or owner) → a row
  // the caller cannot even see is 404. A plain SELECT, not FOR UPDATE: FOR UPDATE
  // additionally filters rows that fail the UPDATE policy, which would turn a
  // non-owner production user's raise into a 404 instead of the 403 it deserves.
  const vis = await client.query('select 1 from public.orders where id = $1', [orderId])
  if (!vis.rows.length) throw new HttpError(404, 'order not found')

  // The staff member's name for the staff-only "Raised by" line. The client view
  // always masks this to "Added by Resolute" (OrderCharges), so no name reaches a
  // client's screen; falls back if the self-profile read is empty.
  const who = await client.query(
    'select name, role from public.profiles where id = auth.uid() limit 1',
  )
  const raisedBy = who.rows[0]?.name || 'Resolute'
  const raisedByRole = who.rows[0]?.role || user.role
  const charge = buildPendingCharge({ label, amount, raisedBy, raisedByRole })

  // Atomic append under the UPDATE policy (the real guard): Admin writes via
  // orders_write_admin, a production user only via orders_update_assigned
  // (owner-scoped). The jsonb `||` concatenates onto the CURRENT committed array
  // under the UPDATE's own row lock, so two concurrent raises both land (no
  // read-modify-write lost update). A non-owner user matches 0 rows → 403.
  const upd = await client.query(
    `update public.orders
        set workflow = jsonb_set(coalesce(workflow, '{}'::jsonb), '{pendingCharges}',
              coalesce(workflow->'pendingCharges', '[]'::jsonb) || $2::jsonb, true)
      where id = $1`,
    [orderId, JSON.stringify([charge])],
  )
  if (upd.rowCount === 0) throw new HttpError(403, 'you cannot modify this order')

  // Durable activity line (order_events_insert = is_staff()). audience 'all' so
  // the owning client sees a fee awaiting approval; actor 'Resolute' never leaks
  // the staff name; actor_email excludes the raiser from any (here: none) mail.
  await client.query(
    `insert into public.order_events (order_id, action, type, actor, actor_email, audience)
     values ($1, $2, 'status', 'Resolute', $3, 'all')`,
    [orderId, raiseEventAction(orderId, charge.amount), user.email || null],
  )

  return getOrder(client, orderId)
}

// Resolve — the OWNING client approves or declines one pending charge, through
// gcp_resolve_order_charge (gcp/migrations/20261124000000, spec B1 §6). It runs
// the tested resolve_order_charge verbatim — scoped to my_client_code(), atomic
// single-statement UPDATE whose exists(...pending) guard + row lock make a second
// concurrent/duplicate resolve fail, plus the order_events audit row — and then
// enqueues charge.approved|declined for the admin tier EXPLICITLY. Calling
// resolve_order_charge alone relied on the Supabase notify_on_order_event
// classifier, which resolute_live does not have: there the decision was recorded
// but no admin was mailed. Both paths seed the outbox dedupe key with the audit
// event's id, so where the trigger also fires each admin still gets ONE row.
export async function resolveCharge(client, orderId, chargeId, decision) {
  // Ownership + pending precheck for precise statuses. For a client, orders_read
  // scopes to their own client_code, so an order they don't own returns no row
  // → 404 (never reveals it exists); staff are blocked at the route, not here.
  const own = await client.query(
    'select workflow from public.orders where id = $1 limit 1',
    [orderId],
  )
  if (!own.rows.length) throw new HttpError(404, 'order not found')
  const charges = Array.isArray(own.rows[0].workflow?.pendingCharges)
    ? own.rows[0].workflow.pendingCharges
    : []
  const target = charges.find((c) => c && c.id === chargeId)
  if (!target || (target.status || 'pending') !== 'pending') {
    throw new HttpError(409, 'charge is not pending') // unknown id or already resolved
  }

  try {
    await client.query('select public.gcp_resolve_order_charge($1, $2, $3)', [orderId, chargeId, decision])
  } catch (err) {
    const m = (err && err.message) || ''
    // 42501: not a client with a client code (the route admits clients only, so
    // this is the DB's own guard). 22023: decision outside approved|declined.
    if (err?.code === '42501') throw new HttpError(403, 'only the owning client can resolve a fee')
    if (err?.code === '22023' || /decision must be/i.test(m)) throw new HttpError(422, 'decision must be approved or declined')
    // Past the ownership precheck, the function's "no pending charge" means a
    // concurrent resolve committed first — the duplicate/replay case.
    if (/no pending charge|not found, not owned/i.test(m)) throw new HttpError(409, 'charge is not pending')
    throw err
  }

  return getOrder(client, orderId)
}
