// In-app notifications (gcp/02_post_migrate.sql section 11). Created only by
// the database's triggers; RLS shows the caller its own rows alone, and read
// state changes only through notifications_mark_read / _mark_all_read, which
// touch the caller's own rows -- another user's id is simply not matched.
const COLUMNS = `n.id::text as id, n.kind, n.order_id, n.target, n.title, n.body,
       to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
       to_char(n.read_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as read_at`

// -> { rows (newest first), unread (all of the caller's unread, not just these) }
export async function listNotifications(client, limit = 50) {
  const { rows } = await client.query(
    `select ${COLUMNS} from public.notifications n order by n.created_at desc, n.id desc limit $1`,
    [limit],
  )
  const count = await client.query('select count(*)::int as unread from public.notifications where read_at is null')
  return { rows, unread: count.rows[0].unread }
}

export async function markRead(client, ids) {
  const { rows } = await client.query('select public.notifications_mark_read($1::bigint[]) as n', [ids])
  return rows[0].n
}

export async function markAllRead(client) {
  const { rows } = await client.query('select public.notifications_mark_all_read() as n')
  return rows[0].n
}
