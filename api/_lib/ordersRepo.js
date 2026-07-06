// Server-side "repository" for the orders table — the serverless equivalent of
// the app's OrderContext/backend mappers. Mirrors the columns in
// supabase/schema.sql (status enum, assigned_to role, workflow JSONB).
import { supabaseAdmin } from './supabaseAdmin.js'

// Next RTS-#### id, continuing the existing numbering.
async function nextOrderId() {
  let max = 10048
  const { data } = await supabaseAdmin.from('orders').select('id').ilike('id', 'RTS-%')
  for (const r of data || []) {
    const n = parseInt(String(r.id).replace(/\D/g, ''), 10)
    if (!Number.isNaN(n) && n > max) max = n
  }
  return `RTS-${max + 1}`
}

// Create a draft order from extracted email fields. New orders are HELD with
// Admin for the quote/price discussion (workflow.quote) — production sees them
// only after the client accepts the price and Admin sends the confirmation.
export async function createInboundOrder(fields, meta = {}) {
  const id = await nextOrderId()
  const row = {
    id,
    client_code: meta.clientCode ?? null,     // matched sender, or null for Screener to link on review
    type: fields.orderType || 'Full Search',
    status: 'received',                       // draft / PENDING_REVIEW equivalent
    priority: 'normal',
    assigned_to: 'admin',
    progress: 5,
    created: new Date().toISOString().slice(0, 10),
    completed_dates: {},
    completed_by: {},
    workflow: {
      quote: { stage: 'pending', amount: null, thread: [] },
      intake: {
        source: 'email',
        propertyAddress: fields.propertyAddress ?? null,
        parcelNumberAPN: fields.parcelNumberAPN ?? null,
        borrowerName: fields.borrowerName ?? null,
        orderType: fields.orderType ?? null,
        clientReference: fields.clientReference ?? null,
        requestedTurnaround: fields.requestedTurnaround ?? null,
        specialInstructions: fields.notes ?? null,
        from: meta.from ?? null,
        subject: meta.subject ?? null,
        messageId: meta.messageId ?? null,
        receivedAt: new Date().toISOString(),
      },
    },
  }
  const { data, error } = await supabaseAdmin.from('orders').insert(row).select().single()
  if (error) throw new Error(`orders insert failed: ${error.message}`)
  return data
}
