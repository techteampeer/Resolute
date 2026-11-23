// Order-document access control, server side (B3). MIRRORS src/lib/orderDocs.js
// (pure JS, no build step over here) and adds the server-side authorization the
// GCP tier needs: a client may view only what Delivery released (delivery-only
// release), enforced here, not just in the UI. The GCS storage + signing half is
// env-gated (deployed snapshot); this file is pure and unit-testable.

export function collectOrderDocs(order) {
  const w = order?.workflow || {}
  const out = []
  const push = (id, ref, label, group, defaultShare) => {
    if (!ref || !(ref.url || ref.path)) return // only real, openable docs
    out.push({ id, label, group, defaultShare, name: ref.name, type: ref.type, url: ref.url, path: ref.path })
  }
  ;(w.clientDocs || []).forEach((d) => push(`client:${d.id}`, d, 'Client upload', 'client', false))
  push('screener', w.screenerDoc, 'Screener search', 'stage', false)
  push('examiner', w.examinerDoc, 'Examiner research', 'stage', false)
  push('titleSearch', w.titleSearchDoc, 'Final search package', 'stage', true)
  push('commitment', w.commitmentDoc, 'Title commitment', 'stage', true)
  ;(w.supplementaryDocs || []).forEach((s) => push(`supp:${s.file?.id}`, s.file, 'Supplementary', 'stage', s.sendToCustomer !== false))
  ;(w.deliveryDocs || []).forEach((d) => push(`delivery:${d.id}`, d, 'Delivery', 'delivery', d.sendToCustomer !== false))
  return out
}

// Delivery's curation (workflow.docShare) overrides a doc's default visibility.
export function docIsShared(order, doc) {
  const share = order?.workflow?.docShare || {}
  return share[doc.id] !== undefined ? !!share[doc.id] : !!doc.defaultShare
}

// The documents a client may view/download — what Delivery chose to send across.
export const clientVisibleDocs = (order) => collectOrderDocs(order).filter((d) => docIsShared(order, d))

// Server-side authorization: staff see the whole paper trail; a client sees only
// the delivery-released subset. The one place the GCP routes decide visibility.
export const authorizedDocs = (order, { isStaff }) =>
  isStaff ? collectOrderDocs(order) : clientVisibleDocs(order)

// "No public bucket or blob: URLs persisted" (ADR 0003 B3). A stored doc ref must
// carry a storage PATH (the GCS object), never a transient blob:/data: URL or a
// public http(s) URL — on GCP the client is handed a short-lived SIGNED url only
// at open time, never a stored one. Pure guard for the (env-gated) upload path.
export function isPersistableRef(ref) {
  if (!ref || typeof ref !== 'object') return false
  if (typeof ref.path !== 'string' || !ref.path.trim()) return false
  if (ref.url != null) {
    if (typeof ref.url !== 'string') return false
    if (/^\s*(blob:|data:|https?:\/\/)/i.test(ref.url)) return false
  }
  return true
}
