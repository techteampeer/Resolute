import React from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import OrdersTable from '../../components/OrdersTable'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { LayoutDashboard, Keyboard, CheckCircle, Clock, FileText, ChevronRight, Bell } from 'lucide-react'
import { displayClient } from '../../data/mockData'
import FulfillmentScreen from './fulfillment/FulfillmentScreen'
import NotificationSettings from '../../components/NotificationSettings'

const ROLE_COLOR = '#2441E5'
const NAV = [
  { path: '/typer',           label: 'Dashboard', icon: LayoutDashboard },
  { path: '/typer/queue',     label: 'To Type',   icon: Keyboard, badge: 2 },
  { path: '/typer/completed', label: 'Completed', icon: CheckCircle },
  { path: '/typer/notifications', label: 'Notifications', icon: Bell },
]

function TyperHome() {
  const { user } = useAuth()
  const { getOrdersForRole } = useOrders()
  const navigate = useNavigate()
  const myOrders = getOrdersForRole('typer')
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Typer Dashboard</h1>
        <p className="text-sm" style={{ color:'#3D5171' }}>Type and format examined reports before delivery</p>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:Keyboard,    label:'Awaiting Typing', value:'2',   color:ROLE_COLOR },
          { icon:FileText,    label:'In Progress',     value:'1',   color:'#2441E5' },
          { icon:CheckCircle, label:'Typed Today',     value:'6',   color:'#15803d' },
          { icon:Clock,       label:'Avg Type Time',   value:'24m', color:'#a16207' },
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
        <h2 className="font-semibold mb-4" style={{ color:'#12284C' }}>Typing Queue</h2>
        <div className="space-y-3">
          {myOrders.map((o,i) => (
            <motion.div key={o.id} initial={{ opacity:0, x:-8 }} animate={{ opacity:1, x:0 }}
              transition={{ delay:i*0.07 }}
              className="flex items-center gap-4 p-4 rounded-xl cursor-pointer transition-all"
              style={{ background:'rgba(18,40,76,0.03)', border:'1px solid rgba(36,65,229,0.08)' }}
              onMouseOver={e=>e.currentTarget.style.borderColor='rgba(0,184,217,0.35)'}
              onMouseOut={e=>e.currentTarget.style.borderColor='rgba(36,65,229,0.08)'}
              onClick={() => navigate(`/typer/order/${o.id}`)}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                style={{ background:`${ROLE_COLOR}22` }}>
                <Keyboard className="w-5 h-5" style={{ color:ROLE_COLOR }} />
              </div>
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
              </div>
              <div className="text-right flex-shrink-0">
                <span className="text-xs font-semibold px-2.5 py-1 rounded-full capitalize"
                  style={{ background:`${ROLE_COLOR}22`, color:ROLE_COLOR }}>{o.status}</span>
                <div className="text-xs mt-1" style={{ color:'#5C6E8C' }}>ETA {o.eta}</div>
              </div>
              <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(18,40,76,0.18)' }} />
            </motion.div>
          ))}
        </div>
      </div>
    </div>
  )
}

export default function TyperDashboard() {
  const { getOrdersForRole, orders } = useOrders()
  const navigate = useNavigate()
  const myOrders  = getOrdersForRole('typer')
  const completed = orders.filter(o => o.completedDates?.typer)
  const openOrder = (o) => navigate(`/typer/order/${o.id}`)
  return (
    <Layout navItems={NAV} role="typer" roleColor={ROLE_COLOR}>
      <Routes>
        <Route index element={<TyperHome />} />
        <Route path="order/:id" element={<FulfillmentScreen />} />
        <Route path="notifications" element={<NotificationSettings accent={ROLE_COLOR} />} />
        <Route path="queue" element={<div className="space-y-6">
          <h1 className="text-2xl font-bold" style={{color:'#12284C'}}>To Type</h1>
          <div className="glass-card p-5"><OrdersTable orders={myOrders} onOrderClick={openOrder} /></div>
        </div>} />
        <Route path="completed" element={<div className="space-y-6">
          <h1 className="text-2xl font-bold" style={{color:'#12284C'}}>Completed</h1>
          <div className="glass-card p-5"><OrdersTable orders={completed} onOrderClick={openOrder} /></div>
        </div>} />
      </Routes>
    </Layout>
  )
}
