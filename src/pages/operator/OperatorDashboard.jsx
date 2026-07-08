import React, { useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import DocUpload from '../../components/DocUpload'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { displayClient, nextRoleFor } from '../../data/mockData'
import { LayoutDashboard, Layers, CheckCircle, X, Send, ChevronRight, FileText, Keyboard } from 'lucide-react'
import FulfillmentScreen from '../typer/fulfillment/FulfillmentScreen'
import AttachedDocs from '../../components/AttachedDocs'

const ROLE_COLOR = '#0f766e'
const NAV = [
  { path: '/operator',          label: 'Dashboard', icon: LayoutDashboard },
  { path: '/operator/completed',label: 'Completed', icon: CheckCircle },
]

// Stage each order is currently waiting on (first uncompleted production role).
const STAGE = {
  screener: { label: 'Screening',   color: '#4d7c2f', verb: 'Screen & assign' },
  examiner: { label: 'Examination', color: '#a16207', verb: 'Examine & upload' },
  typer:    { label: 'Typing',      color: '#0e7490', verb: 'Type commitment' },
  delivery: { label: 'Delivery',    color: '#b45309', verb: 'Deliver to client' },
}
const ASSIGN = [['in_house', 'In-House'], ['abs', 'ABS (Abstract)'], ['both', 'Both']]

// One adaptive modal that runs whichever stage the order is currently in.
function StageModal({ order, onClose }) {
  const { user } = useAuth()
  const { completeStep, returnToAdmin, updateOrder } = useOrders()
  const navigate = useNavigate()
  const role = nextRoleFor(order)
  const meta = STAGE[role] || {}

  const [assignment, setAssignment] = useState(order.workflow?.searchAssignment || null)
  const [doc, setDoc] = useState(role === 'examiner' ? (order.workflow?.examinerDoc || null) : (order.workflow?.screenerDoc || null))
  const [method, setMethod] = useState(order.workflow?.deliveryMethod || 'email')
  const [notes, setNotes] = useState('')

  // Every step hands back to Admin for approval (same as the separate portals).
  // Delivery is the final stage — completing it delivers the order outright.
  const advance = (workflowPatch) => {
    if (role === 'delivery') {
      if (workflowPatch) updateOrder({ ...order, workflow: { ...order.workflow, ...workflowPatch } })
      completeStep(order.id, role, user?.name, notes || 'single seating')
    } else {
      returnToAdmin(order.id, role, user?.name, notes || 'single seating', workflowPatch || {})
    }
    onClose()
  }

  const canSubmit =
    role === 'screener' ? !!assignment
    : role === 'examiner' ? !!(doc && doc.status === 'done')
    : true

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: 'rgba(0,0,0,0.65)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="glass-card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-5">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{order.id}</span>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md"
                style={{ background: `${meta.color}22`, color: meta.color }}>{meta.label}</span>
            </div>
            <div className="text-lg font-bold mt-0.5" style={{ color: '#1e293b' }}>{displayClient(order.client, user)}</div>
            <div className="text-xs" style={{ color: '#64748b' }}>{order.type} · {order.state}, {order.county} County</div>
          </div>
          <button onClick={onClose} style={{ color: '#64748b' }}><X className="w-5 h-5" /></button>
        </div>

        {(order.workflow?.screenerDoc || order.workflow?.examinerDoc) && (
          <div className="mb-4"><AttachedDocs workflow={order.workflow} /></div>
        )}

        {/* Screening */}
        {role === 'screener' && (
          <>
            <Lbl>Assign Search To</Lbl>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-4">
              {ASSIGN.map(([k, l]) => (
                <button key={k} onClick={() => setAssignment(k)}
                  className="py-2.5 rounded-lg text-xs font-semibold transition-all"
                  style={assignment === k
                    ? { background: `${ROLE_COLOR}28`, color: ROLE_COLOR, border: `1px solid ${ROLE_COLOR}55` }
                    : { background: 'rgba(30,41,59,0.05)', color: '#64748b', border: '1px solid rgba(30,41,59,0.08)' }}>
                  {l}
                </button>
              ))}
            </div>
            <Lbl>Search Document <span style={{ textTransform: 'none', opacity: 0.6 }}>(optional)</span></Lbl>
            <div className="mb-4"><DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} /></div>
          </>
        )}

        {/* Examination */}
        {role === 'examiner' && (
          <>
            <Lbl>Researched Document <span style={{ textTransform: 'none', color: '#dc2626' }}>*required</span></Lbl>
            <div className="mb-4"><DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} /></div>
          </>
        )}

        {/* Typing — hand off to the full fulfillment screen */}
        {role === 'typer' && (
          <div className="mb-4 p-4 rounded-xl" style={{ background: 'rgba(62,158,196,0.10)', border: '1px solid rgba(62,158,196,0.25)' }}>
            <div className="flex items-center gap-2 mb-1"><Keyboard className="w-4 h-4" style={{ color: '#0e7490' }} />
              <span className="font-semibold text-sm" style={{ color: '#1e293b' }}>Type the commitment</span></div>
            <p className="text-xs mb-3" style={{ color: '#475569' }}>Opens the full sectioned fulfillment form. Submitting there sends the order to Admin for approval.</p>
            <button onClick={() => { onClose(); navigate(`/operator/order/${order.id}`) }}
              className="btn-primary text-sm py-2.5 w-full flex items-center justify-center gap-2">
              <FileText className="w-4 h-4" /> Open Fulfillment Form
            </button>
          </div>
        )}

        {/* Delivery */}
        {role === 'delivery' && (
          <>
            <Lbl>Delivery Method</Lbl>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
              {[['email', 'Email'], ['portal', 'Client Portal']].map(([k, l]) => (
                <button key={k} onClick={() => setMethod(k)}
                  className="py-2.5 rounded-xl text-sm font-medium transition-all border"
                  style={method === k
                    ? { background: `${ROLE_COLOR}22`, border: `1px solid ${ROLE_COLOR}55`, color: '#1e293b' }
                    : { border: '1px solid rgba(30,41,59,0.08)', color: '#64748b' }}>
                  {l}
                </button>
              ))}
            </div>
            <p className="text-[11px] mb-4" style={{ color: '#64748b' }}>
              {method === 'email' ? 'Full package + invoice emailed to the client.' : 'Package posted to the client portal; invoice reflected there.'}
            </p>
          </>
        )}

        {role !== 'typer' && (
          <>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              placeholder="Notes (optional)…" className="input-field text-sm mb-4 resize-none" />
            <button disabled={!canSubmit}
              onClick={() => advance(
                role === 'screener' ? { searchAssignment: assignment, screenerDoc: doc }
                : role === 'examiner' ? { examinerDoc: doc }
                : role === 'delivery' ? { deliveryMethod: method, invoiceVisibleToClient: method === 'portal' }
                : null)}
              className="btn-primary w-full text-sm py-2.5 flex items-center justify-center gap-2"
              style={{ opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
              <Send className="w-4 h-4" /> {role === 'delivery' ? `${meta.verb} & Complete` : `${meta.verb} & Send to Admin`}
            </button>
          </>
        )}
      </motion.div>
    </div>
  )
}

