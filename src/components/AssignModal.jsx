import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { X, UserCheck } from 'lucide-react'
import { USERS, displayClient, nextRoleFor } from '../data/mockData'
import { useOrders } from '../context/OrderContext'

const ROLE_COLOR = '#2441E5'
const Q = {
  card:'#ffffff', border:'#DDE3EC', text:'#12284C',
  muted:'#5C6E8C', faint:'#9AA8BF', bg:'#F3F5F8',
}

// Role queues in pipeline order. Each key doubles as the order's person field.
const STAGES = [
  { key:'screener', label:'Screener' },
  { key:'examiner', label:'Examiner' },
  { key:'typer',    label:'Typer' },
  { key:'delivery', label:'Delivery' },
]
// Assignable queues: the four pipeline stages, plus the Single Seating desk
// which works whichever stage is next (each step returns here for approval).
const QUEUES = [...STAGES, { key:'operator', label:'Single Seating' }]

// Pre-select the queue that naturally owns the order's current status.
const defaultStageFor = (status) => ({
  received:  'screener', screening: 'screener',
  searching: 'examiner', examining: 'examiner',
  typing:    'typer',    delivered: 'delivery',
}[status] || '')

export default function AssignModal({ order, user, onClose }) {
  const { assignOrder } = useOrders()
  // Single Seating orders default back to that desk on every approval so the
  // same desk carries them start to finish. Otherwise default to the next role
  // that still needs to act, then the status-based guess. 'admin' means the
  // order is parked here for approval — not a real queue.
  const [queue, setQueue]           = useState(
    (order.workflow?.singleSeating ? 'operator' : null)
    || (order.assignedTo && order.assignedTo !== 'admin' ? order.assignedTo : null)
    || nextRoleFor(order) || defaultStageFor(order.status))
  const [personName, setPersonName] = useState('')

  const people = USERS.filter(u => u.role === queue)
  const cd = order.completedDates || {}
  const cb = order.completedBy || {}

  // Stages run in a fixed order, so a stage BEYOND the next one that still needs
  // to act cannot be assigned: skipping typing and going straight to delivery left
  // the order with a delivery stamp but no commitment, and it could never finish.
  // Earlier stages stay open — sending work back for rework is legitimate.
  const nextIdx = STAGES.findIndex(s => s.key === nextRoleFor(order))
  const skipsAhead = (key) => {
    const i = STAGES.findIndex(s => s.key === key)
    return i !== -1 && nextIdx !== -1 && i > nextIdx
  }
  const blockedLabel = nextIdx === -1 ? '' : STAGES[nextIdx].label

  const pickQueue = (key) => { setQueue(key); setPersonName('') }   // reset pin on stage change

  const confirm = () => {
    if (!queue) return
    assignOrder(order.id, { queue, personName: personName || undefined })
    onClose()
  }

  const radioStyle = (active) => ({
    flex:1, padding:'10px 8px', borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer',
    textAlign:'center', transition:'all 0.15s',
    background: active ? `${ROLE_COLOR}14` : Q.bg,
    color:      active ? ROLE_COLOR : Q.muted,
    border:     active ? `1px solid ${ROLE_COLOR}` : `1px solid ${Q.border}`,
  })

  const selectStyle = {
    width:'100%', padding:'9px 11px', borderRadius:8, border:`1px solid ${Q.border}`,
    background:Q.bg, color:Q.text, fontSize:13, outline:'none',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background:'rgba(12,29,56,0.45)' }} onClick={onClose}>
      <motion.div initial={{ scale:0.96, opacity:0 }} animate={{ scale:1, opacity:1 }}
        onClick={e => e.stopPropagation()}
        style={{ background:Q.card, borderRadius:12, width:'100%', maxWidth:480,
          maxHeight:'88vh', overflowY:'auto', boxShadow:'0 20px 50px rgba(0,0,0,0.25)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between',
          padding:'18px 22px', borderBottom:`1px solid ${Q.border}` }}>
          <div>
            <div style={{ fontFamily:'monospace', fontWeight:700, fontSize:13, color:ROLE_COLOR }}>{order.id}</div>
            <div style={{ fontSize:18, fontWeight:700, color:Q.text }}>{displayClient(order, user)}</div>
            <div style={{ fontSize:12, color:Q.muted }}>{order.type} · {order.county}, {order.state}</div>
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', cursor:'pointer', color:Q.faint }}>
            <X style={{ width:18, height:18 }} />
          </button>
        </div>

        <div style={{ padding:'18px 22px' }}>
          {/* Stage */}
          <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
            letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Stage</label>
          <div style={{ display:'flex', gap:8, marginBottom:18, flexWrap:'wrap' }}>
            {QUEUES.map(s => {
              const blocked = skipsAhead(s.key)
              return (
                <button key={s.key} onClick={() => !blocked && pickQueue(s.key)} disabled={blocked}
                  title={blocked ? `${blockedLabel} has not completed yet — stages run in order.` : undefined}
                  style={{ ...radioStyle(queue === s.key), ...(blocked ? { opacity:0.4, cursor:'not-allowed' } : null) }}>
                  {s.label}
                </button>
              )
            })}
          </div>
          {nextIdx !== -1 && (
            <div style={{ fontSize:12, color:Q.muted, marginTop:-10, marginBottom:18 }}>
              Next stage due: <span style={{ color:ROLE_COLOR, fontWeight:600 }}>{blockedLabel}</span>. Later stages unlock once it is complete.
            </div>
          )}

          {/* Person */}
          <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
            letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Person</label>
          <select style={selectStyle} value={personName} onChange={e => setPersonName(e.target.value)}>
            <option value="">Any available</option>
            {people.map(u => <option key={u.id} value={u.name}>{u.name}</option>)}
          </select>

          {/* Per-stage completion history */}
          <div style={{ marginTop:18, background:Q.bg, border:`1px solid ${Q.border}`,
            borderRadius:10, padding:'12px 14px' }}>
            <div style={{ fontSize:11, fontWeight:600, textTransform:'uppercase',
              letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Completed stages</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 16px', fontSize:13 }}>
              {STAGES.map(s => (
                <div key={s.key}>
                  <span style={{ color:Q.faint }}>{s.label}: </span>
                  <span style={{ color: cd[s.key] ? '#16a34a' : Q.muted, fontWeight: cd[s.key] ? 600 : 400 }}>
                    {cd[s.key] ? `${cd[s.key]}${cb[s.key] ? ` · ${cb[s.key]}` : ''}` : 'Pending'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div style={{ display:'flex', gap:10, padding:'0 22px 20px' }}>
          <button onClick={confirm} disabled={!queue}
            style={{ flex:1, padding:'10px', background: queue ? ROLE_COLOR : Q.border, border:'none',
              borderRadius:8, color:'#fff', fontSize:13, fontWeight:600,
              cursor: queue ? 'pointer' : 'not-allowed',
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <UserCheck style={{ width:15, height:15 }} /> Confirm Assignment
          </button>
          <button onClick={onClose} style={{ padding:'10px 18px', background:Q.bg,
            border:`1px solid ${Q.border}`, borderRadius:8, color:Q.muted, fontSize:13, fontWeight:600, cursor:'pointer' }}>
            Cancel
          </button>
        </div>
      </motion.div>
    </div>
  )
}
