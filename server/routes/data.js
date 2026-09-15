import { Router } from 'express'
import { withUser, queryAs, oneAs } from '../lib/db.js'
import { requireUser } from '../lib/auth.js'

const r = Router()
r.use(requireUser)

/**
 * The portal's data API.
 *
 * Every handler runs its queries through withUser(req.user.profile_id), so the
 * RLS policies decide what each caller sees and may change — the same boundary
 * PostgREST enforced before. Role checks here are a convenience for clearer
 * error codes, never the access control itself.
 */

// An RLS-filtered UPDATE is not an error in Postgres either: it matches zero
// rows and succeeds. So "did anything change?" is answered by rowCount, exactly
// as the Supabase version answered it by asking for the rows back. Without this
// a refused write reads as a successful one — the bug class that lost typed work.
const refusalText = (msg, subject) =>
  /row-level security|permission denied|insufficient privilege/i.test(msg || '')
    ? `the database refused the change (${subject})`
    : (msg || 'not saved')

const refused = (subject) => `the database refused the change (${subject})`

// Wrap a handler so a thrown error becomes a 500 with a logged cause rather than
// an unhandled rejection that hangs the request.
const h = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error(`[api] ${req.method} ${req.path}`, err)
  if (!res.headersSent) res.status(500).json({ error: 'Server error' })
})

// ── Orders ──────────────────────────────────────────────────────────────────
// The nested clients(name) of the PostgREST query becomes a left join. RLS
// applies to the joined table too, so a non-super-admin sees no clients row and
// gets a null name — which is exactly the masking the old query produced, and
// what toAppOrder falls back on (client_code).
r.get('/orders', h(async (req, res) => {
  const rows = await queryAs(req.user.profile_id,
    `select o.*, case when c.code is null then null
                      else json_build_object('name', c.name) end as clients
       from public.orders o
       left join public.clients c on c.code = o.client_code
      order by o.created desc nulls last`)
  res.json(rows)
}))

r.patch('/orders/:id', h(async (req, res) => {
  const patch = req.body || {}
  const keys = Object.keys(patch)
  if (!keys.length) return res.json({ ok: true })
  // Column names come from a fixed allow-list, never from the request: a column
  // name cannot be a bind parameter, so anything else would be concatenated in.
  const bad = keys.filter((k) => !ORDER_COLUMNS.has(k))
  if (bad.length) return res.status(400).json({ ok: false, error: `unknown field(s): ${bad.join(', ')}` })

  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(', ')
  try {
    const out = await withUser(req.user.profile_id, (c) =>
      c.query(`update public.orders set ${sets} where id = $1 returning id`,
        [req.params.id, ...keys.map((k) => patch[k])]))
    if (!out.rowCount) return res.json({ ok: false, error: refused('you may no longer own this order') })
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: refusalText(err.message, 'you may no longer own this order') })
  }
}))

r.post('/orders', h(async (req, res) => {
  const row = req.body || {}
  const keys = Object.keys(row).filter((k) => ORDER_COLUMNS.has(k) || k === 'id')
  const cols = keys.join(', ')
  const vals = keys.map((_, i) => `$${i + 1}`).join(', ')
  try {
    await withUser(req.user.profile_id, (c) =>
      c.query(`insert into public.orders (${cols}) values (${vals})`, keys.map((k) => row[k])))
    res.status(201).json({ ok: true })
  } catch (err) {
    console.error('[insertOrder]', err.message)
    res.status(err.code === '42501' ? 403 : 400).json({ error: err.message })
  }
}))

const ORDER_COLUMNS = new Set([
  'client_code', 'state', 'county', 'type', 'status', 'priority', 'payment',
  'clarification', 'client_file_no', 'assigned_to', 'workflow', 'created',
  'eta', 'notes', 'updated_at',
])

// ── Support messages ────────────────────────────────────────────────────────
r.get('/support-messages', h(async (req, res) => {
  res.json(await queryAs(req.user.profile_id,
    'select * from public.support_messages order by created_at asc'))
}))

r.post('/support-messages', h(async (req, res) => {
  const { clientCode, sender, author, body, orderId = null, attachment = null, visibility = 'client' } = req.body || {}
  try {
    await withUser(req.user.profile_id, (c) =>
      c.query(`insert into public.support_messages
                 (client_code, sender, author, body, order_id, attachment, visibility)
               values ($1,$2,$3,$4,$5,$6,$7)`,
        [clientCode, sender, author || null, body, orderId, attachment, visibility]))
    res.status(201).json({ ok: true })
  } catch (err) {
    // support_admin_reply / support_staff_note decide this, not the UI.
    console.error('[insertSupportMessage]', err.message)
    res.status(err.code === '42501' ? 403 : 400).json({ error: err.message })
  }
}))

