import React, { useState } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { LayoutDashboard, Truck, Package, CheckCircle, Clock, Download, Send, Mail, ChevronRight, FileText, Inbox, Files, Bell } from 'lucide-react'
import { displayClient, clientByName } from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import AttachedDocs from '../../components/AttachedDocs'
import OrderMessages from '../../components/OrderMessages'
import OrderDetailLayout, { DetailGrid, Panel, ActivityTab } from '../../components/OrderDetailLayout'
import NotificationSettings from '../../components/NotificationSettings'

const ROLE_COLOR = '#2441E5'
const NAV = [
  { path: '/delivery',         label: 'Dashboard',    icon: LayoutDashboard },
  { path: '/delivery/queue',   label: 'Ready to Send',icon: Package, badge: 2 },
  { path: '/delivery/sent',    label: 'Delivered',    icon: CheckCircle },
  { path: '/delivery/notifications', label: 'Notifications', icon: Bell },
]

// Full-page order detail (replaces the old modal). Route: /delivery/order/:id
function DeliveryOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, completeStep, activityLog = [] } = useOrders()
  const { getOrderThread, getOrderNotes } = useSupport()
  const order = orders.find(o => o.id === id)
  const cli = order ? clientByName(order.client) : null

  const [method, setMethod] = useState(order?.workflow?.deliveryMethod || 'email')
  const [recipient, setRecipient] = useState(user?.superAdmin && cli ? cli.email : '')
  const [note, setNote] = useState('')

  if (!order) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
      <div className="text-sm" style={{ color:'#5C6E8C' }}>Order not found, or it isn’t in your queue.</div>
      <button onClick={() => navigate('/delivery/queue')} className="btn-primary text-sm px-5 py-2.5">Back to Ready to Send</button>
    </div>
  )

  const submit = () => {
    // The delivery details ride along with the stage move as one write — see the
    // note on completeStep's `extra`.
    completeStep(order.id, 'delivery', user?.name, `via ${method}${note ? ' · ' + note : ''}`, {
      deliveryMethod: method, deliveryRecipient: recipient, invoiceVisibleToClient: method === 'portal',
    })
    navigate('/delivery/queue')
  }
  const msgCount = getOrderThread(order.id).length + getOrderNotes(order.id).length

  const TABS = [
    { key:'delivery', label:'Delivery', icon:Truck, render: () => (
      <div className="space-y-4">
        <div className="flex items-center gap-3 p-4 rounded-xl"
          style={{ background:'rgba(0,184,217,0.12)', border:'1px solid rgba(0,184,217,0.25)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ background:'rgba(0,184,217,0.20)' }}>
            <CheckCircle className="w-5 h-5" style={{ color:'#15803d' }} />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color:'#12284C' }}>Report ready for delivery</div>
            <div className="text-xs" style={{ color:'#5C6E8C' }}>{order.type} · {order.state}, {order.county} County</div>
          </div>
        </div>
        <Panel title="Delivery method">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[['email','Email'],['portal','Client Portal']].map(([k,l]) => (
              <button key={k} onClick={() => setMethod(k)}
                className="py-2.5 rounded-xl text-sm font-medium transition-all border"
                style={method===k
                  ? { background:`${ROLE_COLOR}22`, border:`1px solid ${ROLE_COLOR}55`, color:'#12284C' }
                  : { border:'1px solid rgba(18,40,76,0.08)', color:'#5C6E8C' }}>
                {l}
              </button>
            ))}
          </div>
          <p className="text-[11px]" style={{ color:'#5C6E8C' }}>
            {method==='email'
              ? 'Full package + invoice will be emailed to the client.'
              : 'Package is posted to the client portal and the invoice is reflected there.'}
          </p>
          {method === 'email' && (
            <div>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Recipient email</div>
              <input value={recipient} onChange={e=>setRecipient(e.target.value)}
                placeholder="client@company.com" className="input-field text-sm" />
            </div>
          )}
        </Panel>
        <Panel title="Delivery note">
          <textarea value={note} onChange={e=>setNote(e.target.value)}
            placeholder="Notes for the client…" rows={3} className="input-field text-sm resize-none" />
        </Panel>
        <div className="flex gap-3">
          <button className="flex-1 btn-primary text-sm py-2.5 flex items-center justify-center gap-2" onClick={submit}>
            <Send className="w-4 h-4" /> Deliver &amp; Submit to Admin
          </button>
          <button className="btn-secondary text-sm py-2.5 px-4" onClick={() => navigate('/delivery/queue')}>Close</button>
        </div>
      </div>
    )},
    { key:'overview', label:'Overview', icon:FileText, render: () => (
      <DetailGrid items={[
        ['Client file #', order.clientFileNo || '—'],
        ['Search Type', order.type], ['County', order.county], ['State', order.state],
        ['Priority', order.priority?.toUpperCase()], ['ETA', order.eta], ['Placed', order.created],
      ]} />
    )},
    { key:'files', label:'Files', icon:Files, render: () => (
      <Panel title="Package documents"><AttachedDocs workflow={order.workflow} /></Panel>
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
      backTo="/delivery/queue" backLabel="Back to Ready to Send" tabs={TABS} />
  )
}

