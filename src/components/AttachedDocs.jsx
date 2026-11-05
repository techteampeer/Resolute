import React from 'react'
import { FileText, Eye, Paperclip, Send } from 'lucide-react'
import { openDocument } from '../lib/backend'
import { collectOrderDocs, docIsShared } from '../lib/orderDocs'

// Every document attached to the order across all stages — client uploads, each
// stage's work product, and Delivery's own files — carried on order.workflow so
// the whole paper trail travels to Admin and every downstream assignee. A badge
// marks the ones Delivery has flagged to send across to the client.
export default function AttachedDocs({ workflow, className = '' }) {
  const order = { workflow }
  const items = collectOrderDocs(order)
  if (!items.length) return null
  return (
    <div className={`rounded-xl p-3 ${className}`} style={{ background: '#F9FBFD', border: '1px solid #DDE3EC' }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Paperclip className="w-3.5 h-3.5" style={{ color: '#3D5171' }} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: '#3D5171' }}>Attached Documents</span>
      </div>
      <div className="space-y-1.5">
        {items.map((d) => {
          const shared = docIsShared(order, d)
          return (
            <div key={d.id} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg" style={{ background: '#ffffff', border: '1px solid #DDE3EC' }}>
              <FileText className="w-4 h-4 flex-shrink-0" style={{ color: d.type === 'pdf' ? '#dc2626' : '#2441E5' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[12.5px] font-medium truncate" style={{ color: '#12284C' }}>{d.name}</div>
                <div className="text-[10px] uppercase tracking-wide" style={{ color: '#5C6E8C' }}>{d.label}</div>
              </div>
              {shared && (
                <span className="flex items-center gap-1 text-[9.5px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full"
                  style={{ background: '#dcfce7', color: '#15803d' }}><Send className="w-2.5 h-2.5" /> Client</span>
              )}
              {(d.url || d.path) && (
                <button onClick={() => openDocument(d)} title="Preview / download"
                  className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: '#3D5171' }}
                  onMouseOver={e => e.currentTarget.style.background = '#EDF0F5'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                  <Eye className="w-4 h-4" />
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