const Lbl = ({ children }) => (
  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#64748b' }}>{children}</label>
)

// The Single Seating desk only works the four production stages. Orders parked
// with Admin (or not yet routed by Admin) are read-only until Admin approves.
const WORKABLE_QUEUES = ['screener', 'examiner', 'typer', 'delivery', 'operator']

function OperatorHome() {
  const { user } = useAuth()
  const { orders } = useOrders()
  const [selected, setSelected] = useState(null)
  const active = orders.filter(o => o.status !== 'delivered' && nextRoleFor(o))
  const actionable = active.filter(o => WORKABLE_QUEUES.includes(o.assignedTo))
  const awaiting   = active.filter(o => !WORKABLE_QUEUES.includes(o.assignedTo))
  const byStage = (r) => actionable.filter(o => nextRoleFor(o) === r).length

  return (
    <div className="space-y-6">
      {selected && <StageModal order={selected} onClose={() => setSelected(null)} />}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>Single Seating Workspace</h1>
        <p className="text-sm" style={{ color: '#475569' }}>Work every stage — screening through delivery — with Admin approval after each step</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Object.entries(STAGE).map(([r, s]) => (
          <motion.div key={r} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background: `${s.color}22` }}>
              <Layers className="w-4 h-4" style={{ color: s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color: '#1e293b' }}>{byStage(r)}</div>
            <div className="text-sm" style={{ color: '#475569' }}>In {s.label}</div>
          </motion.div>
        ))}
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color: '#1e293b' }}>Active Orders</h2>
        <div className="space-y-3">
          {actionable.map((o, i) => {
            const role = nextRoleFor(o)
            const s = STAGE[role] || {}
            return (
              <motion.div key={o.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
                style={{ background: 'rgba(30,41,59,0.03)', border: '1px solid rgba(138,194,104,0.08)' }}
                onMouseOver={e => e.currentTarget.style.borderColor = `${s.color}55`}
                onMouseOut={e => e.currentTarget.style.borderColor = 'rgba(138,194,104,0.08)'}
                onClick={() => setSelected(o)}>
                <div className="w-2 h-10 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{o.id}</span>
                    {o.priority === 'rush' && <span className="text-xs font-semibold px-2 py-0.5 rounded-md" style={{ background: 'rgba(220,80,60,0.18)', color: '#dc2626' }}>RUSH</span>}
                  </div>
                  <div className="font-medium text-sm mt-0.5 truncate" style={{ color: '#1e293b' }}>{displayClient(o.client, user)}</div>
                  <div className="text-xs" style={{ color: '#64748b' }}>{o.type} · {o.state}, {o.county}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: `${s.color}22`, color: s.color }}>{s.label}</span>
                  <div className="text-xs mt-1" style={{ color: '#64748b' }}>ETA {o.eta}</div>
                </div>
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(30,41,59,0.18)' }} />
              </motion.div>
            )
          })}
          {actionable.length === 0 && <div className="text-sm text-center py-6" style={{ color: '#64748b' }}>No active orders.</div>}
        </div>
      </div>

      {/* Steps completed here wait for Admin sign-off before the next stage unlocks. */}
      {awaiting.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-4" style={{ color: '#1e293b' }}>Awaiting Admin Approval</h2>
          <div className="space-y-3">
            {awaiting.map(o => {
              const s = STAGE[nextRoleFor(o)] || {}
              return (
                <div key={o.id} className="flex items-center gap-4 p-4 rounded-xl"
                  style={{ background: 'rgba(30,41,59,0.03)', border: '1px dashed rgba(30,41,59,0.15)', opacity: 0.75 }}>
                  <div className="w-2 h-10 rounded-full flex-shrink-0" style={{ background: '#94a3b8' }} />
                  <div className="flex-1 min-w-0">
                    <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{o.id}</span>
                    <div className="font-medium text-sm mt-0.5 truncate" style={{ color: '#1e293b' }}>{displayClient(o.client, user)}</div>
                    <div className="text-xs" style={{ color: '#64748b' }}>{o.type} · {o.state}, {o.county}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: 'rgba(30,41,59,0.08)', color: '#64748b' }}>
                      Awaiting Admin Approval
                    </span>
                    <div className="text-xs mt-1" style={{ color: '#64748b' }}>Next: {s.label || '—'}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

function CompletedList() {
  const { user } = useAuth()
  const { orders } = useOrders()
  const done = orders.filter(o => o.status === 'delivered')
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>Completed</h1>
      <div className="glass-card p-5 space-y-2">
        {done.map(o => (
          <div key={o.id} className="flex items-center gap-3 p-3 rounded-xl">
            <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#15803d' }} />
            <span className="font-mono text-xs" style={{ color: '#475569' }}>{o.id}</span>
            <span className="text-xs flex-1 truncate" style={{ color: '#475569' }}>{displayClient(o.client, user)}</span>
            <span className="text-xs" style={{ color: '#64748b' }}>{o.completed || o.eta}</span>
          </div>
        ))}
        {done.length === 0 && <div className="text-sm text-center py-6" style={{ color: '#64748b' }}>Nothing delivered yet.</div>}
      </div>
    </div>
  )
}

export default function OperatorDashboard() {
  return (
    <Layout navItems={NAV} role="single seating" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<OperatorHome />} />
        <Route path="order/:id" element={<FulfillmentScreen />} />
        <Route path="completed" element={<CompletedList />} />
      </Routes>
    </Layout>
  )
}
