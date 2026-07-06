import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Inbox, CheckCircle, Send, Clock } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { QUOTE_STAGES, quoteOf, quoteStage, acceptQuote, addThreadMsg } from '../../lib/quotes'
import { money } from '../../lib/billing'

const ROLE_COLOR = '#4d7c2f'

const StageChip = ({ stage }) => {
  const s = QUOTE_STAGES[stage] || QUOTE_STAGES.pending
  return <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
    style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
}

function QuoteThread({ order }) {
  const { updateOrder } = useOrders()
  const q = quoteOf(order)
  const stage = q.stage
  const [reply, setReply] = useState('')

  const patch = (quote) => updateOrder({ ...order, workflow: { ...order.workflow, quote } })
  const accept = () => patch(acceptQuote(q, 'portal'))
  const sendReply = () => {
    if (!reply.trim()) return
    patch(addThreadMsg(q, 'client', reply.trim()))
    setReply('')
  }

  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="glass-card p-5 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{order.id}</span>
          <span className="text-sm font-medium" style={{ color: '#1e293b' }}>{order.type}</span>
          <StageChip stage={stage} />
        </div>
        {q.amount != null && (
          <span className="text-lg font-bold tabular-nums" style={{ color: '#1e293b' }}>{money(q.amount)}</span>
        )}
      </div>

      {/* Conversation */}
      <div className="space-y-2 rounded-xl p-3 max-h-56 overflow-y-auto"
        style={{ background: 'rgba(30,41,59,0.03)', border: '1px solid rgba(30,41,59,0.07)' }}>
        {(q.thread || []).length === 0 && (
          <div className="text-xs text-center py-2" style={{ color: '#64748b' }}>
            <Clock className="w-4 h-4 mx-auto mb-1" />
            Our team is reviewing your order — your quote will appear here shortly.
          </div>
        )}
        {(q.thread || []).map(m => (
          <div key={m.id} className={`flex ${m.from === 'client' ? 'justify-end' : 'justify-start'}`}>
            <div className="max-w-[85%] px-3 py-2 rounded-2xl text-xs"
              style={m.from === 'client'
                ? { background: '#3d7020', color: '#f5f7f2' }
                : { background: '#ffffff', color: '#1e293b', border: '1px solid rgba(30,41,59,0.08)' }}>
              {m.text}
              <div className="text-[10px] mt-0.5" style={{ color: m.from === 'client' ? 'rgba(245,247,242,0.7)' : '#94a3b8' }}>
                {m.from === 'client' ? 'You' : 'Resolute'} · {String(m.at).slice(0, 16).replace('T', ' ')}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Actions by stage */}
      {stage === 'quoted' && (
        <button onClick={accept} className="btn-primary w-full text-sm py-2.5 flex items-center justify-center gap-1.5">
          <CheckCircle className="w-4 h-4" /> Accept Quote — {money(q.amount)}
        </button>
      )}
      {stage === 'accepted' && (
        <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(14,116,144,0.10)', border: '1px solid rgba(14,116,144,0.2)', color: '#0e7490' }}>
          <CheckCircle className="w-4 h-4" /> You accepted {money(q.amount)} — waiting for Resolute's confirmation.
        </div>
      )}
      {stage === 'confirmed' && (
        <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(109,188,120,0.12)', border: '1px solid rgba(109,188,120,0.25)', color: '#15803d' }}>
          <CheckCircle className="w-4 h-4" /> Order confirmed at {money(q.amount)} — our team has started work.
        </div>
      )}

      {/* Reply box (active discussions) */}
      {stage !== 'confirmed' && stage !== 'declined' && (
        <div className="flex items-center gap-2">
          <input value={reply} onChange={e => setReply(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendReply()}
            placeholder="Reply about pricing…" className="input-field text-sm flex-1 py-2" />
          <button onClick={sendReply} className="btn-primary px-4 py-2 text-sm"><Send className="w-4 h-4" /></button>
        </div>
      )}
    </motion.div>
  )
}

// Inbox = quote/price discussions for this client's orders. Includes the
// demo account's fixed orders plus any order placed via the portal this
// session (source 'web'), so a newly placed order's quote shows up here.
export default function ClientInbox({ myOrders }) {
  const { orders } = useOrders()
  const mine = new Set(myOrders.map(o => o.id))
  const withQuote = orders.filter(o => quoteOf(o) && (mine.has(o.id) || o.workflow?.intake?.source === 'web'))

  return (
    <div className="max-w-2xl mx-auto space-y-5">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>Inbox</h1>
        <p className="text-sm" style={{ color: '#64748b' }}>Quotes and order confirmations — agree on the price here before work begins.</p>
      </div>
      {withQuote.length === 0 && (
        <div className="glass-card p-10 text-center text-sm" style={{ color: '#64748b' }}>
          <Inbox className="w-7 h-7 mx-auto mb-2" style={{ color: '#94a3b8' }} />
          No messages yet — when you place an order, your quote lands here for approval.
        </div>
      )}
      {withQuote.map(o => <QuoteThread key={o.id} order={o} />)}
    </div>
  )
}
