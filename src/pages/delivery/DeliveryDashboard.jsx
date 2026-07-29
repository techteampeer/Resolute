import React, { useState } from 'react'
import { Routes, Route } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { LayoutDashboard, Truck, Package, CheckCircle, Clock, Download, Send, Mail, X, ChevronRight } from 'lucide-react'
import { displayClient, clientByName } from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import AttachedDocs from '../../components/AttachedDocs'

const ROLE_COLOR = '#b45309'
const NAV = [
  { path: '/delivery',         label: 'Dashboard',    icon: LayoutDashboard },
  { path: '/delivery/queue',   label: 'Ready to Send',icon: Package, badge: 2 },
  { path: '/delivery/sent',    label: 'Delivered',    icon: CheckCircle },
]

function DeliveryModal({ order, onClose }) {
  const { user } = useAuth()
  const { returnToAdmin, logClientEvent } = useOrders()
  const cli = clientByName(order.client)
  const [method, setMethod] = useState(order.workflow?.deliveryMethod || 'email')
  const [recipient, setRecipient] = useState(user?.superAdmin && cli ? cli.email : '')
  const [note, setNote] = useState('')
  // Delivery completes the pipeline, then hands the order back to Admin for a
  // final close-out (status stays 'delivered', parked with admin + a pending
  // flag) so a finished order is never closed without Admin being informed.
  const submit = () => {
    returnToAdmin(order.id, 'delivery', user?.name, `via ${method}${note ? ' · ' + note : ''}`, {
      deliveryMethod: method, deliveryRecipient: recipient,
      invoiceVisibleToClient: method === 'portal', deliveredPendingAck: true,
    })
    // Portal delivery makes the invoice visible — tell the client it's ready.
    if (method === 'portal') logClientEvent?.(order.id, `Your invoice for ${order.id} is available to view and pay.`, 'status')
    onClose()
  }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background:'rgba(0,0,0,0.65)' }} onClick={onClose}>
      <motion.div initial={{ scale:0.95, opacity:0 }} animate={{ scale:1, opacity:1 }}
        className="glass-card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e=>e.stopPropagation()}>
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="font-mono font-semibold text-sm" style={{ color:ROLE_COLOR }}>{order.id}</div>
            <div className="text-xl font-bold" style={{ color:'#1e293b' }}>{displayClient(order.client, user)}</div>
          </div>
          <button onClick={onClose} style={{ color:'#64748b' }}><X className="w-5 h-5" /></button>
        </div>
        <div className="flex items-center gap-3 p-4 rounded-xl mb-5"
          style={{ background:'rgba(109,188,120,0.12)', border:'1px solid rgba(109,188,120,0.25)' }}>
          <div className="w-10 h-10 rounded-xl flex items-center justify-center"
            style={{ background:'rgba(109,188,120,0.20)' }}>
            <CheckCircle className="w-5 h-5" style={{ color:'#15803d' }} />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color:'#1e293b' }}>Report Ready for Delivery</div>
            <div className="text-xs" style={{ color:'#64748b' }}>{order.type} · {order.state}, {order.county} County</div>
          </div>
        </div>
        <div className="mb-4"><AttachedDocs workflow={order.workflow} /></div>
        <div className="mb-4">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color:'#64748b' }}>Delivery Method</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {[['email','Email'],['portal','Client Portal']].map(([k,l]) => (
              <button key={k} onClick={() => setMethod(k)}
                className="py-2.5 rounded-xl text-sm font-medium transition-all border"
                style={method===k
                  ? { background:`${ROLE_COLOR}22`, border:`1px solid ${ROLE_COLOR}55`, color:'#1e293b' }
                  : { border:'1px solid rgba(30,41,59,0.08)', color:'#64748b' }}>
                {l}
              </button>
            ))}
          </div>
          <p className="text-[11px] mt-2" style={{ color:'#64748b' }}>
            {method==='email'
              ? 'Full package + invoice will be emailed to the client.'
              : 'Package is posted to the client portal and the invoice is reflected there.'}
          </p>
        </div>
        <div className="mb-4" style={{ display: method==='email' ? 'block' : 'none' }}>
          <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color:'#64748b' }}>Recipient Email</label>
          <input value={recipient} onChange={e=>setRecipient(e.target.value)}
            placeholder="client@company.com" className="input-field text-sm" />
        </div>
        <div className="mb-5">
          <label className="block text-xs font-semibold uppercase tracking-wider mb-2"
            style={{ color:'#64748b' }}>Delivery Note</label>
          <textarea value={note} onChange={e=>setNote(e.target.value)}
            placeholder="Notes for the client…" rows={3} className="input-field text-sm resize-none" />
        </div>
        <div className="flex gap-3">
          <button className="flex-1 btn-primary text-sm py-2.5 flex items-center justify-center gap-2" onClick={submit}>
            <Send className="w-4 h-4" /> Deliver &amp; Submit to Admin
          </button>
          <button className="btn-secondary text-sm py-2.5 px-4 flex items-center gap-2" onClick={onClose}>Close</button>
        </div>
      </motion.div>
    </div>
  )
}

