import React, { useState } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import DocUpload from '../../components/DocUpload'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import { displayClient, nextRoleFor } from '../../data/mockData'
import { LayoutDashboard, Layers, CheckCircle, Send, ChevronRight, FileText, Keyboard, Clock, Inbox, Files } from 'lucide-react'
import FulfillmentScreen from '../typer/fulfillment/FulfillmentScreen'
import AttachedDocs from '../../components/AttachedDocs'
import OrderMessages from '../../components/OrderMessages'
import OrderDetailLayout, { DetailGrid, Panel, ActivityTab } from '../../components/OrderDetailLayout'

const ROLE_COLOR = '#2441E5'
const NAV = [
  { path: '/operator',          label: 'Dashboard', icon: LayoutDashboard },
  { path: '/operator/completed',label: 'Completed', icon: CheckCircle },
]

// Stage each order is currently waiting on (first uncompleted production role).
const STAGE = {
  screener: { label: 'Screening',   color: '#2441E5', verb: 'Screen & assign' },
  examiner: { label: 'Examination', color: '#a16207', verb: 'Examine & upload' },
  typer:    { label: 'Typing',      color: '#0e7490', verb: 'Type commitment' },
  delivery: { label: 'Delivery',    color: '#b45309', verb: 'Deliver to client' },
}
const ASSIGN = [['in_house', 'In-House'], ['abs', 'ABS (Abstract)'], ['both', 'Both']]

