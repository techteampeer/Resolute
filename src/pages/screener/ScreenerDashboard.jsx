import React, { useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { LayoutDashboard, ClipboardList, CheckCircle, Clock, AlertTriangle, Search, ChevronRight, X, Send } from 'lucide-react'
import { displayClient } from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import DocUpload from '../../components/DocUpload'
import OrderMessages from '../../components/OrderMessages'

const ROLE_COLOR = '#4d7c2f'
const ASSIGN_OPTS = [['in_house', 'In-House'], ['abs', 'ABS (Abstract)'], ['both', 'Both']]
const NAV = [
  { path: '/screener',           label: 'Dashboard',       icon: LayoutDashboard },
  { path: '/screener/queue',     label: 'Screening Queue', icon: ClipboardList, badge: 3 },
  { path: '/screener/completed', label: 'Completed',       icon: CheckCircle },
]

const STATUS_DOT = {
  received:  '#2563eb', screening: '#b45309', searching: '#4d7c2f',
  examining: '#a16207', typing: '#0e7490', delivered: '#15803d',
}

function OrderModal({ order, onClose }) {
  const { user } = useAuth()
  const { returnToAdmin } = useOrders()
  const [assignment, setAssignment] = useState(order.workflow?.searchAssignment || null)
  const [doc, setDoc]       = useState(order.workflow?.screenerDoc || null)
  const [notes, setNotes]   = useState('')
  const submit = () => {
    if (!assignment) return
    returnToAdmin(order.id, 'screener', user?.name, notes, { searchAssignment: assignment, screenerDoc: doc })
    onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.65)' }} onClick={onClose}>
      <motion.div initial={{ scale: 0.95, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
        className="glass-card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{order.id}</div>
            <div className="text-xl font-bold mt-0.5" style={{ color: '#1e293b' }}>{displayClient(order.client, user)}</div>
          </div>
          <button onClick={onClose} style={{ color: '#64748b' }}><X className="w-5 h-5" /></button>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
          {[['State/County',`${order.state} · ${order.county}`],['Search Type',order.type],
            ['Priority',order.priority.toUpperCase()],['ETA',order.eta]].map(([k,v]) => (
            <div key={k} className="glass p-3 rounded-xl">
              <div className="text-xs mb-1" style={{ color: '#64748b' }}>{k}</div>
              <div className="font-medium text-sm" style={{ color: '#1e293b' }}>{v}</div>
            </div>
          ))}
        </div>
        <div className="mb-4">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: '#64748b' }}>Assign Search To</label>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {ASSIGN_OPTS.map(([k, l]) => (
              <button key={k} onClick={() => setAssignment(k)}
                className="py-2.5 rounded-lg text-xs font-semibold transition-all"
                style={assignment === k
                  ? { background: `${ROLE_COLOR}28`, color: ROLE_COLOR, border: `1px solid ${ROLE_COLOR}55` }
                  : { background: 'rgba(30,41,59,0.05)', color: '#64748b', border: '1px solid rgba(30,41,59,0.08)' }}>
                {l}
              </button>
            ))}
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color: '#64748b' }}>Search Document <span style={{ textTransform: 'none', opacity: 0.6 }}>(optional)</span></label>
          <DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} />
        </div>
        <div className="mb-4 pt-4" style={{ borderTop: '1px solid rgba(30,41,59,0.08)' }}>
          <OrderMessages order={order} accent={ROLE_COLOR} />
        </div>
        <textarea value={notes} onChange={e => setNotes(e.target.value)}
          placeholder="Add screening notes…" rows={2} className="input-field text-sm mb-4 resize-none" />
        <div className="flex gap-3">
          <button disabled={!assignment} onClick={submit}
            className="btn-primary flex-1 text-sm py-2.5 flex items-center justify-center gap-2"
            style={{ opacity: assignment ? 1 : 0.5, cursor: assignment ? 'pointer' : 'not-allowed' }}>
            <Send className="w-4 h-4" /> Confirm &amp; Send to Admin
          </button>
          <button className="btn-secondary text-sm py-2.5 px-4" onClick={onClose}>Hold</button>
        </div>
        {!assignment && <p className="text-[11px] mt-2" style={{ color: '#64748b' }}>Choose who conducts the search to continue.</p>}
      </motion.div>
    </div>
  )
}