function DeliveryHome() {
  const { user } = useAuth()
  const { getOrdersForRole, orders } = useOrders()
  const readyOrders     = getOrdersForRole('delivery')
  const deliveredOrders = orders.filter(o => o.status === 'delivered')
  const [selected, setSelected] = useState(null)
  const [emailed, setEmailed]   = useState([])
  return (
    <div className="space-y-6">
      {selected && <DeliveryModal order={selected} onClose={() => setSelected(null)} />}
      <div>
        <h1 className="text-2xl font-bold" style={{ color:'#1e293b' }}>Delivery Dashboard</h1>
        <p className="text-sm" style={{ color:'#475569' }}>Manage and deliver completed title search reports</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:Package,     label:'Ready to Deliver', value:'2',  color:ROLE_COLOR },
          { icon:Truck,       label:'Sent Today',       value:'3',  color:'#4d7c2f' },
          { icon:CheckCircle, label:'Delivered (MTD)',  value:'79', color:'#15803d' },
          { icon:Clock,       label:'Avg Delivery',     value:'22m',color:'#a16207' },
        ].map(s => (
          <motion.div key={s.label} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background:`${s.color}22` }}>
              <s.icon className="w-4 h-4" style={{ color:s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color:'#1e293b' }}>{s.value}</div>
            <div className="text-sm" style={{ color:'#475569' }}>{s.label}</div>
          </motion.div>
        ))}
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color:'#1e293b' }}>Ready to Deliver</h2>
        <div className="space-y-3">
          {readyOrders.map((o,i) => (
            <motion.div key={o.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
              transition={{ delay:i*0.07 }}
              className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
              style={{ background:'rgba(30,41,59,0.03)', border:'1px solid rgba(138,194,104,0.08)' }}
              onMouseOver={e=>e.currentTarget.style.borderColor='rgba(196,120,62,0.30)'}
              onMouseOut={e=>e.currentTarget.style.borderColor='rgba(138,194,104,0.08)'}
              onClick={() => setSelected(o)}>
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
                  <span className="font-medium text-sm truncate" style={{ color:'#1e293b' }}>{displayClient(o.client, user)}</span>
                  {clientByName(o.client)?.activity === 'low' && (
                    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md flex-shrink-0"
                      style={{ background:'rgba(196,120,62,0.18)', color:'#b45309' }}>LOW ACTIVITY</span>
                  )}
                </div>
                <div className="text-xs" style={{ color:'#64748b' }}>{o.type} · {o.state}</div>
              </div>
              <div className="text-right flex-shrink-0">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full capitalize"
                  style={{ background:`${ROLE_COLOR}22`, color:ROLE_COLOR }}>{o.status}</span>
                <div className="text-xs mt-1" style={{ color:'#64748b' }}>ETA {o.eta}</div>
              </div>
              <button
                onClick={e => { e.stopPropagation(); setEmailed(ids => ids.includes(o.id) ? ids : [...ids, o.id]) }}
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold flex-shrink-0 transition-all border"
                style={emailed.includes(o.id)
                  ? { background:'rgba(109,188,120,0.16)', borderColor:'rgba(109,188,120,0.35)', color:'#15803d' }
                  : { background:`${ROLE_COLOR}1a`, borderColor:`${ROLE_COLOR}40`, color:'#b45309' }}>
                {emailed.includes(o.id)
                  ? <><CheckCircle className="w-3.5 h-3.5" /> Emailed</>
                  : <><Mail className="w-3.5 h-3.5" /> Send by email</>}
              </button>
              <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(30,41,59,0.18)' }} />
            </motion.div>
          ))}
        </div>
      </div>
      <div className="glass-card p-5">
        <h2 className="font-semibold mb-4" style={{ color:'#1e293b' }}>Recently Delivered</h2>
        <div className="space-y-2">
          {deliveredOrders.map(o => (
            <div key={o.id} className="flex items-center gap-3 p-3 rounded-xl transition-colors"
              onMouseOver={e=>e.currentTarget.style.background='rgba(30,41,59,0.03)'}
              onMouseOut={e=>e.currentTarget.style.background='transparent'}>
              <CheckCircle className="w-4 h-4 flex-shrink-0" style={{ color:'#15803d' }} />
              <span className="font-mono text-xs flex-shrink-0" style={{ color:'#475569' }}>{o.id}</span>
              <span className="text-xs flex-1 truncate" style={{ color:'#475569' }}>{displayClient(o.client, user)}</span>
              <span className="text-xs flex-shrink-0" style={{ color:'#64748b' }}>Completed {o.completed || o.eta}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function DeliveryQueue({ orders, title }) {
  const [selected, setSelected] = useState(null)
  return (
    <div className="space-y-6">
      {selected && <DeliveryModal order={selected} onClose={() => setSelected(null)} />}
      <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>{title}</h1>
      <div className="glass-card p-5"><OrdersTable orders={orders} onOrderClick={setSelected} /></div>
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
      </Routes>
    </Layout>
  )
}