function DeliveryHome() {
  const { user } = useAuth()
  const { getOrdersForRole, orders } = useOrders()
  const readyOrders     = getOrdersForRole('delivery')
  const deliveredOrders = orders.filter(o => o.status === 'delivered')
  const navigate = useNavigate()
  const [emailed, setEmailed]   = useState([])
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Delivery Dashboard</h1>
        <p className="text-sm" style={{ color:'#3D5171' }}>Manage and deliver completed title search reports</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:Package,     label:'Ready to Deliver', value:'2',  color:ROLE_COLOR },
          { icon:Truck,       label:'Sent Today',       value:'3',  color:'#2441E5' },
          { icon:CheckCircle, label:'Delivered (MTD)',  value:'79', color:'#15803d' },
          { icon:Clock,       label:'Avg Delivery',     value:'22m',color:'#a16207' },
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
        <h2 className="font-semibold mb-4" style={{ color:'#12284C' }}>Ready to Deliver</h2>
        <div className="space-y-3">
          {readyOrders.map((o,i) => (
            <motion.div key={o.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
              transition={{ delay:i*0.07 }}
              className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
              style={{ background:'rgba(18,40,76,0.03)', border:'1px solid rgba(36,65,229,0.08)' }}
              onMouseOver={e=>e.currentTarget.style.borderColor='rgba(196,120,62,0.30)'}
              onMouseOut={e=>e.currentTarget.style.borderColor='rgba(36,65,229,0.08)'}
              onClick={() => navigate(`/delivery/order/${o.id}`)}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background:`${ROLE_COLOR}22` }}>
                <Package className="w-5 h-5" style={{ color:ROLE_COLOR }} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono font-semibold text-sm" style={{ color:ROLE_COLOR }}>{o.id}</span>
                  {o.priority==='rush' && (
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-md"
                      style={{ background:'rgba(220,80,60,0.18)', color:'#dc2626' }}>RUSH</span>
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="font-medium text-sm truncate" style={{ color:'#12284C' }}>{displayClient(o, user)}</span>
                  {clientByName(o.client)?.activity === 'low' && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md flex-shrink-0"
                      style={{ background:'rgba(196,120,62,0.18)', color:'#b45309' }}>LOW ACTIVITY</span>
                  )}
                </div>
                <div className="text-xs" style={{ color:'#5C6E8C' }}>{o.type} · {o.state}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full capitalize"
                  style={{ background:`${ROLE_COLOR}22`, color:ROLE_COLOR }}>{o.status}</span>
                <div className="text-xs mt-1" style={{ color:'#5C6E8C' }}>ETA {o.eta}</div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); setEmailed(ids => ids.includes(o.id) ? ids : [...ids, o.id]) }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold flex-shrink-0 transition-all border"
                style={emailed.includes(o.id)
                  ? { background:'rgba(0,184,217,0.16)', borderColor:'rgba(0,184,217,0.35)', color:'#15803d' }
                  : { background:`${ROLE_COLOR}1a`, borderColor:`${ROLE_COLOR}40`, color:'#b45309' }}>
                {emailed.includes(o.id)
                  ? <><CheckCircle className="w-3.5 h-3.5" /> Emailed</>
                  : <><Mail className="w-3.5 h-3.5" /> Send by email</>}
              </button>
              <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(18,40,76,0.18)' }} />
            </motion.div>
          ))}
        </div>
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color:'#12284C' }}>Recently Delivered</h2>
        <div className="space-y-2">
          {deliveredOrders.map(o => (
            <div key={o.id} className="flex items-center gap-3 p-3 rounded-xl transition-colors"
              onMouseOver={e=>e.currentTarget.style.background='rgba(18,40,76,0.03)'}
              onMouseOut={e=>e.currentTarget.style.background='transparent'}>
              <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color:'#15803d' }} />
              <span className="font-mono text-xs flex-shrink-0" style={{ color:'#3D5171' }}>{o.id}</span>
              <span className="text-xs flex-1 truncate" style={{ color:'#3D5171' }}>{displayClient(o, user)}</span>
              <span className="text-xs flex-shrink-0" style={{ color:'#5C6E8C' }}>Completed {o.completed || o.eta}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DeliveryQueue({ orders, title }) {
  const navigate = useNavigate()
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>{title}</h1>
      <div className="glass-card p-5">
        <OrdersTable orders={orders} onOrderClick={o => navigate(`/delivery/order/${o.id}`)} />
      </div>
    </div>
  )
}

export default function DeliveryDashboard() {
  const { getOrdersForRole, orders } = useOrders()
  const readyOrders     = getOrdersForRole('delivery')
  const deliveredOrders = orders.filter(o => o.status === 'delivered')
  return (
    <Layout navItems={NAV} role="delivery" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<DeliveryHome />} />
        <Route path="queue" element={<DeliveryQueue orders={readyOrders} title="Ready to Send" />} />
        <Route path="sent" element={<DeliveryQueue orders={deliveredOrders} title="Delivered Orders" />} />
        <Route path="order/:id" element={<DeliveryOrderPage />} />
        <Route path="notifications" element={<NotificationSettings accent={ROLE_COLOR} />} />
      </Routes>
    </Layout>
  )
}
