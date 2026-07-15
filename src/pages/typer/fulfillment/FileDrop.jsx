import React, { useState, useRef } from 'react'
import { motion } from 'framer-motion'
import { UploadCloud, FileText, File as FileIcon, Trash2, Eye, RefreshCw, AlertCircle, CheckCircle2 } from 'lucide-react'
import { T } from './ui'
import { ACCEPTED_DOCS, validDocType, fileKind, uid } from '../../../data/fulfillment'
import { openDocument } from '../../../lib/backend'

const KB = 1024, MB = KB * 1024
const fmtSize = (b) => (b > MB ? `${(b / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(b / KB))} KB`)
const MAX = 25 * MB

export const makeFileRef = (file) => ({
  id: uid(),
  name: file.name,
  size: file.size,
  type: fileKind(file.name),
  progress: 0,
  status: 'uploading',           // 'uploading' | 'done' | 'error'
  url: fileKind(file.name) === 'pdf' ? URL.createObjectURL(file) : null,
})

const TypeIcon = ({ type, className }) =>
  type === 'pdf'  ? <FileText className={className} style={{ color: '#dc2626' }} />
: type === 'word' ? <FileText className={className} style={{ color: '#2563eb' }} />
:                   <FileIcon className={className} style={{ color: T.faint }} />

// Drag-and-drop + click-to-browse zone. Emits validated File[] via onFiles.
export function FileDropZone({ onFiles, multiple = false, compact = false }) {
  const [drag, setDrag] = useState(false)
  const [err, setErr]   = useState('')
  const inputRef = useRef(null)

  const handle = (list) => {
    const files = Array.from(list || [])
    if (!files.length) return
    const bad = files.find(f => !validDocType(f))
    if (bad) { setErr(`"${bad.name}" is not a PDF or Word document.`); return }
    const big = files.find(f => f.size > MAX)
    if (big) { setErr(`"${big.name}" exceeds the 25 MB limit.`); return }
    setErr('')
    onFiles(multiple ? files : [files[0]])
  }

  return (
    <div>
      <div
        role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); handle(e.dataTransfer.files) }}
        className={`rounded-lg flex flex-col items-center justify-center text-center cursor-pointer transition-all ${compact ? 'py-4 px-4' : 'py-7 px-6'}`}
        style={{
          border: `1.5px dashed ${drag ? T.borderStrong : T.border}`,
          background: drag ? 'rgba(124,191,78,0.07)' : 'transparent',
        }}>
        <UploadCloud className={compact ? 'w-5 h-5 mb-1.5' : 'w-7 h-7 mb-2'} style={{ color: drag ? T.accentBright : T.faint }} />
        <div className="text-[13px] font-medium" style={{ color: T.text }}>
          {drag ? 'Drop to upload' : <>Drag &amp; drop or <span style={{ color: T.accentBright }}>browse</span></>}
        </div>
        <div className="text-[11px] mt-0.5" style={{ color: T.dim }}>PDF or Word (.doc, .docx) · up to 25 MB</div>
        <input ref={inputRef} type="file" accept={ACCEPTED_DOCS} multiple={multiple} className="hidden"
          onChange={e => { handle(e.target.files); e.target.value = '' }} />
      </div>
      {err && (
        <div className="flex items-center gap-1.5 mt-2 text-[12px]" style={{ color: '#dc2626' }}>
          <AlertCircle className="w-3.5 h-3.5" /> {err}
        </div>
      )}
    </div>
  )
}

// One uploaded file row: icon, name/size, progress, success, actions.
export function FileRow({ file, onRemove, onRetry, onReplace, checkbox, checked, onCheck }) {
  const preview = () => openDocument(file)
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 px-3 py-2 rounded-lg"
      style={{ background: T.card, border: `1px solid ${T.border}` }}>
      {checkbox && (
        <input type="checkbox" checked={checked} onChange={e => onCheck(e.target.checked)}
          className="w-3.5 h-3.5 rounded flex-shrink-0" style={{ accentColor: T.accent }} />
      )}
      <TypeIcon type={file.type} className="w-5 h-5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium truncate" style={{ color: T.text }}>{file.name}</div>
        {file.status === 'uploading' ? (
          <div className="mt-1 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(30,41,59,0.08)' }}>
            <motion.div className="h-full rounded-full" style={{ background: T.accentBright }}
              animate={{ width: `${file.progress}%` }} transition={{ ease: 'linear' }} />
          </div>
        ) : (
          <div className="text-[11px] flex items-center gap-1.5 tabular-nums" style={{ color: T.dim }}>
            {file.status === 'done'
              ? <><CheckCircle2 className="w-3 h-3" style={{ color: T.accentBright }} /> {fmtSize(file.size)} · {file.type.toUpperCase()}</>
              : <><AlertCircle className="w-3 h-3" style={{ color: '#dc2626' }} /> Upload failed</>}
          </div>
        )}
      </div>
      <div className="flex items-center gap-0.5 flex-shrink-0">
        {file.status === 'error' && onRetry && (
          <IconAct title="Retry" onClick={onRetry}><RefreshCw className="w-3.5 h-3.5" /></IconAct>
        )}
        {file.status === 'done' && (file.url || file.path) && (
          <IconAct title="Preview" onClick={preview}><Eye className="w-3.5 h-3.5" /></IconAct>
        )}
        {file.status === 'done' && onReplace && (
          <IconAct title="Replace" onClick={onReplace}><RefreshCw className="w-3.5 h-3.5" /></IconAct>
        )}
        <IconAct title="Remove" danger onClick={onRemove}><Trash2 className="w-3.5 h-3.5" /></IconAct>
      </div>
    </motion.div>
  )
}

function IconAct({ children, onClick, title, danger }) {
  return (
    <button onClick={onClick} title={title}
      className="w-6 h-6 rounded-md flex items-center justify-center transition-colors"
      style={{ color: danger ? '#dc2626' : T.faint }}
      onMouseOver={e => { e.currentTarget.style.background = danger ? 'rgba(217,138,122,0.12)' : T.rowHover; if (!danger) e.currentTarget.style.color = T.text }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; if (!danger) e.currentTarget.style.color = T.faint }}>
      {children}
    </button>
  )
}
