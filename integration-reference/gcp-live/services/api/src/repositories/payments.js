// Client payments (gcp/02_post_migrate.sql section 12). Each function takes a
// pg client that is ALREADY inside a withUserClaims transaction. The database
// functions decide everything -- the caller's order, its state, the evidence,
// the billing owner's authority -- and write workflow.payment themselves; the
// trail and notifications come from the order trigger in the same transaction.

// The client's report ('marked'): -> the stored payment.
export async function reportPayment(client, orderId, r) {
  const { rows } = await client.query('select public.payment_report($1, $2, $3, $4::uuid) as payment',
    [orderId, r.method, r.reference, r.checkDocumentId])
  return rows[0].payment
}

// The billing owner's decision ('confirmed' | 'bounced') on the version reviewed.
export async function verifyPayment(client, orderId, v) {
  const { rows } = await client.query('select public.payment_verify($1, $2, $3::timestamptz, $4) as payment',
    [orderId, v.decision, v.baseline, v.reason])
  return rows[0].payment
}