function ScreenerHome() {
  const { user } = useAuth()
  const { getOrdersForRole } = useOrders()
  const myOrders = getOrdersForRole('screener')
  const [selected, setSelected] = useState(null)
  return (
    <div className="space-y-6">
      {selected && <OrderModal order={selected} onClose={() => setSelected(null)} />}
      <div>
        <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>Screening Dashboard</h1>
        <p className="text-sm" style={{ color: '#475569' }}>Review and validate incoming title search requests</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon: AlertTriangle, label: 'Awaiting Screening', value: '2', color: '#b45309' },
          { icon: Search,        label: 'In Screening',       value: '1', color: ROLE_COLOR },
          { icon: CheckCircle,   label: 'Passed Today',       value: '5', color: '#15803d' },
          { icon: Clock,         label: 'Avg Screen Time',    value: '18m', color: '#a16207' },
        ].map(s => (
          <motion.div key={s.label} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background: `${s.color}22` }}>
              <s.icon className="w-4 h-4" style={{ color: s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color: '#1e293b' }}>{s.value}</div>
            <div className="text-sm" style={{ color: '#475569' }}>{s.label}</div>
          </motion.div>
        ))}
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color: '#1e293b' }}>My Screening Queue</h2>
        <div className="space-y-3">
          {myOrders.map((o, i) => (
            <motion.div key={o.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
              transition={{ delay: i * 0.07 }}
              className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
              style={{ background:'rgba(30,41,59,0.03)', border:'1px solid rgba(138,194,104,0.08)' }}
              onMouseOver={e => e.currentTarget.style.borderColor = 'rgba(138,194,104,0.25)'}
              onMouseOut={e => e.currentTarget.style.borderColor = 'rgba(138,194,104,0.08)'}
              onClick={() => setSelected(o)}>
              <div className="w-2 h-10 rounded-full flex-shrink-0" style={{ background: STATUS_DOT[o.status] || ROLE_COLOR }} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{o.id}</span>
                  {o.priority === 'rush' && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-md"
                      style={{ background:'rgba(220,80,60,0.18)', color:'#dc2626' }}>RUSH</span>
                  )}
                </div>
                <div className="font-medium text-sm mt-0.5 truncate" style={{ color:'#1e293b' }}>{displayClient(o.client, user)}</div>
                <div className="text-xs" style={{ color:'#64748b' }}>{o.type} · {o.state}, {o.county}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full capitalize"
                  style={{ background: `${STATUS_DOT[o.status] || ROLE_COLOR}22`, color: STATUS_DOT[o.status] || ROLE_COLOR }}>
                  {o.status}
                </span>
                <div className="text-xs mt-1" style={{ color:'#64748b' }}>ETA {o.eta}</div>
              </div>
              <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(30,41,59,0.18)' }} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ScreenerQueue({ orders, title }) {
  const [selected, setSelected] = useState(null)
  return (
    <div className="space-y-6">
      {selected && <OrderModal order={selected} onClose={() => setSelected(null)} />}
      <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>{title}</h1>
      <div className="glass-card p-5"><OrdersTable orders={orders} onOrderClick={setSelected} /></div>
    </div>
  )
}

export default function ScreenerDashboard() {
  const { getOrdersForRole, orders } = useOrders()
  const myOrders  = getOrdersForRole('screener')
  const completed = orders.filter(o => o.completedDates?.screener)
  return (
    <Layout navItems={NAV} role="screener" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<ScreenerHome />} />
        <Route path="queue" element={<ScreenerQueue orders={myOrders} title="Screening Queue" />} />
        <Route path="completed" element={<ScreenerQueue orders={completed} title="Completed Screenings" />} />
      </Routes>
    </Layout>
  )
}