// Full-page order detail that adapts to whichever stage the order is in.
// Route: /operator/orders/:id  (the typing stage hands off to the full
// fulfillment screen at /operator/order/:id).
function OperatorOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, completeStep, returnToAdmin, updateOrder, activityLog = [] } = useOrders()
  const { getOrderThread, getOrderNotes } = useSupport()
  const order = orders.find(o => o.id === id)
  const role = order ? nextRoleFor(order) : null
  const meta = STAGE[role] || {}

  const [assignment, setAssignment] = useState(order?.workflow?.searchAssignment || null)
  const [doc, setDoc] = useState(role === 'examiner' ? (order?.workflow?.examinerDoc || null) : (order?.workflow?.screenerDoc || null))
  const [method, setMethod] = useState(order?.workflow?.deliveryMethod || 'email')
  const [notes, setNotes] = useState('')

  if (!order) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
      <div className="text-sm" style={{ color:'#5C6E8C' }}>Order not found, or it isn’t assigned to your desk.</div>
      <button onClick={() => navigate('/operator')} className="btn-primary text-sm px-5 py-2.5">Back to Workspace</button>
    </div>
  )

  // Every step hands back to Admin for approval. Delivery is the final stage —
  // completing it delivers the order outright.
  const advance = (workflowPatch) => {
    if (role === 'delivery') {
      if (workflowPatch) updateOrder({ ...order, workflow: { ...order.workflow, ...workflowPatch } })
      completeStep(order.id, role, user?.name, notes || 'single seating')
    } else {
      returnToAdmin(order.id, role, user?.name, notes || 'single seating', workflowPatch || {})
    }
    navigate('/operator')
  }
  const canSubmit = role === 'screener' ? !!assignment
    : role === 'examiner' ? !!(doc && doc.status === 'done')
    : true
  const msgCount = getOrderThread(order.id).length + getOrderNotes(order.id).length

  const TABS = [
    { key:'stage', label: meta.label || 'Stage', icon:Layers, render: () => (
      <div className="space-y-4">
        {role === 'screener' && (
          <>
            <Panel title="Assign search to">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {ASSIGN.map(([k, l]) => (
                  <button key={k} onClick={() => setAssignment(k)}
                    className="py-2.5 rounded-lg text-xs font-semibold transition-all"
                    style={assignment === k
                      ? { background: `${ROLE_COLOR}28`, color: ROLE_COLOR, border: `1px solid ${ROLE_COLOR}55` }
                      : { background: 'rgba(18,40,76,0.05)', color: '#5C6E8C', border: '1px solid rgba(18,40,76,0.08)' }}>
                    {l}
                  </button>
                ))}
              </div>
            </Panel>
            <Panel title="Search document" hint="Optional at this stage.">
              <DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} />
            </Panel>
          </>
        )}
        {role === 'examiner' && (
          <Panel title="Researched document" hint="Required before this order can go back to Admin.">
            <DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} />
          </Panel>
        )}
        {role === 'typer' && (
          <div className="p-4 rounded-xl" style={{ background: 'rgba(0,184,217,0.10)', border: '1px solid rgba(0,184,217,0.25)' }}>
            <div className="flex items-center gap-2 mb-1"><Keyboard className="w-4 h-4" style={{ color: '#0e7490' }} />
              <span className="font-semibold text-sm" style={{ color: '#12284C' }}>Type the commitment</span></div>
            <p className="text-xs mb-3" style={{ color: '#3D5171' }}>Opens the full sectioned fulfillment form. Submitting there sends the order to Admin for approval.</p>
            <button onClick={() => navigate(`/operator/order/${order.id}`)}
              className="btn-primary text-sm py-2.5 w-full flex items-center justify-center gap-2">
              <FileText className="w-4 h-4" /> Open Fulfillment Form
            </button>
          </div>
        )}
        {role === 'delivery' && (
          <Panel title="Delivery method">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {[['email', 'Email'], ['portal', 'Client Portal']].map(([k, l]) => (
                <button key={k} onClick={() => setMethod(k)}
                  className="py-2.5 rounded-xl text-sm font-medium transition-all border"
                  style={method === k
                    ? { background: `${ROLE_COLOR}22`, border: `1px solid ${ROLE_COLOR}55`, color: '#12284C' }
                    : { border: '1px solid rgba(18,40,76,0.08)', color: '#5C6E8C' }}>
                  {l}
                </button>
              ))}
            </div>
            <p className="text-[11px]" style={{ color: '#5C6E8C' }}>
              {method === 'email' ? 'Full package + invoice emailed to the client.' : 'Package posted to the client portal; invoice reflected there.'}
            </p>
          </Panel>
        )}
        {role !== 'typer' && (
          <>
            <Panel title="Notes">
              <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={3}
                placeholder="Notes (optional)…" className="input-field text-sm resize-none" />
            </Panel>
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
      </div>
    )},
    { key:'overview', label:'Overview', icon:FileText, render: () => (
      <DetailGrid items={[
        ['Search Type', order.type], ['County', order.county], ['State', order.state],
        ['Priority', order.priority?.toUpperCase()], ['ETA', order.eta], ['Current stage', meta.label],
      ]} />
    )},
    { key:'files', label:'Files', icon:Files, render: () => (
      <Panel title="Attached documents"><AttachedDocs workflow={order.workflow} /></Panel>
    )},
    { key:'messages', label:'Messages', icon:Inbox, badge: msgCount || null, render: () => (
      <Panel><OrderMessages order={order} accent={ROLE_COLOR} /></Panel>
    )},
    { key:'activity', label:'Activity', icon:Clock, render: () => (
      <ActivityTab order={order} activityLog={activityLog} accent={ROLE_COLOR} />
    )},
  ]

  return (
    <OrderDetailLayout order={order} user={user} accent={ROLE_COLOR}
      backTo="/operator" backLabel="Back to Workspace" tabs={TABS}
      statusPill={
        <span className="text-[10px] font-bold uppercase tracking-wider px-2.5 py-1 rounded-md"
          style={{ background: `${meta.color}22`, color: meta.color }}>{meta.label}</span>
      } />
  )
}

const Lbl = ({ children }) => (
  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: '#5C6E8C' }}>{children}</label>
)

