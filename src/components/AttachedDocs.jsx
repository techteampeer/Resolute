import React from 'react'
import { FileText, Eye, Paperclip } from 'lucide-react'
import { openDocument } from '../lib/backend'

// Documents attached by earlier stages, carried on order.workflow so they
// travel with the order to Admin and to every downstream assignee.
const DOCS = [
  { key: 'screenerDoc', label: 'Screener · Search Document' },
  { key: 'examinerDoc', label: 'Examiner · Researched Document' },
  { key: 'commitmentDoc', label: 'Typer · Title Commitment' },
]

export default function AttachedDocs({ workflow, className = '' }) {
  const items = DOCS.map(d => ({ ...d, file: workflow?.[d.key] })).filter(x => x.file)
  if (!items.length) return null
  return (
    <div className={`rounded-xl p-3 ${className}`} style={{ background: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <div className="flex items-center gap-1.5 mb-2">
        <Paperclip className="w-3.5 h-3.5" style={{ color: '#475569' }} />
        <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: '#475569' }}>Attached Documents</span>
      </div>
      <div className="space-y-1.5">
        {items.map(({ key, label, file }) => (
          <div key={key} className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg" style={{ background: '#ffffff', border: '1px solid #e2e8f0' }}>
            <FileText className="w-4 h-4 flex-shrink-0" style={{ color: file.type === 'pdf' ? '#dc2626' : '#2563eb' }} />
            <div className="flex-1 min-w-0">
              <div className="text-[12.5px] font-medium truncate" style={{ color: '#1e293b' }}>{file.name}</div>
              <div className="text-[10px] uppercase tracking-wide" style={{ color: '#64748b' }}>{label}</div>
            </div>
            {(file.url || file.path) && (
              <button onClick={() => openDocument(file)} title="Preview / download"
                className="w-7 h-7 rounded-lg flex items-center justify-center transition-colors" style={{ color: '#475569' }}
                onMouseOver={e => e.currentTarget.style.background = '#f1f5f9'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <Eye className="w-4 h-4" />
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
