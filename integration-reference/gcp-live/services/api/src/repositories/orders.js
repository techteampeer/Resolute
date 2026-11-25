// Orders data access. Mirrors fetchOrders / fetchOrderById / saveOrder /
// insertOrder in the Supabase provider. Each function takes a pg client that is
// ALREADY inside a withUserClaims transaction, so RLS scopes every row to what
// the caller may see and the order triggers (handoff, payment confirmation,
// amounts, created-event) run exactly as they did under PostgREST.
//
// The left join to clients is RLS-filtered too: clients is super-admin-only, so
// a restricted role gets a null name and toAppOrder falls back to the code —
// mirroring displayClient masking without any special-casing here.
//
// A client's payment report (workflow.payment: reference, check scan) is
// billing data: production users read the order without it. Their whole-
// workflow saves leave it out, and the database keeps the stored one
// (guard_payment_writes, gcp/02_post_migrate.sql section 12).
//
// Dates come back as the strings PostgREST returned ('YYYY-MM-DD'), and
// updated_at as an exact UTC timestamp with microseconds: it is the optimistic-
// lock version the browser echoes back, so it must round-trip without loss.
import { toAppOrder } from '../mappers.js'

// The order columns as the app reads them, from row alias `a`.
const columns = (a) => `${a}.id, ${a}.client_code, ${a}.state, ${a}.county, ${a}.type, ${a}.status::text as status,
       ${a}.priority::text as priority, ${a}.payment, ${a}.clarification, ${a}.client_file_no,
       ${a}.assigned_to::text as assigned_to, ${a}.assigned_user_id, ${a}.screener, ${a}.examiner, ${a}.typer,
       ${a}.delivery, ${a}.progress, to_char(${a}.created, 'YYYY-MM-DD') as created,
       to_char(${a}.eta, 'YYYY-MM-DD') as eta, to_char(${a}.completed, 'YYYY-MM-DD') as completed,
       ${a}.completed_dates, ${a}.completed_by,
       case when public.is_staff() and not public.is_admin() then ${a}.workflow - 'payment' else ${a}.workflow end as workflow,
       to_char(${a}.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as updated_at,
       c.name as client_name`

export async function listOrders(client) {
  const { rows } = await client.query(
    `select ${columns('o')}
       from public.orders o
       left join public.clients c on c.code = o.client_code
      order by o.created desc, o.id desc`,
  )
  return rows.map(toAppOrder)
}

export async function getOrder(client, id) {
  const { rows } = await client.query(
    `select ${columns('o')}
       from public.orders o
       left join public.clients c on c.code = o.client_code
      where o.id = $1
      limit 1`,
    [id],
  )
  return rows[0] ? toAppOrder(rows[0]) : null
}

// A client code an order may be placed for: one the caller can see in the
// client directory (RLS: staff see every code, a client only their own).
export async function clientExists(client, code) {
  const { rows } = await client.query('select 1 from public.client_directory where code = $1', [code])
  return rows.length === 1
}

// Insert a NEW order in the initial Admin state. The id comes from the
// sequence in this same statement (next_order_id(), SECURITY DEFINER), so two
// simultaneous orders cannot collide and a refused insert leaves no row.
// Status, desk, ownership, stages, progress and dates are fixed here -- never
// taken from the request -- and workflow holds the sanitized intake only.
export async function insertOrder(client, f) {
  const { rows } = await client.query(
    `with ins as (
       insert into public.orders
         (id, client_code, state, county, type, status, priority, payment, clarification,
          assigned_to, assigned_user_id, screener, examiner, typer, delivery, progress,
          created, eta, completed, completed_dates, completed_by, workflow, client_file_no)
       values
         (public.next_order_id(), $1, $2, $3, $4, 'received', $5::public.order_priority, $6, null,
          'admin', null, null, null, null, null, 5,
          current_date, null, null, '{}'::jsonb, '{}'::jsonb, jsonb_build_object('intake', $7::jsonb), $8)
       returning *)
     select ${columns('ins')}
       from ins
       left join public.clients c on c.code = ins.client_code`,
    [f.clientCode, f.state, f.county, f.type, f.priority, f.payment, JSON.stringify(f.intake), f.clientFileNo],
  )
  return toAppOrder(rows[0])
}

// The optimistic-lock update: only the version the caller last saw. `set` maps
// column names (from orderRules UPDATE_COLUMNS, never from the request) to
// values, which are bound parameters. The row is read back from RETURNING -- a
// query on the table in the same statement would still see the old version.
// Returns the updated order, or null when no row matched (stale, hidden or
// refused by RLS -- the caller tells them apart with getOrder()).
export async function updateOrder(client, id, baseline, set) {
  const names = Object.keys(set)
  const sets = names.map((col, i) => `${col} = $${i + 3}`)
  const { rows } = await client.query(
    `with upd as (
       update public.orders set ${sets.join(', ')}
        where id = $1 and updated_at = $2::timestamptz
       returning *)
     select ${columns('upd')}
       from upd
       left join public.clients c on c.code = upd.client_code`,
    [id, baseline, ...names.map((n) => set[n])],
  )
  return rows[0] ? toAppOrder(rows[0]) : null
}

// After an update matched no row: is the order visible, and is it still at the
// version the caller saw? null = not visible (absent or hidden by RLS),
// false = it moved on (stale), true = unchanged, so RLS refused the write.
export async function versionMatches(client, id, baseline) {
  const { rows } = await client.query(
    'select updated_at = $2::timestamptz as same from public.orders where id = $1', [id, baseline])
  return rows[0] ? rows[0].same : null
}

// Of these ids, the ones that are ACTIVE production ('user') accounts.
export async function activeProductionIds(client, ids) {
  if (!ids.length) return []
  const { rows } = await client.query(
    `select id::text as id from public.profiles where id = any($1::uuid[]) and role = 'user' and status = 'active'`,
    [ids],
  )
  return rows.map((r) => r.id)
}

// The client's own cancel, through the existing SECURITY DEFINER function
// (clients have no UPDATE on orders): 'cancelled' or 'requested'.
export async function clientCancel(client, id) {
  const { rows } = await client.query('select public.client_cancel_order($1) as mode', [id])
  return rows[0].mode
}

export async function clientRespondClarification(client, id) {
  await client.query('select public.client_respond_clarification($1)', [id])
}
