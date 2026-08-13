import React, { useState } from 'react'
import { MessageSquare, Lock, StickyNote, Send } from 'lucide-react'
import { useSupport } from '../context/SupportContext'
import { useAuth } from '../context/AuthContext'

// Client messages on an order, for the STAFF side.
//
// Communication policy (enforced by RLS in
// supabase/migrations/20260807000000_message_access_control.sql):
//   • Only admins reply to the client — every other role sees the conversation
//     read-only, with an explicit note saying replies go through Admin.
//   • Any staff member can leave an INTERNAL note; clients never see those.
// Clients only ever converse in the portal; email is notification-only.
export default function OrderMessages({ order, accent = '#4d7c2f' }) {
  const { user } = useAuth()
  const { getOrderThread, getOrderNotes, sendMessage, canReplyToClient, canAddInternalNote } = useSupport()
  const [note, setNote] = useState('')

  const thread = getOrderThread(order.id)
  const notes  = getOrderNotes(order.id)

  const addNote = () => {
    const body = note.trim()
    if (!body) return
    sendMessage({
      clientCode: order.clientCode || order.client, from: 'support', text: body,
      author: user?.name, orderId: order.id, visibility: 'internal',
    })
    setNote('')
  }

  const Bubble = ({ m, internal = false }) => (
    <div style={{
      borderRadius: 10, padding: '8px 10px',
      background: internal ? 'rgba(196,164,78,0.10)' : m.from === 'client' ? 'rgba(30,41,59,0.05)' : `${accent}14`,
      border: internal ? '1px dashed rgba(196,164,78,0.45)' : '1px solid rgba(30,41,59,0.06)',
    }}>
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-[11px] font-semibold" style={{ color: internal ? '#a16207' : m.from === 'client' ? '#1e293b' : accent }}>
          {internal ? `${m.author || 'Staff'} · internal` : m.from === 'client' ? 'Client' : (m.author || 'Resolute')}
        </span>
        <span className="text-[10px]" style={{ color: '#94a3b8' }}>{m.time}</span>
      </div>
      <div className="text-[12.5px] whitespace-pre-wrap" style={{ color: '#334155' }}>{m.text}</div>
    </div>
  )

  return (
    <div className="space-y-3">
      {/* Client conversation — read-only unless admin */}
      <div>
        <div className="flex items-center gap-1.5 mb-2">
          <MessageSquare className="w-3.5 h-3.5" style={{ color: accent }} />
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#64748b' }}>
            Client Messages
          </span>
          {!canReplyToClient && (
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full"
              style={{ background: 'rgba(30,41,59,0.06)', color: '#64748b' }}>
              <Lock className="w-2.5 h-2.5" /> View only
            </span>
          )}
        </div>
        {thread.length === 0
          ? <div className="text-xs" style={{ color: '#94a3b8' }}>No client messages on this order.</div>
          : <div className="space-y-2">{thread.map(m => <Bubble key={m.id} m={m} />)}</div>}
        {!canReplyToClient && thread.length > 0 && (
          <p className="text-[11px] mt-2" style={{ color: '#94a3b8' }}>
            Replies to clients are sent by Admin. Use an internal note below to flag anything.
          </p>
        )}
      </div>

      {/* Internal notes — staff-only, invisible to clients */}
      {canAddInternalNote && (
        <div className="pt-3" style={{ borderTop: '1px solid rgba(30,41,59,0.08)' }}>
          <div className="flex items-center gap-1.5 mb-2">
            <StickyNote className="w-3.5 h-3.5" style={{ color: '#a16207' }} />
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: '#64748b' }}>
              Internal Notes
            </span>
            <span className="text-[10px]" style={{ color: '#94a3b8' }}>· not visible to the client</span>
          </div>
          {notes.length > 0 && <div className="space-y-2 mb-2">{notes.map(m => <Bubble key={m.id} m={m} internal />)}</div>}
          <div className="flex gap-2">
            <input value={note} onChange={e => setNote(e.target.value)}
              placeholder="Flag something for Admin…"
              className="input-field text-xs flex-1" style={{ padding: '7px 10px' }} />
            <button onClick={addNote} disabled={!note.trim()}
              className="text-xs font-semibold px-3 rounded-lg inline-flex items-center gap-1.5"
              style={{ background: note.trim() ? '#a16207' : 'rgba(30,41,59,0.08)', color: note.trim() ? '#fff' : '#94a3b8',
                cursor: note.trim() ? 'pointer' : 'not-allowed' }}>
              <Send className="w-3 h-3" /> Note
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
