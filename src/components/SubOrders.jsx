import React, { useState } from 'react'
import { ChevronRight, ChevronDown } from 'lucide-react'
import { lineItemsOf, lineSubId, stateName } from '../data/mockData'
import { ROLE_COLOR } from '../lib/ui'

// The sub-orders (line items) of a GROUPED bulk order. The parent order moves
// through the pipeline as one unit; each sub-order is an individually identified
// search (id = `${orderId}-${n}`). Clicking a sub-order expands its full detail.
// Shared by the client, admin and production order views so the three stay in
// lockstep. Renders nothing for a plain (single-search) order.
const Field = ({ k, v }) => (v == null || v === '') ? null : (
  <div className="flex gap-2">
    <span style={{ color: '#9AA8BF', minWidth: 104 }}>{k}</span>
    <span style={{ color: '#12284C' }}>{v}</span>
  </div>
)

export default function SubOrders({ order }) {
  const items = lineItemsOf(order)
  const [open, setOpen] = useState(null)
  if (items.length <= 1) return null

  return (
    <div className="glass-card p-4 space-y-2 text-sm">
      <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#5C6E8C' }}>
        Sub-orders in this order ({items.length}) · worked as one unit
      </div>
      {items.map((p, i) => {
        const n = p.n || i + 1
        const id = lineSubId(order.id, n)
        const addr = [p.address, p.city, stateName(p.state) || p.state, p.zip].filter(Boolean).join(', ')
        const isOpen = open === i
        return (
          <div key={i} className="rounded-lg overflow-hidden" style={{ background: '#fff', border: '1px solid rgba(18,40,76,0.08)' }}>
            <button type="button" onClick={() => setOpen(isOpen ? null : i)} aria-expanded={isOpen}
              className="w-full text-left px-3 py-2 flex items-start gap-2 transition-colors"
              style={{ background: isOpen ? 'rgba(36,65,229,0.04)' : 'transparent' }}>
              {isOpen
                ? <ChevronDown className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: ROLE_COLOR }} />
                : <ChevronRight className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: '#9AA8BF' }} />}
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-xs font-semibold" style={{ color: ROLE_COLOR }}>{id}</span>
                  {p.searchType && <span className="text-xs" style={{ color: '#5C6E8C' }}>{p.searchType}</span>}
                </div>
                <div className="font-medium" style={{ color: '#12284C' }}>{addr || '—'}</div>
                <div className="text-xs" style={{ color: '#5C6E8C' }}>
                  {[p.county && `${p.county} County`, p.parcelId && `APN ${p.parcelId}`].filter(Boolean).join(' · ') || '—'}
                </div>
              </div>
            </button>
            {isOpen && (
              <div className="px-3 pb-3 pt-2 space-y-1 text-xs" style={{ borderTop: '1px solid rgba(18,40,76,0.06)' }}>
                <Field k="Sub-order" v={id} />
                <Field k="Search type" v={p.searchType} />
                <Field k="Property type" v={p.propertyType} />
                <Field k="Address" v={addr} />
                <Field k="County" v={p.county && `${p.county} County`} />
                <Field k="Parcel / APN" v={p.parcelId} />
                <Field k="Buyer" v={p.buyer} />
                <Field k="Borrower" v={p.borrower} />
                <Field k="Seller" v={p.seller} />
                <Field k="Your file #" v={p.clientFileNo} />
                <Field k="Notes" v={p.notes} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
