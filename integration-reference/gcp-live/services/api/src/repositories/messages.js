// Portal messages data access (support_messages; gcp/02_post_migrate.sql
// section 11). Each function takes a pg client ALREADY inside a withUserClaims
// transaction: reads are RLS-scoped (a client never sees an internal note or
// another client's thread), and an insert names only the columns a sender
// chooses -- support_messages_guard sets the sender, author, author id, client
// code and time from the caller's own profile and the order, and the existing
// RLS insert policies decide who may write what.

// A client's person is shown to production staff as "Client" (they see client
// codes, never client people), mirroring displayClient in the portal.
const COLUMNS = `m.id::text as id, m.client_code, m.order_id, m.sender, m.visibility, m.body,
       case when m.sender = 'client' and me.staff and not me.admin then null else m.author end as author,
       coalesce(m.author_id = auth.uid(), false) as mine,
       to_char(m.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`
const ME = 'me as (select public.is_admin() as admin, public.is_staff() as staff)'

// The newest `limit` messages the caller may read (of one order's thread, or
// all), returned oldest first.
export async function listMessages(client, { orderId = null, limit = 500 } = {}) {
  const { rows } = await client.query(
    `with ${ME}
     select * from (select ${COLUMNS} from public.support_messages m, me
                     where ($1::text is null or m.order_id = $1)
                     order by m.created_at desc, m.id desc
                     limit $2) x
      order by x.created_at, x.id`,
    [orderId, limit],
  )
  return rows
}

// -> { row, duplicate }. A request id already used by this caller returns the
// message it stored (a retried send adds nothing).
export async function insertMessage(client, { orderId, clientCode, text, visibility, requestId }) {
  const { rows } = await client.query(
    `with ${ME},
     ins as (insert into public.support_messages (order_id, client_code, visibility, body, request_id)
             values ($1, $2, $3, $4, $5::uuid)
             on conflict (author_id, request_id) where request_id is not null do nothing
             returning *)
     select ${COLUMNS} from ins m, me`,
    [orderId, clientCode, visibility, text, requestId],
  )
  if (rows[0]) return { row: rows[0], duplicate: false }
  const again = await client.query(
    `with ${ME} select ${COLUMNS} from public.support_messages m, me
      where m.author_id = auth.uid() and m.request_id = $1::uuid`,
    [requestId],
  )
  return { row: again.rows[0] || null, duplicate: true }
}

// May the caller read this order's conversation? A client its own orders' (RLS
// on orders already hid the rest), Admin every order's, a production user only
// their own work's (order_is_my_work) -- the same rule the read policy applies.
export async function threadVisible(client, orderId) {
  const { rows } = await client.query(
    'select public.is_admin() or public.my_client_code() is not null or public.order_is_my_work($1) as ok', [orderId])
  return rows[0].ok === true
}
