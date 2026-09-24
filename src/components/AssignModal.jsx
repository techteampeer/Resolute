import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { X, UserCheck, AlertTriangle } from 'lucide-react'
import { displayClient, nextRoleFor } from '../data/mockData'
import { useProfiles, namesForRole } from '../lib/useProfiles'
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
const STAGE_KEYS = STAGES.map(s => s.key)
// The consolidated production desk (ADR 0001). Post-D2 this is the STANDARD
// place an order is worked: one desk carries it through whichever stage is next,
// returning to Admin for approval between each. The four stage desks below it
// remain only as a transitional route to a not-yet-migrated stage account
// (retired in D3).
const PRODUCTION = { key:'user', label:'Production Desk' }

export default function AssignModal({ order, user, onClose }) {
  const { assignOrder } = useOrders()
  // The Production desk is now the standard target (ADR 0001 · D2): a fresh or
  // Admin-parked order defaults there and one desk carries it start to finish,
  // returning here for approval between stages. An order already on a legacy
  // stage desk stays on it (so a mid-flight, not-yet-migrated assignment isn't
  // silently re-routed); everything else defaults to Production. 'admin' means
  // parked for approval — not a real queue.
  const [queue, setQueue]           = useState(
    order.workflow?.singleSeating ? 'user'
    : (STAGE_KEYS.includes(order.assignedTo) ? order.assignedTo : 'user'))
  const [personName, setPersonName] = useState('')

  // Real staff only. This filtered mockData's USERS fixture, which offers six
  // people who have no profiles row and no login, so Admin could assign an order
  // to someone who does not exist and the row recorded their name.
  const people = namesForRole(useProfiles(), queue)
  const cd = order.completedDates || {}
  const cb = order.completedBy || {}

  // The stage the order is currently waiting on, shown on the Production Desk
  // option so Admin sees which phase a `user` will pick up next.
  const nextIdx = STAGES.findIndex(s => s.key === nextRoleFor(order))
  const blockedLabel = nextIdx === -1 ? '' : STAGES[nextIdx].label

  const pickQueue = (key) => { setQueue(key); setPersonName('') }   // reset pin on stage change

  const noPrice = order.workflow?.invoiceAmount == null
  const noDate  = !order.eta
  const unpriced = [noPrice ? 'agreed price' : null, noDate ? 'committed date' : null].filter(Boolean)
  const consequence = [
    noPrice ? 'it cannot be invoiced' : null,
    noDate ? 'the client is shown no delivery date' : null,
  ].filter(Boolean).join(' and ')

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
          {/* Nothing forces Admin to confirm an order before routing it, and an
              unconfirmed order has no agreed price and no committed date: driving
              one straight from placement to delivery left invoiceAmount unset
              until the typer stamped it, and eta NULL the whole way, so the
              client's card read "ETA: to be confirmed" from start to finish.
              Say so here, where the routing decision is actually made. */}
          {unpriced.length > 0 && (
            <div style={{ display:'flex', gap:8, alignItems:'flex-start', marginBottom:16,
              padding:'10px 12px', borderRadius:8, background:'#fffbeb', border:'1px solid #fde68a' }}>
              <AlertTriangle style={{ width:15, height:15, color:'#a16207', flexShrink:0, marginTop:1 }} />
              <div style={{ fontSize:12, lineHeight:1.5, color:'#a16207' }}>
                This order has no {unpriced.join(' and ')} yet. Open it and use
                “{order.status === 'received' ? 'Confirm & price order' : 'Set price & date'}” —
                until then {consequence}.
              </div>
            </div>
          )}
          {/* Desk — the Production desk is the standard target; one desk carries
              the order through whichever stage is next. */}
          <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
            letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Desk</label>
          <button onClick={() => pickQueue(PRODUCTION.key)}
            style={{ ...radioStyle(queue === PRODUCTION.key), width:'100%', textAlign:'left',
              display:'flex', alignItems:'center', gap:10, padding:'12px 14px', marginBottom:12 }}>
            <UserCheck style={{ width:16, height:16, flexShrink:0 }} />
            <span style={{ display:'flex', flexDirection:'column', alignItems:'flex-start' }}>
              <span>{PRODUCTION.label} <span style={{ fontSize:11, fontWeight:600, opacity:0.7 }}>· standard</span></span>
              <span style={{ fontSize:11, fontWeight:400, color: queue === PRODUCTION.key ? ROLE_COLOR : Q.muted }}>
                {nextIdx !== -1 ? `Works the next stage (${blockedLabel}), then returns for approval` : 'Works the order end to end, with approval between stages'}
              </span>
            </span>
          </button>

          {/* The four stage desks were retired in D3 (ADR 0001) — there are no
              stage-role accounts to service them, so routing an order to one
              would strand it under the new RLS. The Production Desk is the only
              production owner; it works whichever stage is next. */}

          {/* Person */}
          <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
            letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Person</label>
          <select style={selectStyle} value={personName} onChange={e => setPersonName(e.target.value)}>
            <option value="">Any available</option>
            {people.map(n => <option key={n} value={n}>{n}</option>)}
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
