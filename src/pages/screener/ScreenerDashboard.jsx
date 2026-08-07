import React, { useState } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { LayoutDashboard, ClipboardList, CheckCircle, Clock, AlertTriangle, Search, ChevronRight, Send, FileText, Inbox, Files } from 'lucide-react'
import { displayClient } from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import DocUpload from '../../components/DocUpload'
import OrderMessages from '../../components/OrderMessages'
import AttachedDocs from '../../components/AttachedDocs'
import OrderDetailLayout, { DetailGrid, Panel, ActivityTab } from '../../components/OrderDetailLayout'

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

// Full-page order detail (replaces the old modal). Route: /screener/order/:id
function ScreenerOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, returnToAdmin, activityLog = [] } = useOrders()
  const { getOrderThread, getOrderNotes } = useSupport()
  const order = orders.find(o => o.id === id)

  const [assignment, setAssignment] = useState(order?.workflow?.searchAssignment || null)
  const [doc, setDoc]     = useState(order?.workflow?.screenerDoc || null)
  const [notes, setNotes] = useState('')

  if (!order) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
      <div className="text-sm" style={{ color:'#64748b' }}>Order not found, or it isn’t in your queue.</div>
      <button onClick={() => navigate('/screener/queue')} className="btn-primary text-sm px-5 py-2.5">Back to Screening Queue</button>
    </div>
  )

  const submit = () => {
    if (!assignment) return
    returnToAdmin(order.id, 'screener', user?.name, notes, { searchAssignment: assignment, screenerDoc: doc })
    navigate('/screener/queue')
  }

  const intake = order.workflow?.intake
  const msgCount = getOrderThread(order.id).length + getOrderNotes(order.id).length

  const TABS = [
    { key:'screening', label:'Screening', icon:Search, render: () => (
      <div className="space-y-4">
        <Panel title="Assign Search To" hint="Routing to ABS or Both owes the abstractor vendor a fee.">
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
        </Panel>
        <Panel title="Search Document" hint="Optional at this stage.">
          <DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} />
        </Panel>
        <Panel title="Screening Notes">
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="Add screening notes…" rows={3} className="input-field text-sm resize-none" />
        </Panel>
        <div className="flex gap-3">
          <button disabled={!assignment} onClick={submit}
            className="btn-primary flex-1 text-sm py-2.5 flex items-center justify-center gap-2"
            style={{ opacity: assignment ? 1 : 0.5, cursor: assignment ? 'pointer' : 'not-allowed' }}>
            <Send className="w-4 h-4" /> Confirm &amp; Send to Admin
          </button>
          <button className="btn-secondary text-sm py-2.5 px-4" onClick={() => navigate('/screener/queue')}>Hold</button>
        </div>
        {!assignment && <p className="text-[11px]" style={{ color:'#64748b' }}>Choose who conducts the search to continue.</p>}
      </div>
    )},
    { key:'overview', label:'Overview', icon:FileText, render: () => (
      <div className="space-y-4">
        <DetailGrid items={[
          ['State / County', `${order.state} · ${order.county}`],
          ['Search Type', order.type],
          ['Priority', order.priority?.toUpperCase()],
          ['ETA', order.eta],
          ['Placed', order.created],
          ['Status', order.status],
        ]} />
        {intake && (
          <Panel title="Client intake">
            <div className="text-sm space-y-1.5">
              {[['Property', intake.propertyAddress], ['Parcel / APN', intake.parcelNumberAPN],
                ['Borrower', intake.borrowerName], ['Buyer', intake.buyer], ['Seller', intake.seller],
                ['Special instructions', intake.specialInstructions]]
                .filter(([, v]) => v).map(([k, v]) => (
                <div key={k}><span style={{ color:'#64748b' }}>{k}: </span>
                  <span className="font-medium" style={{ color:'#1e293b' }}>{v}</span></div>
              ))}
            </div>
          </Panel>
        )}
      </div>
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
      backTo="/screener/queue" backLabel="Back to Screening Queue" tabs={TABS}
      statusPill={
        <span className="text-xs font-semibold px-3 py-1.5 rounded-full"
          style={{ background:`${ROLE_COLOR}1e`, color:ROLE_COLOR }}>
          {STATUS_DOT[order.status] ? order.status : 'screening'}
        </span>
      } />
  )
}

function ScreenerHome() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const { getOrdersForRole } = useOrders()
  const myOrders = getOrdersForRole('screener')
  const openOrder = (o) => navigate(`/screener/order/${o.id}`)
  return (
    <div className="space-y-6">
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
              onClick={() => openOrder(o)}>
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
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>{title}</h1>
      <div className="glass-card p-5">
        <OrdersTable orders={orders} onOrderClick={o => navigate(`/screener/order/${o.id}`)} />
      </div>
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
        <Route path="order/:id" element={<ScreenerOrderPage />} />
      </Routes>
    </Layout>
  )
}
