// Core pipeline for one message. All side effects are injected via `deps`, so
// this is fully unit-testable with mocks (no IMAP / Supabase / LLM needed).
//
// Decision (step 5/6): create the order ONLY when the client matched AND the
// service_type mapped AND confidence >= threshold AND the model didn't flag
// needs_review. Anything else goes to the review queue — never auto-create on
// low confidence. Every message is recorded in the idempotency ledger.
import { SERVICE_CATALOG } from './schema.js'

const noop = () => {}

export async function processMessage(msg, deps) {
  const {
    provider, matchClient, isProcessed, markProcessed, createOrder,
    uploadPdfs, attachToOrder, enqueueReview, notify = noop,
    log = noop, confidenceThreshold = 0.8, catalog = SERVICE_CATALOG,
  } = deps

  const { messageId, sender, subject, text = '', attachments = [] } = msg
  const pdfs = attachments.filter(a => /pdf$/i.test(a.filename || '') || /pdf/i.test(a.mimeType || ''))

  // 7. Idempotency — skip anything already handled.
  if (messageId && (await isProcessed(messageId))) {
    log({ messageId, action: 'skipped', reason: 'already processed' })
    return { action: 'skipped', reason: 'duplicate' }
  }

  // 3. Sender → Client.
  const client = await matchClient(sender)

  // 4. LLM extraction (text + PDFs + catalog).
  let parsed, extractError = null
  try {
    parsed = await provider.extract_order(text, pdfs, catalog)
  } catch (err) {
    extractError = err?.message || String(err)
    parsed = {
      service_type: null, property_address: null, parcel_or_apn: null, client_reference: null,
      requested_turnaround: null, notes: null, confidence: 0, needs_review: true,
      review_reason: `extraction failed: ${extractError}`,
    }
  }

  // 5/6. Confidence + match gating.
  const reasons = []
  if (!client) reasons.push('sender not matched to a client')
  if (!parsed.service_type) reasons.push('service_type not mapped to catalog')
  if (parsed.needs_review) reasons.push(parsed.review_reason || 'model flagged for review')
  if (parsed.confidence < confidenceThreshold) reasons.push(`confidence ${parsed.confidence} < ${confidenceThreshold}`)

  if (reasons.length === 0) {
    // Create the order via the existing order-creation code, then attach PDFs.
    const order = await createOrder(
      {
        orderType: parsed.service_type,
        propertyAddress: parsed.property_address,
        parcelNumberAPN: parsed.parcel_or_apn,
        clientReference: parsed.client_reference,
        requestedTurnaround: parsed.requested_turnaround,
        notes: parsed.notes,
      },
      { from: sender, subject, messageId, clientCode: client.code },
    )
    if (pdfs.length && uploadPdfs && attachToOrder) {
      const refs = await uploadPdfs(order.id, pdfs)
      await attachToOrder(order.id, refs)
    }
    await markProcessed({ messageId, sender, subject, status: 'created', orderId: order.id })
    log({ messageId, action: 'created', orderId: order.id, client: client.code })
    return { action: 'created', orderId: order.id, clientCode: client.code, parsed }
  }

  // Otherwise queue for human review (with attachments preserved).
  const reviewReason = reasons.join('; ')
  let refs = []
  if (pdfs.length && uploadPdfs) {
    try { refs = await uploadPdfs(messageId || subject || 'unmatched', pdfs) }
    catch (e) { log({ messageId, action: 'warn', reason: `attachment upload failed: ${e.message}` }) }
  }
  // Write the idempotency-ledger row FIRST: email_review_queue.message_id has a
  // foreign key to email_ingest_log.message_id, so the log row must exist before
  // the review row can reference it.
  await markProcessed({ messageId, sender, subject, status: 'queued', reviewReason })
  await enqueueReview({
    messageId, sender, subject, clientCode: client?.code || null,
    parsed, attachments: refs, reviewReason,
  })
  notify({ messageId, sender, subject, reviewReason })
  log({ messageId, action: 'queued', reason: reviewReason })
  return { action: 'queued', reason: reviewReason, parsed }
}
