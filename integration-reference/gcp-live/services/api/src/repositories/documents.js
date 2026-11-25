// Order documents data access (gcp/02_post_migrate.sql section 10). Each
// function takes a pg client ALREADY inside a withUserClaims transaction.
// Writes go only through the SECURITY DEFINER document_* functions, which
// authorize from the caller's own profile and the order's stored state; reads
// are RLS-scoped (order_documents_read), so a hidden document and a missing one
// are the same empty answer.

const COLUMNS = `d.id::text as id, d.order_id, d.kind, d.filename, d.content_type, d.size_bytes, d.object_name,
       to_char(d.stored_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as stored_at`

export async function beginUpload(client, orderId, kind, filename, contentType) {
  const { rows } = await client.query(
    'select out_id::text as id, out_object_name as object_name from public.document_begin_upload($1, $2, $3, $4)',
    [orderId, kind, filename, contentType],
  )
  return { id: rows[0].id, objectName: rows[0].object_name }
}

export async function finishUpload(client, id, size, sha256, contentType) {
  const { rows } = await client.query(
    `select ${COLUMNS} from public.document_finish_upload($1, $2, $3, $4) d`,
    [id, size, sha256, contentType],
  )
  return rows[0]
}

export async function failUpload(client, id) {
  const { rows } = await client.query('select public.document_fail_upload($1) as object_name', [id])
  return rows[0].object_name
}

export async function listOrderDocuments(client, orderId) {
  const { rows } = await client.query(
    `select ${COLUMNS} from public.order_documents d where d.order_id = $1 order by d.stored_at, d.id`,
    [orderId],
  )
  return rows
}

export async function getDocument(client, id) {
  const { rows } = await client.query(`select ${COLUMNS} from public.order_documents d where d.id = $1`, [id])
  return rows[0] || null
}

export async function beginDelete(client, id) {
  const { rows } = await client.query('select public.document_begin_delete($1) as object_name', [id])
  return rows[0].object_name
}

export async function finishDelete(client, id) {
  await client.query('select public.document_finish_delete($1)', [id])
}

export async function abortDelete(client, id) {
  await client.query('select public.document_abort_delete($1)', [id])
}
