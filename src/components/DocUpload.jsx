import React, { useState, useRef } from 'react'
import { UploadCloud, FileText, Trash2, CheckCircle2, AlertCircle, Eye } from 'lucide-react'
import { ACCEPTED_DOCS, validDocType, fileKind, uid } from '../data/fulfillment'
import { isBackendConfigured, uploadDocument, openDocument } from '../lib/backend'

// Compact PDF/Word upload used across the role portals (dark theme).
// Uploads to Supabase Storage when configured; otherwise stores a local ref.
export default function DocUpload({ orderId, value, onChange, accent = '#2441E5' }) {
  const [drag, setDrag] = useState(false)
  const [err, setErr]   = useState('')
  const inputRef = useRef(null)

  const handle = async (list) => {
    const file = Array.from(list || [])[0]
    if (!file) return
    if (!validDocType(file)) { setErr('PDF or Word (.doc/.docx) only'); return }
    setErr('')
    const ref = { id: uid(), name: file.name, type: fileKind(file.name), status: isBackendConfigured ? 'uploading' : 'done', url: null }
    onChange(ref)
    if (isBackendConfigured) {
      try { const { url, path } = await uploadDocument(orderId, file); onChange({ ...ref, status: 'done', url, path }) }
      catch { onChange({ ...ref, status: 'error' }) }
    }
  }

  if (value) return (
    <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl"
      style={{ background: 'rgba(18,40,76,0.04)', border: '1px solid rgba(36,65,229,0.14)' }}>
      <FileText className="w-5 h-5 flex-shrink-0" style={{ color: value.type === 'pdf' ? '#dc2626' : '#2441E5' }} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate" style={{ color: '#12284C' }}>{value.name}</div>
        <div className="text-[11px] flex items-center gap-1" style={{ color: '#5C6E8C' }}>
          {value.status === 'uploading' ? 'Uploading…'
            : value.status === 'error' ? <><AlertCircle className="w-3 h-3" style={{ color: '#dc2626' }} /> Failed</>
            : <><CheckCircle2 className="w-3 h-3" style={{ color: accent }} /> Uploaded</>}
        </div>
      </div>
      {(value.url || value.path) && <button onClick={() => openDocument(value)} title="Preview"
        className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ color: '#5C6E8C' }}><Eye className="w-4 h-4" /></button>}
      <button onClick={() => onChange(null)} title="Remove"
        className="w-7 h-7 rounded-lg flex items-center justify-center" style={{ color: '#dc2626' }}><Trash2 className="w-4 h-4" /></button>
    </div>
  )

  return (
    <div>
      <div role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files) }}
        className="rounded-xl flex flex-col items-center justify-center py-5 px-4 cursor-pointer transition-all"
        style={{ border: `1.5px dashed ${drag ? accent : 'rgba(36,65,229,0.25)'}`, background: drag ? `${accent}12` : 'transparent' }}>
        <UploadCloud className="w-6 h-6 mb-1.5" style={{ color: drag ? accent : '#5C6E8C' }} />
        <div className="text-sm font-medium" style={{ color: '#12284C' }}>Drag &amp; drop or <span style={{ color: accent }}>browse</span></div>
        <div className="text-[11px] mt-0.5" style={{ color: '#5C6E8C' }}>PDF or Word · up to 25 MB</div>
        <input ref={inputRef} type="file" accept={ACCEPTED_DOCS} className="hidden"
          onChange={e => { handle(e.target.files); e.target.value = '' }} />
      </div>
      {err && <div className="flex items-center gap-1.5 mt-2 text-[12px]" style={{ color: '#dc2626' }}><AlertCircle className="w-3.5 h-3.5" /> {err}</div>}
    </div>
  )
}
