import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { X, UserCheck, AlertTriangle } from 'lucide-react'
import { displayClient, nextRoleFor, activeCountForUser, workloadWeight } from '../data/mockData'
import { useOrders } from '../context/OrderContext'
import { useProfiles } from '../lib/useProfiles'

const ROLE_COLOR = '#2441E5'
const Q = {
  card:'#ffffff', border:'#DDE3EC', text:'#12284C',
  muted:'#5C6E8C', faint:'#9AA8BF', bg:'#F3F5F8',
}

const STAGES = [
  { key:'screener', label:'Screener' },
  { key:'examiner', label:'Examiner' },
  { key:'typer',    label:'Typer' },
  { key:'delivery', label:'Delivery' },
]

const initials = (name = '') =>
  name.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'

// Admin routes an order to a specific production person (post-D3 single seating):
// pick the teammate who will carry it end to end. Each teammate shows their live
// workload so Admin can balance; the lightest queue is suggested.
export default function AssignModal({ order, user, onClose }) {
  const { assignOrder, reassign, orders } = useOrders()
  const profiles = useProfiles()

  // The production roster + each person's current active-order count.
  const team = profiles
    .filter(p => p.role === 'user' && (p.status || 'active') === 'active')
    .map(p => ({ ...p, load: activeCountForUser(orders, p.id) }))
    .sort((a, b) => a.load - b.load)
  const lightest = team.length ? team[0].load : 0

  const alreadyOwned = order.assignedTo === 'user' && order.assignedUserId != null
  // Default the selection to the current owner (reassign) or the lightest queue.
  const [selectedId, setSelectedId] = useState(
    alreadyOwned ? order.assignedUserId : (team[0]?.id ?? null),
  )

  const cd = order.completedDates || {}
  const cb = order.completedBy || {}
  const nextRole = nextRoleFor(order)
  const blockedLabel = (STAGES.find(s => s.key === nextRole) || {}).label || ''

  const noPrice = order.workflow?.invoiceAmount == null
  const noDate  = !order.eta
  const unpriced = [noPrice ? 'agreed price' : null, noDate ? 'committed date' : null].filter(Boolean)
  const consequence = [
    noPrice ? 'it cannot be invoiced' : null,
    noDate ? 'the client is shown no delivery date' : null,
  ].filter(Boolean).join(' and ')

  const confirm = () => {
    if (selectedId == null) return
    const person = team.find(t => t.id === selectedId)
    const name = person?.name
    // Reassigning an already-owned order to a different person is a distinct
    // action (clearer audit); a fresh assignment routes it into the pool.
    if (alreadyOwned && selectedId !== order.assignedUserId) reassign(order.id, selectedId, name)
    else assignOrder(order.id, { queue: 'user', userId: selectedId, personName: name })
    onClose()
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
            <div style={{ fontSize:12, color:Q.muted }}>
              {order.type} · {order.county}, {order.state}
              {workloadWeight(order) > 1 && <span style={{ color:ROLE_COLOR, fontWeight:600 }}> · {workloadWeight(order)} searches (weighs {workloadWeight(order)})</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', cursor:'pointer', color:Q.faint }}>
            <X style={{ width:18, height:18 }} />
          </button>
        </div>

        <div style={{ padding:'18px 22px' }}>
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

          <label style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline',
            fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em',
            color:Q.faint, marginBottom:8 }}>
            <span>{alreadyOwned ? 'Reassign to' : 'Assign to'}</span>
            {nextRole && <span style={{ textTransform:'none', letterSpacing:0, fontWeight:500 }}>Next stage: {blockedLabel}</span>}
          </label>

          {team.length === 0 && (
            <div style={{ fontSize:13, color:Q.muted, padding:'12px 0' }}>Loading the team…</div>
          )}

          <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
            {team.map(p => {
              const active = p.id === selectedId
              const isLightest = p.load === lightest
              return (
                <button key={p.id} onClick={() => setSelectedId(p.id)}
                  style={{ display:'flex', alignItems:'center', gap:12, width:'100%', textAlign:'left',
                    padding:'11px 13px', borderRadius:10, cursor:'pointer', transition:'all 0.15s',
                    background: active ? `${ROLE_COLOR}14` : Q.bg,
                    border: active ? `1px solid ${ROLE_COLOR}` : `1px solid ${Q.border}` }}>
                  <span style={{ width:34, height:34, borderRadius:'50%', flexShrink:0, display:'grid',
                    placeItems:'center', fontSize:13, fontWeight:700, color:'#fff', background:ROLE_COLOR }}>
                    {initials(p.name)}
                  </span>
                  <span style={{ flex:1, minWidth:0 }}>
                    <span style={{ display:'flex', alignItems:'center', gap:7, fontSize:14, fontWeight:600, color:Q.text }}>
                      {p.name}
                      {isLightest && (
                        <span style={{ fontSize:9.5, fontWeight:700, letterSpacing:'0.04em', textTransform:'uppercase',
                          color:'#16a34a', background:'#dcfce7', padding:'2px 6px', borderRadius:5 }}>Lightest</span>
                      )}
                      {order.assignedUserId === p.id && (
                        <span style={{ fontSize:10, fontWeight:600, color:Q.faint }}>· current</span>
                      )}
                    </span>
                    <span style={{ fontSize:12, color: active ? ROLE_COLOR : Q.muted }}>
                      {p.load} active search{p.load === 1 ? '' : 'es'}
                    </span>
                  </span>
                  {active && <UserCheck style={{ width:16, height:16, color:ROLE_COLOR, flexShrink:0 }} />}
                </button>
              )
            })}
          </div>

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
          <button onClick={confirm} disabled={selectedId == null}
            style={{ flex:1, padding:'10px', background: selectedId != null ? ROLE_COLOR : Q.border, border:'none',
              borderRadius:8, color:'#fff', fontSize:13, fontWeight:600,
              cursor: selectedId != null ? 'pointer' : 'not-allowed',
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <UserCheck style={{ width:15, height:15 }} /> {alreadyOwned ? 'Reassign' : 'Assign'}
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
