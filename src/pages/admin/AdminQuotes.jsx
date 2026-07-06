import React, { useMemo, useState } from 'react'
import { Mail, Globe, Send, CheckCircle, XCircle, MessageSquare, ArrowRight } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { displayClient } from '../../data/mockData'
import {
  QUOTE_STAGES, quoteOf, quoteStage, isEmailSource,
  sendQuote, acceptQuote, confirmOrder, declineQuote, addThreadMsg, sendOrderEmail,
} from '../../lib/quotes'

const Q = {
  card: '#ffffff', border: '#e2e8f0', text: '#1e293b', muted: '#64748b',
  faint: '#94a3b8', shadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
}
const ACCENT = '#3d7020'

const StageChip = ({ stage }) => {
  const s = QUOTE_STAGES[stage] || QUOTE_STAGES.pending
  return <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
    style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
}

function Thread({ thread }) {
  if (!thread?.length) return null
  return (
    <div className="space-y-1.5 rounded-lg p-3 max-h-48 overflow-y-auto" style={{ background: '#f8fafc', border: `1px solid ${Q.border}` }}>
      {thread.map(m => (
        <div key={m.id} className="text-xs">
          <span className="font-semibold" style={{ color: m.from === 'admin' ? ACCENT : '#2563eb' }}>
            {m.from === 'admin' ? 'Resolute' : 'Client'}
          </span>
          <span style={{ color: Q.faint }}> · {String(m.at).slice(0, 16).replace('T', ' ')}</span>
          <div style={{ color: Q.muted }}>{m.text}</div>
          {m.email && (
            <div className="text-[10px]" style={{ color: m.email.sent ? '#15803d' : '#b45309' }}>
              {m.email.sent ? `✓ emailed to ${m.email.to}` : `email not sent — ${m.email.reason}`}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function QuoteCard({ order, onUpdate, userName, clientLabel }) {
  const q = quoteOf(order)
  const stage = q.stage
  const [amount, setAmount] = useState(q.amount ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const email = isEmailSource(order)
  const intake = order.workflow?.intake || {}

  const patchQuote = (quote, extra = {}) =>
    onUpdate({ ...order, ...extra, workflow: { ...order.workflow, quote } })

  const doSendQuote = async () => {
    const amt = Number(amount)
    if (!amt || busy) return
    setBusy(true)
    const emailResult = email ? await sendOrderEmail(order.id, 'quote', amt, note) : null
    patchQuote(sendQuote(q, { amount: amt, note, by: userName, emailResult }))
    setNote(''); setBusy(false)
  }
  const doConfirm = async () => {
    if (busy) return
    setBusy(true)
    const emailResult = email ? await sendOrderEmail(order.id, 'confirmation', q.amount, note) : null
    // Confirmation releases the order to production — Screener intake queue.
    patchQuote(confirmOrder(q, { by: userName, note, emailResult }), { assignedTo: 'screener' })
    setNote(''); setBusy(false)
  }
  const doMsg = () => {
    if (!note.trim()) return
    patchQuote(addThreadMsg(q, 'admin', note.trim()))
    setNote('')
  }

  const input = { border: `1px solid ${Q.border}`, background: Q.card, color: Q.text }

  return (
    <div className="rounded-xl p-4 space-y-3" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm" style={{ color: ACCENT }}>{order.id}</span>
          <span className="text-sm font-medium" style={{ color: Q.text }}>{order.type}</span>
          <StageChip stage={stage} />
          <span className="inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full"
            style={{ background: 'rgba(30,41,59,0.05)', color: Q.muted }}>
            {email ? <Mail className="w-3 h-3" /> : <Globe className="w-3 h-3" />}
            {email ? (intake.from || 'email order') : 'portal order'}
          </span>
        </div>
        <div className="text-xs" style={{ color: Q.faint }}>{clientLabel} · {order.created}</div>
      </div>

      {(intake.propertyAddress || intake.specialInstructions) && (
        <div className="text-xs" style={{ color: Q.muted }}>
          {intake.propertyAddress && <div>Property: {intake.propertyAddress}</div>}
          {intake.specialInstructions && <div>Notes: {intake.specialInstructions}</div>}
        </div>
      )}

      <Thread thread={q.thread} />

      {/* Stage actions */}
      {(stage === 'pending' || stage === 'quoted') && (
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-xs" style={{ color: Q.muted }}>
            Quote amount ($)
            <input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)}
              className="block mt-1 rounded-lg px-3 py-2 text-sm w-32" style={input} />
          </label>
          <label className="text-xs flex-1 min-w-[180px]" style={{ color: Q.muted }}>
            Message to client
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional note…"
              className="block mt-1 rounded-lg px-3 py-2 text-sm w-full" style={input} />
          </label>
          <button onClick={doSendQuote} disabled={!Number(amount) || busy}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2.5 rounded-lg"
            style={{ background: ACCENT, color: '#f5f7f2', opacity: (!Number(amount) || busy) ? 0.5 : 1 }}>
            <Send className="w-3.5 h-3.5" /> {stage === 'pending' ? 'Send Quote' : 'Re-send Quote'}
          </button>
          {stage === 'quoted' && (
            <>
              <button onClick={() => patchQuote(acceptQuote(q, 'email'))}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-lg"
                style={{ background: 'rgba(14,116,144,0.12)', color: '#0e7490' }}>
                <CheckCircle className="w-3.5 h-3.5" /> Client Accepted (reply)
              </button>
              <button onClick={() => patchQuote(declineQuote(q))}
                className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-lg"
                style={{ background: 'rgba(220,38,38,0.10)', color: '#dc2626' }}>
                <XCircle className="w-3.5 h-3.5" /> Declined
              </button>
            </>
          )}
        </div>
      )}

      {stage === 'accepted' && (
        <div className="flex items-end gap-2 flex-wrap">
          <div className="text-sm font-semibold" style={{ color: Q.text }}>
            Agreed: ${q.amount} <span className="text-xs font-normal" style={{ color: Q.faint }}>({q.acceptedVia === 'portal' ? 'accepted in portal' : 'accepted by email'})</span>
          </div>
          <label className="text-xs flex-1 min-w-[180px]" style={{ color: Q.muted }}>
            Confirmation note
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="Optional…"
              className="block mt-1 rounded-lg px-3 py-2 text-sm w-full" style={input} />
          </label>
          <button onClick={doConfirm} disabled={busy}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2.5 rounded-lg"
            style={{ background: ACCENT, color: '#f5f7f2', opacity: busy ? 0.5 : 1 }}>
            <ArrowRight className="w-3.5 h-3.5" /> Send Confirmation & Start Work
          </button>
        </div>
      )}

      {stage === 'confirmed' && (
        <div className="text-xs" style={{ color: '#15803d' }}>
          Confirmed at ${q.amount} by {q.confirmedBy} · {String(q.confirmedAt).slice(0, 10)} — released to Screener.
        </div>
      )}

      {/* Free-form thread message (any active stage) */}
      {stage !== 'confirmed' && stage !== 'declined' && stage !== 'pending' && (
        <div className="flex items-center gap-2">
          <input value={note} onChange={e => setNote(e.target.value)} placeholder="Message the client…"
            className="flex-1 rounded-lg px-3 py-2 text-xs" style={input}
            onKeyDown={e => e.key === 'Enter' && doMsg()} />
          <button onClick={doMsg} className="p-2 rounded-lg" style={{ background: 'rgba(30,41,59,0.05)', color: Q.muted }}>
            <MessageSquare className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  )
}

export default function AdminQuotes() {
  const { orders, updateOrder } = useOrders()
  const { user } = useAuth()
  const [tab, setTab] = useState('active')

  const withQuote = useMemo(() => orders.filter(o => quoteOf(o)), [orders])
  const active = withQuote.filter(o => !['confirmed', 'declined'].includes(quoteStage(o)))
  const history = withQuote.filter(o => ['confirmed', 'declined'].includes(quoteStage(o)))
  const list = tab === 'active' ? active : history

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: Q.text }}>Quotes & Confirmations</h1>
        <p className="text-sm" style={{ color: Q.muted }}>
          New orders are held here until the price is agreed. Email orders are quoted by email; portal orders message the client's portal Inbox.
        </p>
      </div>

      <div className="flex items-center gap-2">
        {[['active', `Active (${active.length})`], ['history', `History (${history.length})`]].map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border"
            style={tab === k
              ? { background: `${ACCENT}14`, border: `1px solid ${ACCENT}55`, color: Q.text }
              : { border: `1px solid ${Q.border}`, color: Q.muted, background: Q.card }}>
            {l}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        {list.map(o => <QuoteCard key={o.id} order={o} onUpdate={updateOrder} userName={user?.name}
          clientLabel={displayClient(o.client, user)} />)}
        {!list.length && (
          <div className="rounded-xl p-10 text-center text-sm" style={{ background: Q.card, border: `1px solid ${Q.border}`, color: Q.faint }}>
            {tab === 'active' ? 'No orders awaiting quotes — new portal and email orders appear here.' : 'No confirmed or declined quotes yet.'}
          </div>
        )}
      </div>
    </div>
  )
}
