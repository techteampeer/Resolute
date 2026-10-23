import React, { useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Route, User, AlertTriangle, Info } from 'lucide-react'
import {
  displayClient, nextRoleFor, activeCountForUser, workloadWeight,
  stagePlanOf, isSingleSeatingPlan, ROLE_SEQUENCE, OPTIONAL_STAGES,
} from '../data/mockData'
import { useOrders } from '../context/OrderContext'
import { useProfiles } from '../lib/useProfiles'

const ROLE_COLOR = '#2441E5'
const Q = { card:'#ffffff', border:'#DDE3EC', text:'#12284C', muted:'#5C6E8C', faint:'#9AA8BF', bg:'#F3F5F8' }

const STAGES = [
  { key:'screener', label:'Screener',  hint:'Opens the title search' },
  { key:'examiner', label:'Examiner',  hint:'Researches & examines' },
  { key:'searchqc', label:'Search QC', hint:'Reviews before typing · optional' },
  { key:'typer',    label:'Typer',     hint:'Types the commitment' },
  { key:'qc',       label:'Typing QC', hint:'Reviews before delivery · optional' },
  { key:'delivery', label:'Delivery',  hint:'Delivers to the client' },
]

// Admin sets an order's COURSE OF FLOW once (E2): who works each stage. Pick one
// person end-to-end (single seating), or a different person per stage. From then
// on, completing a stage routes the order straight to the next person here — the
// production team never passes orders around themselves (the anti-bias rule,
// enforced by the DB guard). This replaces the old single-owner Assign modal.
export default function StagePlanModal({ order, user, onClose }) {
  const { setStagePlan, orders } = useOrders()
  const profiles = useProfiles()

  const team = useMemo(() => profiles
    .filter(p => p.role === 'user' && (p.status || 'active') === 'active')
    .map(p => ({ ...p, load: activeCountForUser(orders, p.id) }))
    .sort((a, b) => a.load - b.load), [profiles, orders])

  const existing = stagePlanOf(order)
  const planWasSet = ROLE_SEQUENCE.some(r => existing[r])
  const lightestId = team[0]?.id ?? ''

  // Seed from the current plan, else default to single seating on the lightest
  // queue — the common case, and the mode the portal used before per-stage plans.
  const [single, setSingle] = useState(planWasSet ? isSingleSeatingPlan(order) : true)
  const [onePerson, setOnePerson] = useState(
    planWasSet && isSingleSeatingPlan(order) ? existing.screener : lightestId)
  const [perStage, setPerStage] = useState({
    screener: existing.screener || '', examiner: existing.examiner || '', searchqc: existing.searchqc || '',
    typer:    existing.typer    || '', qc: existing.qc || '', delivery: existing.delivery || '',
  })

  const due = nextRoleFor(order)
  const dueLabel = (STAGES.find(s => s.key === due) || {}).label || ''

  // The plan to save, and whether the stage currently due even has an owner (if
  // not, the order parks with Admin rather than moving — flag that up front).
  // QC is optional: single-seating assigns one person to the required stages and
  // skips QC (an empty QC slot = no QC gate); stage-by-stage lets an admin add a
  // QC reviewer. The completeness check therefore ignores optional stages.
  const required = ROLE_SEQUENCE.filter(r => !OPTIONAL_STAGES.includes(r))
  const plan = single
    ? Object.fromEntries(ROLE_SEQUENCE.map(r => [r, OPTIONAL_STAGES.includes(r) ? null : (onePerson || null)]))
    : Object.fromEntries(ROLE_SEQUENCE.map(r => [r, perStage[r] || null]))
  const dueHasOwner = due ? !!plan[due] : true
  const complete = single ? !!onePerson : required.every(r => !!perStage[r])

  const nameFor = (id) => team.find(t => t.id === id)?.name || '—'

  // Portal orders are priced at placement, so the "no agreed price" nudge is only
  // meaningful for the negotiated mail/website path.
  const isPortal = order.workflow?.intake?.source === 'web'
  const noPrice = !isPortal && order.workflow?.invoiceAmount == null
  const noDate  = !isPortal && !order.eta
  const unpriced = [noPrice ? 'agreed price' : null, noDate ? 'committed date' : null].filter(Boolean)

  const save = () => {
    if (!complete) return
    setStagePlan(order.id, { singleSeating: single, plan }, user?.name)
    onClose()
  }

  const personSelect = (value, onChange, { allowNone = false, noneLabel } = {}) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      style={{ width:'100%', padding:'9px 11px', borderRadius:8, border:`1px solid ${Q.border}`,
        background:'#fff', color:value ? Q.text : Q.faint, fontSize:13, fontWeight:500, cursor:'pointer' }}>
      <option value="">{noneLabel || (allowNone ? '— leave for Admin to assign' : 'Select a person…')}</option>
      {team.map(p => (
        <option key={p.id} value={p.id}>{p.name} · {p.load} active</option>
      ))}
    </select>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background:'rgba(12,29,56,0.45)' }} onClick={onClose}>
      <motion.div initial={{ scale:0.96, opacity:0 }} animate={{ scale:1, opacity:1 }}
        onClick={e => e.stopPropagation()}
        style={{ background:Q.card, borderRadius:12, width:'100%', maxWidth:520,
          maxHeight:'90vh', overflowY:'auto', boxShadow:'0 20px 50px rgba(0,0,0,0.25)' }}>

        {/* Header */}
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between',
          padding:'18px 22px', borderBottom:`1px solid ${Q.border}` }}>
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:7, fontFamily:'monospace', fontWeight:700, fontSize:13, color:ROLE_COLOR }}>
              <Route style={{ width:15, height:15 }} /> {order.id}
            </div>
            <div style={{ fontSize:18, fontWeight:700, color:Q.text }}>{displayClient(order, user)}</div>
            <div style={{ fontSize:12, color:Q.muted }}>
              {order.type} · {order.county}, {order.state}
              {workloadWeight(order) > 1 && <span style={{ color:ROLE_COLOR, fontWeight:600 }}> · {workloadWeight(order)} searches</span>}
            </div>
          </div>
          <button onClick={onClose} style={{ background:'transparent', border:'none', cursor:'pointer', color:Q.faint }}>
            <X style={{ width:18, height:18 }} />
          </button>
        </div>

        <div style={{ padding:'18px 22px' }}>
          <p style={{ fontSize:12.5, lineHeight:1.5, color:Q.muted, marginBottom:16 }}>
            Set who works this order, once. Each stage completes and hands the order
            straight to the next person below — no step back through you.
          </p>

          {unpriced.length > 0 && (
            <div style={{ display:'flex', gap:8, alignItems:'flex-start', marginBottom:16,
              padding:'10px 12px', borderRadius:8, background:'#fffbeb', border:'1px solid #fde68a' }}>
              <AlertTriangle style={{ width:15, height:15, color:'#a16207', flexShrink:0, marginTop:1 }} />
              <div style={{ fontSize:12, lineHeight:1.5, color:'#a16207' }}>
                No {unpriced.join(' and ')} yet — set it from the order’s “{order.status === 'received' ? 'Confirm & price order' : 'Set price & date'}”.
              </div>
            </div>
          )}

          {/* Mode toggle */}
          <div style={{ display:'flex', gap:8, marginBottom:18 }}>
            {[['single', 'Single seating', 'One person, end to end'],
              ['stages', 'Stage by stage', 'A person for each stage']].map(([k, title, sub]) => {
              const on = (k === 'single') === single
              return (
                <button key={k} onClick={() => setSingle(k === 'single')}
                  style={{ flex:1, textAlign:'left', padding:'11px 13px', borderRadius:10, cursor:'pointer',
                    background: on ? `${ROLE_COLOR}12` : Q.bg,
                    border: on ? `1.5px solid ${ROLE_COLOR}` : `1px solid ${Q.border}` }}>
                  <div style={{ fontSize:13.5, fontWeight:700, color: on ? ROLE_COLOR : Q.text }}>{title}</div>
                  <div style={{ fontSize:11.5, color:Q.muted, marginTop:1 }}>{sub}</div>
                </button>
              )
            })}
          </div>

          {team.length === 0 && (
            <div style={{ fontSize:13, color:Q.muted, padding:'12px 0' }}>Loading the team…</div>
          )}

          {single ? (
            <div>
              <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
                letterSpacing:'0.05em', color:Q.faint, marginBottom:8 }}>Assign to</label>
              {personSelect(onePerson, setOnePerson)}
              <div style={{ display:'flex', alignItems:'center', gap:6, marginTop:10, fontSize:12, color:Q.muted }}>
                <User style={{ width:13, height:13, color:Q.faint }} />
                {onePerson ? `${nameFor(onePerson)} will carry ${order.id} through all four stages.` : 'Pick the teammate who handles this order end to end.'}
              </div>
            </div>
          ) : (
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {STAGES.map((s, i) => (
                <div key={s.key}>
                  <label style={{ display:'flex', justifyContent:'space-between', alignItems:'baseline',
                    fontSize:11, fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em',
                    color: due === s.key ? ROLE_COLOR : Q.faint, marginBottom:6 }}>
                    <span>{i + 1}. {s.label}{due === s.key && ' · due now'}</span>
                    <span style={{ textTransform:'none', letterSpacing:0, fontWeight:500, color:Q.faint }}>{s.hint}</span>
                  </label>
                  {personSelect(perStage[s.key], v => setPerStage(p => ({ ...p, [s.key]: v })),
                    { allowNone: true, noneLabel: OPTIONAL_STAGES.includes(s.key) ? `— none (skip ${s.label})` : undefined })}
                </div>
              ))}
            </div>
          )}

          {/* Where this order goes the moment you save */}
          {complete && (
            <div style={{ display:'flex', gap:8, alignItems:'flex-start', marginTop:16,
              padding:'10px 12px', borderRadius:8,
              background: dueHasOwner ? 'rgba(36,65,229,0.06)' : '#fffbeb',
              border: dueHasOwner ? '1px solid rgba(36,65,229,0.18)' : '1px solid #fde68a' }}>
              <Info style={{ width:15, height:15, color: dueHasOwner ? ROLE_COLOR : '#a16207', flexShrink:0, marginTop:1 }} />
              <div style={{ fontSize:12, lineHeight:1.5, color: dueHasOwner ? Q.text : '#a16207' }}>
                {dueHasOwner
                  ? <>On save, {order.id} goes to <strong>{nameFor(plan[due])}</strong> for the <strong>{dueLabel}</strong> stage.</>
                  : <>The {dueLabel} stage (due now) has no one assigned — the order will park with Admin until you assign it.</>}
              </div>
            </div>
          )}
        </div>

        <div style={{ display:'flex', gap:10, padding:'0 22px 20px' }}>
          <button onClick={save} disabled={!complete}
            style={{ flex:1, padding:'10px', background: complete ? ROLE_COLOR : Q.border, border:'none',
              borderRadius:8, color:'#fff', fontSize:13, fontWeight:600,
              cursor: complete ? 'pointer' : 'not-allowed',
              display:'flex', alignItems:'center', justifyContent:'center', gap:6 }}>
            <Route style={{ width:15, height:15 }} /> {planWasSet ? 'Update plan' : 'Set plan & route'}
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