// ── Client-only RPCs (SECURITY DEFINER; clients have no UPDATE on orders) ────
r.post('/orders/:id/payment', h(async (req, res) => {
  await queryAs(req.user.profile_id, 'select public.client_mark_payment($1, $2::jsonb)',
    [req.params.id, JSON.stringify(req.body?.payment ?? {})])
  res.json({ ok: true })
}))

r.post('/orders/:id/cancel', h(async (req, res) => {
  const rows = await queryAs(req.user.profile_id,
    'select public.client_cancel_order($1) as mode', [req.params.id])
  res.json({ mode: rows[0]?.mode ?? null })
}))

r.post('/orders/:id/clarification', h(async (req, res) => {
  await queryAs(req.user.profile_id, 'select public.client_respond_clarification($1)', [req.params.id])
  res.json({ ok: true })
}))

// ── Fulfillment ─────────────────────────────────────────────────────────────
r.get('/fulfillments/:orderId', h(async (req, res) => {
  const row = await oneAs(req.user.profile_id,
    'select data from public.fulfillments where order_id = $1', [req.params.orderId])
  res.json(row?.data ?? null)
}))

r.put('/fulfillments/:orderId', h(async (req, res) => {
  try {
    const out = await withUser(req.user.profile_id, (c) =>
      c.query(`insert into public.fulfillments (order_id, data, updated_at)
               values ($1, $2::jsonb, now())
               on conflict (order_id) do update set data = excluded.data, updated_at = now()
               returning order_id`,
        [req.params.orderId, JSON.stringify(req.body ?? {})]))
    if (!out.rowCount) return res.json({ ok: false, error: refused('this order may not be on your desk') })
    res.json({ ok: true })
  } catch (err) {
    // fulfillments_write_owner: the owning desk, or Admin. This is the path a
    // typer spends an hour on, so the refusal has to reach the screen.
    res.json({ ok: false, error: refusalText(err.message, 'this order may not be on your desk') })
  }
}))

// ── Notification preferences ────────────────────────────────────────────────
r.get('/notification-types', h(async (req, res) => {
  res.json(await queryAs(req.user.profile_id,
    `select key, label, description, default_roles, default_mode, sort_order
       from public.notification_types order by sort_order`))
}))

r.get('/notification-preferences', h(async (req, res) => {
  const { profileId } = req.query
  const rows = profileId
    ? await queryAs(req.user.profile_id,
        'select type_key, mode, updated_at from public.notification_preferences where profile_id = $1', [profileId])
    : await queryAs(req.user.profile_id,
        'select type_key, mode, updated_at from public.notification_preferences')
  res.json(rows)
}))

r.put('/notification-preferences', h(async (req, res) => {
  const { profileId, typeKey, mode } = req.body || {}
  if (!profileId) return res.json({ ok: false, error: 'your profile is not linked to a login yet' })
  try {
    const out = await withUser(req.user.profile_id, (c) =>
      c.query(`insert into public.notification_preferences (profile_id, type_key, mode, updated_at)
               values ($1,$2,$3, now())
               on conflict (profile_id, type_key) do update set mode = excluded.mode, updated_at = now()
               returning type_key`, [profileId, typeKey, mode]))
    if (!out.rowCount) return res.json({ ok: false, error: refused('you may only change your own preferences') })
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: refusalText(err.message, 'you may only change your own preferences') })
  }
}))

r.delete('/notification-preferences', h(async (req, res) => {
  const { profileId, typeKey } = req.body || {}
  if (!profileId) return res.json({ ok: false, error: 'your profile is not linked to a login yet' })
  try {
    // Back to the type's default: remove the row rather than store a copy of the
    // default, so a later change to the default follows the person.
    await queryAs(req.user.profile_id,
      'delete from public.notification_preferences where profile_id = $1 and type_key = $2',
      [profileId, typeKey])
    res.json({ ok: true })
  } catch (err) {
    res.json({ ok: false, error: refusalText(err.message, 'you may only change your own preferences') })
  }
}))

// ── Client registry ─────────────────────────────────────────────────────────
// Two sources, because the name is PII: 20260909120000 restricted public.clients
// to super admins and added client_directory with no name or contact details.
// Read both and merge by code — a super admin's `clients` read returns names,
// everyone else's returns nothing and the directory still supplies the codes.
r.get('/clients', h(async (req, res) => {
  const merged = await withUser(req.user.profile_id, async (c) => {
    const dir = await c.query('select code, payment_terms, activity, registered from public.client_directory order by code')
    const pii = await c.query(`select code, name, contact, email, phone, registered,
                                      activity, payment, payment_terms
                                 from public.clients order by code`)
    const byCode = new Map()
    for (const row of dir.rows) byCode.set(row.code, { ...row })
    for (const row of pii.rows) byCode.set(row.code, { ...(byCode.get(row.code) || {}), ...row })
    return [...byCode.values()].sort((a, b) => String(a.code).localeCompare(String(b.code)))
  })
  res.json(merged)
}))

