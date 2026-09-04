import React, { useState } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { LayoutDashboard, FileSearch, CheckCircle, Clock, AlertCircle, ChevronRight, Send, FileText, Inbox, Files } from 'lucide-react'
import { displayClient } from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import DocUpload from '../../components/DocUpload'
import AttachedDocs from '../../components/AttachedDocs'
import OrderMessages from '../../components/OrderMessages'
import OrderDetailLayout, { DetailGrid, Panel, ActivityTab } from '../../components/OrderDetailLayout'

const ROLE_COLOR = '#2441E5'
const NAV = [
  { path: '/examiner',           label: 'Dashboard',  icon: LayoutDashboard },
  { path: '/examiner/examine',   label: 'To Examine', icon: FileSearch, badge: 2 },
  { path: '/examiner/completed', label: 'Completed',  icon: CheckCircle },
]

const CHECKLIST = ['Chain of title verified', 'Tax status confirmed', 'Lien search completed',
  'HOA status checked', 'Easements/encumbrances noted']

// Full-page order detail (replaces the old modal). Route: /examiner/order/:id
function ExaminerOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, returnToAdmin, activityLog = [] } = useOrders()
  const { getOrderThread, getOrderNotes } = useSupport()
  const order = orders.find(o => o.id === id)

  const [findings, setFindings] = useState('')
  const [liens, setLiens] = useState(false)
  const [encumbrances, setEncumbrances] = useState(false)
  const [checks, setChecks] = useState({})
  const [doc, setDoc] = useState(order?.workflow?.examinerDoc || null)

  if (!order) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
      <div className="text-sm" style={{ color:'#5C6E8C' }}>Order not found, or it isn’t in your queue.</div>
      <button onClick={() => navigate('/examiner/examine')} className="btn-primary text-sm px-5 py-2.5">Back to To Examine</button>
    </div>
  )

  const ready = doc && doc.status === 'done'
  const submit = () => {
    if (!ready) return
    returnToAdmin(order.id, 'examiner', user?.name, findings, {
      examinerDoc: doc,
      examChecklist: checks,
      examIssues: { liens, encumbrances },
      examNotes: findings,
    })
    navigate('/examiner/examine')
  }
  const msgCount = getOrderThread(order.id).length + getOrderNotes(order.id).length

  const TABS = [
    { key:'examination', label:'Examination', icon:FileSearch, render: () => (
      <div className="space-y-4">
        <Panel title="Examination checklist">
          <div className="space-y-1">
            {CHECKLIST.map(item => (
              <label key={item} className="flex items-center gap-3 cursor-pointer p-2.5 rounded-lg transition-colors"
                onMouseOver={e=>e.currentTarget.style.background='rgba(18,40,76,0.05)'}
                onMouseOut={e=>e.currentTarget.style.background='transparent'}>
                <input type="checkbox" className="w-4 h-4 rounded" style={{ accentColor: ROLE_COLOR }}
                  checked={!!checks[item]} onChange={e => setChecks(c => ({ ...c, [item]: e.target.checked }))} />
                <span className="text-sm" style={{ color:'#2A3E5F' }}>{item}</span>
              </label>
            ))}
          </div>
        </Panel>
        <Panel title="Issues found">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[['Open Liens',liens,setLiens],['Encumbrances',encumbrances,setEncumbrances]].map(([l,v,set]) => (
              <button key={l} onClick={() => set(!v)}
                className="p-3 rounded-xl text-sm font-medium transition-all border"
                style={v
                  ? { border:'1px solid rgba(220,80,60,0.40)', background:'rgba(220,80,60,0.14)', color:'#dc2626' }
                  : { border:'1px solid rgba(18,40,76,0.08)', color:'#5C6E8C' }}>
                {l}: {v ? 'YES' : 'NO'}
              </button>
            ))}
          </div>
        </Panel>
        <Panel title="Researched document" hint="Required before this order can go back to Admin.">
          <DocUpload orderId={order.id} value={doc} onChange={setDoc} accent={ROLE_COLOR} />
        </Panel>
        <Panel title="Examination notes">
          <textarea value={findings} onChange={e=>setFindings(e.target.value)}
            placeholder="Document findings, chain of title issues, liens, easements…"
            rows={4} className="input-field text-sm resize-none" />
        </Panel>
        <div className="flex gap-3">
          <button disabled={!ready} onClick={submit}
            className="btn-primary flex-1 text-sm py-2.5 flex items-center justify-center gap-2"
            style={{ opacity: ready ? 1 : 0.5, cursor: ready ? 'pointer' : 'not-allowed' }}>
            <Send className="w-4 h-4" /> Confirm &amp; Send to Admin
          </button>
          <button className="btn-secondary text-sm py-2.5 px-4" onClick={() => navigate('/examiner/examine')}>Save Draft</button>
        </div>
        {!ready && <p className="text-[11px]" style={{ color:'#5C6E8C' }}>Upload the researched document to continue.</p>}
      </div>
    )},
    { key:'overview', label:'Overview', icon:FileText, render: () => (
      <DetailGrid items={[
        ['Search Type', order.type], ['County', order.county], ['State', order.state],
        ['Priority', order.priority?.toUpperCase()], ['ETA', order.eta], ['Placed', order.created],
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
      backTo="/examiner/examine" backLabel="Back to To Examine" tabs={TABS} />
  )
}

function ExaminerHome() {
  const { user } = useAuth()
  const { getOrdersForRole } = useOrders()
  const myOrders = getOrdersForRole('examiner')
  const navigate = useNavigate()
  const openOrder = (o) => navigate(`/examiner/order/${o.id}`)
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Examiner Dashboard</h1>
        <p className="text-sm" style={{ color:'#3D5171' }}>Examine title documents and verify chain of title</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:FileSearch,  label:'Awaiting Exam',   value:'2',  color:'#2441E5' },
          { icon:Clock,       label:'In Progress',     value:'1',  color:ROLE_COLOR },
          { icon:CheckCircle, label:'Completed Today', value:'4',  color:'#15803d' },
          { icon:AlertCircle, label:'Issues Found',    value:'1',  color:'#dc2626' },
        ].map(s => (
          <motion.div key={s.label} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background:`${s.color}22` }}>
              <s.icon className="w-4 h-4" style={{ color:s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color:'#12284C' }}>{s.value}</div>
            <div className="text-sm" style={{ color:'#3D5171' }}>{s.label}</div>
          </motion.div>
        ))}
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color:'#12284C' }}>Examination Queue</h2>
        <div className="space-y-3">
          {myOrders.map((o,i) => (
            <motion.div key={o.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
              transition={{ delay:i*0.07 }}
              className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
              style={{ background:'rgba(18,40,76,0.03)', border:'1px solid rgba(36,65,229,0.08)' }}
              onMouseOver={e=>e.currentTarget.style.borderColor='rgba(196,164,78,0.30)'}
              onMouseOut={e=>e.currentTarget.style.borderColor='rgba(36,65,229,0.08)'}
              onClick={() => openOrder(o)}>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-mono font-semibold text-sm" style={{ color:ROLE_COLOR }}>{o.id}</span>
                  {o.priority==='rush' && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-md"
                      style={{ background:'rgba(220,80,60,0.18)', color:'#dc2626' }}>RUSH</span>
                  )}
                </div>
                <div className="font-medium text-sm truncate" style={{ color:'#12284C' }}>{displayClient(o, user)}</div>
                <div className="text-xs" style={{ color:'#5C6E8C' }}>{o.type} · {o.state}, {o.county}</div>
                <div className="mt-2 h-1.5 rounded-full overflow-hidden" style={{ background:'rgba(18,40,76,0.10)' }}>
                  <div className="h-full rounded-full transition-all"
                    style={{ width:`${o.progress}%`, background:'linear-gradient(90deg,#2441E5,#00B8D9)' }} />
                </div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full capitalize"
                  style={{ background:`${ROLE_COLOR}22`, color:ROLE_COLOR }}>{o.status}</span>
                <div className="text-xs mt-1" style={{ color:'#5C6E8C' }}>{o.progress}%</div>
              </div>
              <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(18,40,76,0.18)' }} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ExaminerQueue({ orders, title }) {
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>{title}</h1>
      <div className="glass-card p-5">
        <OrdersTable orders={orders} onOrderClick={o => navigate(`/examiner/order/${o.id}`)} />
      </div>
    </div>
  )
}

export default function ExaminerDashboard() {
  const { getOrdersForRole, orders } = useOrders()
  const myOrders  = getOrdersForRole('examiner')
  const completed = orders.filter(o => o.completedDates?.examiner)
  return (
    <Layout navItems={NAV} role="examiner" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<ExaminerHome />} />
        <Route path="examine" element={<ExaminerQueue orders={myOrders} title="To Examine" />} />
        <Route path="completed" element={<ExaminerQueue orders={completed} title="Completed" />} />
        <Route path="order/:id" element={<ExaminerOrderPage />} />
      </Routes>
    </Layout>
  )
}
