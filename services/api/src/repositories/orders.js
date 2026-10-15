// Orders data access. Mirrors fetchOrders / fetchOrderById in the Supabase
// provider. Each function takes a pg client that is ALREADY inside a
// withUserClaims transaction, so RLS scopes every row to what the caller may
// see — the same policies the Supabase path relied on.
//
// The left join to clients is RLS-filtered too: clients is super-admin-only, so
// a restricted role gets a null name and toAppOrder falls back to the code —
// mirroring displayClient masking without any special-casing here.
import { toAppOrder } from '../mappers.js'

export async function listOrders(client) {
  const { rows } = await client.query(
    `select o.*, c.name as client_name
       from public.orders o
       left join public.clients c on c.code = o.client_code
      order by o.created desc`,
  )
  return rows.map(toAppOrder)
}

export async function getOrder(client, id) {
  const { rows } = await client.query(
    `select o.*, c.name as client_name
       from public.orders o
       left join public.clients c on c.code = o.client_code
      where o.id = $1
      limit 1`,
    [id],
  )
  return rows[0] ? toAppOrder(rows[0]) : null
}