r.get('/client-terms', h(async (req, res) => {
  // From the directory, not the table: clients_read is super-admin-only, so
  // reading payment_terms off `clients` returns nothing for a plain admin and
  // every client silently falls back to "per order".
  const rows = await queryAs(req.user.profile_id, 'select code, payment_terms from public.client_directory')
  res.json(Object.fromEntries(rows.map((x) => [x.code, x.payment_terms || 'per_order'])))
}))

r.patch('/clients/:code/terms', h(async (req, res) => {
  await queryAs(req.user.profile_id, 'update public.clients set payment_terms = $1 where code = $2',
    [req.body?.termKey, req.params.code])
  res.json({ ok: true })
}))

// ── Vendors & payout ledger ─────────────────────────────────────────────────
r.get('/vendors', h(async (req, res) => {
  res.json(await queryAs(req.user.profile_id, 'select * from public.vendors order by code'))
}))

r.patch('/vendors/:code/cycle', h(async (req, res) => {
  await queryAs(req.user.profile_id, 'update public.vendors set cycle = $1 where code = $2',
    [req.body?.cycle, req.params.code])
  res.json({ ok: true })
}))

r.put('/payouts/:orderId', h(async (req, res) => {
  const p = req.body || {}
  // vendor_payouts_guard_paid refuses status='paid' unless the caller holds
  // can_confirm_payments. That guard is the point; do not pre-empt it here.
  try {
    await queryAs(req.user.profile_id,
      `insert into public.vendor_payouts
         (order_id, vendor_code, amount, status, set_by, set_at, paid_by, paid_at, reference)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       on conflict (order_id) do update set
         vendor_code = excluded.vendor_code, amount = excluded.amount,
         status = excluded.status, set_by = excluded.set_by, set_at = excluded.set_at,
         paid_by = excluded.paid_by, paid_at = excluded.paid_at, reference = excluded.reference`,
      [req.params.orderId, p.vendor, p.amount, p.status, p.setBy || null, p.setAt || null,
       p.paidBy || null, p.paidAt || null, p.reference || null])
    res.json({ ok: true })
  } catch (err) {
    res.status(403).json({ ok: false, error: err.message })
  }
}))

// ── Subscriptions ───────────────────────────────────────────────────────────
r.get('/subscriptions', h(async (req, res) => {
  res.json(await queryAs(req.user.profile_id, 'select * from public.subscriptions order by id'))
}))

r.put('/subscriptions', h(async (req, res) => {
  const s = req.body || {}
  // subscriptions_guard_paid refuses last_paid_at/paid_by unless the caller
  // holds can_confirm_payments.
  try {
    await queryAs(req.user.profile_id,
      `insert into public.subscriptions (id, name, amount, cycle, last_paid_at, paid_by)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (id) do update set
         name = excluded.name, amount = excluded.amount, cycle = excluded.cycle,
         last_paid_at = excluded.last_paid_at, paid_by = excluded.paid_by`,
      [s.id, s.name, s.amount, s.cycle, s.lastPaidAt || null, s.paidBy || null])
    res.json({ ok: true })
  } catch (err) {
    res.status(403).json({ ok: false, error: err.message })
  }
}))

// ── Audit trail ─────────────────────────────────────────────────────────────
r.get('/activity', h(async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500)
  res.json(await queryAs(req.user.profile_id,
    'select * from public.order_events order by created_at desc limit $1', [limit]))
}))

r.post('/events', h(async (req, res) => {
  const { orderId = null, action, type = 'status', actor = null, actorEmail = null, audience = 'staff' } = req.body || {}
  await queryAs(req.user.profile_id,
    `insert into public.order_events (order_id, action, type, actor, actor_email, audience)
     values ($1,$2,$3,$4,$5,$6)`, [orderId, action, type, actor, actorEmail, audience])
  res.status(201).json({ ok: true })
}))

// ── Staff roster ────────────────────────────────────────────────────────────
r.get('/profiles', h(async (req, res) => {
  res.json(await queryAs(req.user.profile_id,
    `select id, name, email, role, super_admin, client_code, status, can_confirm_payments
       from public.profiles order by name`))
}))

r.get('/next-order-id', h(async (req, res) => {
  const rows = await queryAs(req.user.profile_id, 'select public.next_order_id() as id')
  res.json({ id: rows[0]?.id ?? null })
}))

export default r
