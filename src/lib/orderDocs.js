// One consolidated view of every document attached to an order across all
// stages, so staff see the whole paper trail in one place and Delivery can
// curate exactly what the client receives.
//
// Documents are stamped onto order.workflow as the order moves through the
// pipeline: clientDocs[] (client uploads), screenerDoc, examinerDoc,
// titleSearchDoc (final search package) and commitmentDoc + supplementaryDocs[]
// (typer, copied forward at finalize), and deliveryDocs[] (delivery uploads).
// Each entry here carries a stable id, a human label, and whether it DEFAULTS
// to client-visible. Delivery's per-document decisions override those defaults
// (workflow.docShare), and the client sees whatever ends up shared.

export function collectOrderDocs(order) {
  const w = order?.workflow || {}
  const out = []
  const push = (id, ref, label, group, defaultShare) => {
    if (!ref || !(ref.url || ref.path)) return   // only real, openable docs
    out.push({ id, label, group, defaultShare, name: ref.name, type: ref.type, url: ref.url, path: ref.path })
  }
  ;(w.clientDocs || []).forEach(d => push(`client:${d.id}`, d, 'Client upload', 'client', false))
  push('screener', w.screenerDoc, 'Screener search', 'stage', false)
  push('examiner', w.examinerDoc, 'Examiner research', 'stage', false)
  push('titleSearch', w.titleSearchDoc, 'Final search package', 'stage', true)
  push('commitment', w.commitmentDoc, 'Title commitment', 'stage', true)
  ;(w.supplementaryDocs || []).forEach(s => push(`supp:${s.file?.id}`, s.file, 'Supplementary', 'stage', s.sendToCustomer !== false))
  ;(w.deliveryDocs || []).forEach(d => push(`delivery:${d.id}`, d, 'Delivery', 'delivery', d.sendToCustomer !== false))
  return out
}

// Delivery's curation (workflow.docShare) overrides a doc's default visibility.
export function docIsShared(order, doc) {
  const share = order?.workflow?.docShare || {}
  return share[doc.id] !== undefined ? !!share[doc.id] : !!doc.defaultShare
}

// The documents a client may view/download — what Delivery chose to send across.
export const clientVisibleDocs = (order) => collectOrderDocs(order).filter(d => docIsShared(order, d))
