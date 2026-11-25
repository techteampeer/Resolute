// Typer fulfillment drafts (public.fulfillments: one JSON document per order).
// Mirrors fetchFulfillment / saveFulfillment in the Supabase provider; runs
// inside withUserClaims, so fulfillments_read / fulfillments_write_owner apply.
export async function getFulfillment(client, orderId) {
  const { rows } = await client.query('select data from public.fulfillments where order_id = $1', [orderId])
  return rows[0] ? rows[0].data : null
}

export async function saveFulfillment(client, orderId, data) {
  const { rows } = await client.query(
    `insert into public.fulfillments (order_id, data, updated_at) values ($1, $2, now())
     on conflict (order_id) do update set data = excluded.data, updated_at = now()
     returning order_id`,
    [orderId, data],
  )
  return rows.length === 1
}