// The Single Seating desk only sees orders Admin has routed to it. A routed
// order stays with the desk start to finish; between steps it parks with
// Admin for approval and shows here read-only until re-approved.
function OperatorHome() {
  const { user } = useAuth()
  const { orders } = useOrders()
  const navigate = useNavigate()
  const active = orders.filter(o => o.status !== 'delivered' && nextRoleFor(o))
  const actionable = active.filter(o => o.assignedTo === 'operator')
  const awaiting   = active.filter(o => o.workflow?.singleSeating && o.assignedTo !== 'operator')
  const byStage = (r) => actionable.filter(o => nextRoleFor(o) === r).length

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>Single Seating Workspace</h1>
        <p className="text-sm" style={{ color: '#3D5171' }}>Orders assigned to your desk — worked start to finish, with Admin approval at every phase</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {Object.entries(STAGE).map(([r, s]) => (
          <motion.div key={r} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background: `${s.color}22` }}>
              <Layers className="w-4 h-4" style={{ color: s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color: '#12284C' }}>{byStage(r)}</div>
            <div className="text-sm" style={{ color: '#3D5171' }}>In {s.label}</div>
          </motion.div>
        ))}
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color: '#12284C' }}>Active Orders</h2>
        <div className="space-y-3">
          {actionable.map((o, i) => {
            const role = nextRoleFor(o)
            const s = STAGE[role] || {}
            return (
              <motion.div key={o.id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}
                className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
                style={{ background: 'rgba(18,40,76,0.03)', border: '1px solid rgba(36,65,229,0.08)' }}
                onMouseOver={e => e.currentTarget.style.borderColor = `${s.color}55`}
                onMouseOut={e => e.currentTarget.style.borderColor = 'rgba(36,65,229,0.08)'}
                onClick={() => navigate(`/operator/orders/${o.id}`)}>
                <div className="w-2 h-10 rounded-full flex-shrink-0" style={{ background: s.color }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{o.id}</span>
                    {o.priority === 'rush' && <span className="text-xs font-semibold px-2 py-0.5 rounded-md" style={{ background: 'rgba(220,80,60,0.18)', color: '#dc2626' }}>RUSH</span>}
                  </div>
                  <div className="font-medium text-sm mt-0.5 truncate" style={{ color: '#12284C' }}>{displayClient(o, user)}</div>
                  <div className="text-xs" style={{ color: '#5C6E8C' }}>{o.type} · {o.state}, {o.county}</div>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: `${s.color}22`, color: s.color }}>{s.label}</span>
                  <div className="text-xs mt-1" style={{ color: '#5C6E8C' }}>ETA {o.eta}</div>
                </div>
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: 'rgba(18,40,76,0.18)' }} />
              </motion.div>
            )
          })}
          {actionable.length === 0 && <div className="text-sm text-center py-6" style={{ color: '#5C6E8C' }}>No orders assigned to your desk. Admin routes orders here from the Assign modal.</div>}
        </div>
      </div>

      {/* Steps completed here wait for Admin sign-off before the next stage unlocks. */}
      {awaiting.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-4" style={{ color: '#12284C' }}>Awaiting Admin Approval</h2>
          <div className="space-y-3">
            {awaiting.map(o => {
              const s = STAGE[nextRoleFor(o)] || {}
              return (
                <div key={o.id} className="flex items-center gap-4 p-4 rounded-xl"
                  style={{ background: 'rgba(18,40,76,0.03)', border: '1px dashed rgba(18,40,76,0.15)', opacity: 0.75 }}>
                  <div className="w-2 h-10 rounded-full flex-shrink-0" style={{ background: '#9AA8BF' }} />
                  <div className="flex-1 min-w-0">
                    <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{o.id}</span>
                    <div className="font-medium text-sm mt-0.5 truncate" style={{ color: '#12284C' }}>{displayClient(o, user)}</div>
                    <div className="text-xs" style={{ color: '#5C6E8C' }}>{o.type} · {o.state}, {o.county}</div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <span className="text-xs font-semibold px-2.5 py-1 rounded-full" style={{ background: 'rgba(18,40,76,0.08)', color: '#5C6E8C' }}>
                      Awaiting Admin Approval
                    </span>
                    <div className="text-xs mt-1" style={{ color: '#5C6E8C' }}>Next: {s.label || '—'}</div>
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
  const done = orders.filter(o => o.status === 'delivered' && o.workflow?.singleSeating)
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>Completed</h1>
      <div className="glass-card p-5 space-y-2">
        {done.map(o => (
          <div key={o.id} className="flex items-center gap-3 p-3 rounded-xl">
            <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color: '#15803d' }} />
            <span className="font-mono text-xs" style={{ color: '#3D5171' }}>{o.id}</span>
            <span className="text-xs flex-1 truncate" style={{ color: '#3D5171' }}>{displayClient(o, user)}</span>
            <span className="text-xs" style={{ color: '#5C6E8C' }}>{o.completed || o.eta}</span>
          </div>
        ))}
        {done.length === 0 && <div className="text-sm text-center py-6" style={{ color: '#5C6E8C' }}>Nothing delivered yet.</div>}
      </div>
    </div>
  )
}

export default function OperatorDashboard() {
  return (
    <Layout navItems={NAV} role="single seating" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<OperatorHome />} />
        <Route path="order/:id"  element={<FulfillmentScreen />} />
        <Route path="orders/:id" element={<OperatorOrderPage />} />
        <Route path="completed" element={<CompletedList />} />
      </Routes>
    </Layout>
  )
}
