import React, { useState, useRef } from 'react'
import { FileText, Paperclip, Send, X } from 'lucide-react'
import { isBackendConfigured, uploadDocument, openDocument } from '../lib/backend'
import { fileKind } from '../data/fulfillment'

// Qualia-style per-order message thread: full-width message cards (sender name +
// timestamp header, body, optional file attachment), a compose box, and an
// Attach File control. Shared by the client Messages tab and the admin Inbox
// tab. `viewerSide` ('client' | 'support') tints the viewer's own messages.
const ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,image/*'
const senderLabel = (m) => m.author || (m.from === 'support' ? 'Customer Service' : 'Client')

export default function OrderThread({ orderId, messages = [], viewerSide = 'support', onSend, canSend = true, accent = '#2441E5', height = 460, emptyText }) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState(null)   // staged attachment { name, type, path?, url? }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const fileRef = useRef(null)
  const scrollRef = useRef(null)

  React.useEffect(() => { const el = scrollRef.current; if (el) el.scrollTop = el.scrollHeight }, [messages.length])

  const pickFile = async (file) => {
    if (!file) return
    if (!/\.(pdf|docx?|jpe?g|png|tiff?)$/i.test(file.name)) { setErr('PDF, Word, or image only'); return }
    setErr(''); setBusy(true)
    try {
      if (isBackendConfigured && orderId) {
        const { path, url } = await uploadDocument(orderId, file)
        setPending({ name: file.name, type: fileKind(file.name), path, url })
      } else {
        setPending({ name: file.name, type: fileKind(file.name), url: URL.createObjectURL(file) })
      }
    } catch { setErr('Upload failed'); setPending(null) } finally { setBusy(false) }
  }
  const submit = () => {
    const t = text.trim()
    if (!t && !pending) return
    onSend({ text: t, attachment: pending })
    setText(''); setPending(null); setErr('')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height }}>
      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '4px 2px', display: 'flex', flexDirection: 'column', gap: 12 }}>
        {messages.length === 0 && (
          <div style={{ margin: 'auto', color: '#9AA8BF', fontSize: 13, textAlign: 'center', padding: 24 }}>
            {emptyText || 'No messages yet. Start the conversation below.'}
          </div>
        )}
        {messages.map((m, i) => {
          const mine = m.from === viewerSide
          return (
            <div key={m.id || i} style={{ border: `1px solid ${mine ? accent + '55' : '#DDE3EC'}`, background: mine ? accent + '0c' : '#fff', borderRadius: 12, padding: '12px 14px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 700, letterSpacing: '0.02em', color: '#12284C', textTransform: 'uppercase' }}>{senderLabel(m)}</span>
                <span style={{ fontSize: 11.5, color: '#9AA8BF', whiteSpace: 'nowrap' }}>{m.time}</span>
              </div>
              {m.text && <div style={{ fontSize: 13.5, lineHeight: 1.5, color: '#2A3E5F', whiteSpace: 'pre-wrap' }}>{m.text}</div>}
              {m.attachment && (
                <button onClick={() => openDocument(m.attachment)}
                  style={{ marginTop: m.text ? 8 : 0, display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 10px', borderRadius: 8, border: '1px solid #DDE3EC', background: '#F9FBFD', cursor: 'pointer', maxWidth: '100%' }}>
                  <FileText style={{ width: 15, height: 15, flexShrink: 0, color: m.attachment.type === 'pdf' ? '#dc2626' : m.attachment.type === 'word' ? '#2441E5' : '#5C6E8C' }} />
                  <span style={{ fontSize: 12.5, color: '#12284C', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.attachment.name}</span>
                </button>
              )}
            </div>
          )
        })}
      </div>

      {canSend ? (
        <div style={{ borderTop: '1px solid #DDE3EC', paddingTop: 12, marginTop: 8 }}>
          {pending && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 8, background: '#EDF0F5', border: '1px solid #DDE3EC', marginBottom: 8 }}>
              <Paperclip style={{ width: 13, height: 13, color: '#5C6E8C' }} />
              <span style={{ fontSize: 12, color: '#12284C' }}>{pending.name}</span>
              <button onClick={() => setPending(null)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', display: 'flex' }}><X style={{ width: 13, height: 13 }} /></button>
            </div>
          )}
          {err && <div style={{ fontSize: 12, color: '#dc2626', marginBottom: 6 }}>{err}</div>}
          <textarea value={text} onChange={e => setText(e.target.value)}
            placeholder="Type a message…" rows={3}
            style={{ width: '100%', padding: '10px 12px', border: '1px solid #DDE3EC', borderRadius: 10, fontSize: 13.5, outline: 'none', resize: 'none', color: '#12284C', fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={submit} disabled={busy || (!text.trim() && !pending)}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 16px', borderRadius: 8, border: 'none', background: accent, color: '#fff', fontSize: 13, fontWeight: 600, cursor: (busy || (!text.trim() && !pending)) ? 'not-allowed' : 'pointer', opacity: (!text.trim() && !pending) ? 0.6 : 1 }}>
              <Send style={{ width: 15, height: 15 }} /> Send Message
            </button>
            <button onClick={() => fileRef.current?.click()} disabled={busy}
              style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, border: '1px solid #DDE3EC', background: '#fff', color: '#3D5171', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer' }}>
              <Paperclip style={{ width: 15, height: 15 }} /> {busy ? 'Uploading…' : 'Attach File'}
            </button>
            <input ref={fileRef} type="file" accept={ACCEPT} className="hidden" style={{ display: 'none' }}
              onChange={e => { pickFile(e.target.files?.[0]); e.target.value = '' }} />
          </div>
        </div>
      ) : (
        <div style={{ borderTop: '1px solid #DDE3EC', paddingTop: 12, marginTop: 8, fontSize: 12.5, color: '#9AA8BF' }}>
          Messaging is available on your own orders.
        </div>
      )}
    </div>
  )
}
