import React, { useState } from 'react'
import { Routes, Route, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Layout from '../../components/Layout'
import USAMap from '../../components/USAMap'
import {
  LayoutDashboard, PlusCircle, ClipboardList, MessageSquare,
  Package, CheckCircle, Clock, ChevronRight, X, MapPin, Zap, Send, FileText, DollarSign, Search
} from 'lucide-react'
import { clientCode as codeByName, clientName } from '../../data/mockData'
import { openDocument } from '../../lib/backend'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { DEMO_ORDERS } from '../../data/demoData'
import ClientBilling from './ClientBilling'
import { invoiceAmount, invoiceNumber, money, payStatusOf, PAY_STATUS } from '../../lib/billing'

const ROLE_COLOR = '#4d7c2f'
const NAV = [
  { path: '/client',         label: 'Dashboard',   icon: LayoutDashboard },
  { path: '/client/order',   label: 'Place Order', icon: PlusCircle },
  { path: '/client/orders',  label: 'My Orders',   icon: ClipboardList },
  { path: '/client/billing', label: 'Billing',     icon: DollarSign },
  { path: '/client/support', label: 'Support',     icon: MessageSquare },
]
// This client's orders, scoped by their client code — mirrors the Supabase RLS
// (client_code = my_client_code()) so the UI shows exactly what the backend
// would return. Supabase order rows carry `clientCode`; mock orders carry the
// client name, mapped to a code via codeByName. No code → nothing (RLS parity).
function useMyOrders() {
  const { user } = useAuth()
  const { orders } = useOrders()
  if (user?.demo) return DEMO_ORDERS
  const my = user?.clientCode
  if (!my) return []
  const codeOf = (o) => o.clientCode || codeByName(o.client)
  return orders.filter(o => codeOf(o) === my)
}

// Invoice summary card — payment itself happens on the Billing page (ACH/Check).
function InvoiceCard({ order }) {
  const navigate = useNavigate()
  const status = payStatusOf(order)
  const s = PAY_STATUS[status]
  return (
    <div className="glass-card p-5" style={{ border: '1px solid rgba(160,192,112,0.28)' }}>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4" style={{ color: ROLE_COLOR }} />
          <span className="font-semibold text-sm" style={{ color: '#1e293b' }}>{invoiceNumber(order)}</span>
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full" style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
        </div>
        <span className="text-lg font-bold tabular-nums" style={{ color: '#1e293b' }}>{money(invoiceAmount(order))}</span>
      </div>
      {status === 'confirmed' ? (
        <div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(109,188,120,0.12)', border: '1px solid rgba(109,188,120,0.25)', color: '#15803d' }}>
          <CheckCircle className="w-4 h-4" /> Payment received — thank you.
        </div>
      ) : (
        <button onClick={() => navigate('/client/billing')} className="btn-primary w-full text-sm py-2.5 flex items-center justify-center gap-1.5">
          <DollarSign className="w-3.5 h-3.5" />
          {status === 'marked' ? 'View payment status' : 'Pay via ACH / Check'}
        </button>
      )}
    </div>
  )
}

const US_STATES = [
  'Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware',
  'Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky',
  'Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri',
  'Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York',
  'North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island',
  'South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia',
  'Washington','West Virginia','Wisconsin','Wyoming',
]

// Client-facing stages — internal stages (screening/searching/examining/typing) collapse into "In Progress"
const CLIENT_STEPS = ['Received','In Progress','Clarification Responded','Delivered']
function clientStage(order) {
  if (order.status === 'delivered')          return { idx: 3, label: 'Delivered',               color: '#15803d' }
  if (order.clarification === 'responded')   return { idx: 2, label: 'Clarification Responded',  color: '#2563eb' }
  if (['screening','searching','examining','typing'].includes(order.status))
                                             return { idx: 1, label: 'In Progress',              color: '#b45309' }
  return { idx: 0, label: 'Received', color: '#4d7c2f' }
}

// BUG_007: clicking an order opens its detail view (see ClientOrderModal).
function TrackOrder({ order, onOpen }) {
  const stage = clientStage(order)
  const idx = stage.idx
  const sc  = stage.color
  return (
    <div className={`glass-card p-5 ${onOpen ? 'cursor-pointer transition-shadow hover:shadow-lg' : ''}`}
      role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen} onKeyDown={e => onOpen && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}>
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{order.id}</div>
          <div className="font-bold" style={{ color:'#1e293b' }}>{order.client}</div>
          <div className="text-xs" style={{ color:'#64748b' }}>{order.type} · {order.state}</div>
        </div>
        <span className="text-xs font-semibold px-3 py-1.5 rounded-full"
          style={{ background:`${sc}1e`, color:sc }}>{stage.label}</span>
      </div>
      {/* Step tracker */}
      <div className="flex items-center gap-1 my-4">
        {CLIENT_STEPS.map((step,i) => (
          <React.Fragment key={step}>
            <div className="flex flex-col items-center gap-1.5">
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                style={i < idx
                  ? { background:'#3d7020', color:'#f5f7f2' }
                  : i === idx
                  ? { background:'#3d7020', color:'#f5f7f2', boxShadow:`0 0 0 3px rgba(90,140,62,0.25)` }
                  : { background:'rgba(30,41,59,0.08)', color:'#64748b' }}>
                {i < idx ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
              </div>
              <span className="text-[9px] text-center leading-tight whitespace-nowrap hidden sm:block"
                style={{ color: i <= idx ? '#475569' : '#64748b' }}>
                {step}
              </span>
            </div>
            {i < CLIENT_STEPS.length - 1 && (
              <div className="flex-1 h-0.5 rounded-full mb-5"
                style={{ background: i < idx ? '#4d8c2a' : 'rgba(30,41,59,0.10)' }} />
            )}
          </React.Fragment>
        ))}
      </div>
      <div className="flex items-center justify-between text-xs mb-1.5" style={{ color:'#64748b' }}>
        <span>ETA: <span style={{ color:'#1e293b' }}>{order.eta}</span></span>
        <span>{order.progress}% complete</span>
      </div>
      <div className="h-1.5 rounded-full overflow-hidden" style={{ background:'rgba(30,41,59,0.08)' }}>
        <motion.div className="h-full rounded-full"
          initial={{ width:0 }} animate={{ width:`${order.progress}%` }}
          transition={{ duration:1.2, ease:'easeOut' }}
          style={{ background:'linear-gradient(90deg,#3d7020,#8fc268)' }} />
      </div>
    </div>
  )
}

// BUG_007: client-facing order detail. Shows the tracking stage, everything the
// client submitted (workflow.intake), milestone dates, clarification state, and
// any documents delivered to the client (opened via the re-signing openDocument).
function ClientOrderModal({ order, onClose }) {
  const stage = clientStage(order)
  const intake = order.workflow?.intake
  const docs = [
    order.workflow?.commitmentDoc && { ...order.workflow.commitmentDoc, label: 'Title Commitment' },
    ...(order.workflow?.supplementaryDocs || []).filter(d => d.sendToCustomer).map(d => ({ ...d.file, label: 'Supplementary' })),
  ].filter(Boolean)
  const Row = ({ k, v }) => v ? (
    <div><span style={{ color:'#64748b' }}>{k}: </span><span className="font-medium" style={{ color:'#1e293b' }}>{v}</span></div>
  ) : null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background:'rgba(15,23,42,0.45)' }} onClick={onClose}>
      <motion.div initial={{ scale:0.96, opacity:0 }} animate={{ scale:1, opacity:1 }} onClick={e => e.stopPropagation()}
        className="glass-card w-full overflow-y-auto" style={{ maxWidth:560, maxHeight:'90vh', background:'#fff', borderRadius:14 }}>
        <div className="flex items-start justify-between p-5 pb-3">
          <div>
            <div className="font-mono font-semibold text-sm" style={{ color:ROLE_COLOR }}>{order.id}</div>
            <div className="font-bold text-lg" style={{ color:'#1e293b' }}>{order.type}</div>
            <div className="text-xs" style={{ color:'#64748b' }}>{order.county}, {order.state} · placed {order.created}</div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background:`${stage.color}1e`, color:stage.color }}>{stage.label}</span>
            <button onClick={onClose} className="p-1" style={{ color:'#64748b' }}><X className="w-4 h-4" /></button>
          </div>
        </div>
        <div className="px-5 pb-5 space-y-4">
          {order.clarification === 'pending' && (
            <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background:'rgba(220,140,40,0.10)', border:'1px solid rgba(220,140,40,0.25)', color:'#b45309' }}>
              Clarification requested — our team is waiting on additional information for this order.
            </div>
          )}
          <div className="rounded-xl p-4 space-y-1.5 text-sm" style={{ background:'rgba(30,41,59,0.03)', border:'1px solid rgba(30,41,59,0.07)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#64748b' }}>Order details</div>
            <Row k="Property" v={intake?.propertyAddress} />
            <Row k="Parcel / APN" v={intake?.parcelNumberAPN} />
            <Row k="Buyer" v={intake?.buyer} />
            <Row k="Borrower" v={intake?.borrowerName} />
            <Row k="Seller" v={intake?.seller} />
            <Row k="Priority" v={order.priority === 'rush' ? 'RUSH' : 'Normal'} />
            <Row k="Special instructions" v={intake?.specialInstructions} />
            {!intake && <div className="text-xs" style={{ color:'#64748b' }}>Submitted before detailed intake was captured.</div>}
          </div>
          <div className="rounded-xl p-4 text-sm space-y-1.5" style={{ background:'rgba(30,41,59,0.03)', border:'1px solid rgba(30,41,59,0.07)' }}>
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#64748b' }}>Timeline</div>
            <Row k="Placed" v={order.created} />
            <Row k="Estimated delivery" v={order.eta} />
            <Row k="Delivered" v={order.completed} />
            <div className="pt-1"><span style={{ color:'#64748b' }}>Progress: </span><span className="font-medium" style={{ color:'#1e293b' }}>{order.progress}%</span></div>
          </div>
          {docs.length > 0 && (
            <div className="rounded-xl p-4 space-y-2" style={{ background:'rgba(30,41,59,0.03)', border:'1px solid rgba(30,41,59,0.07)' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color:'#64748b' }}>Delivered documents</div>
              {docs.map((d, i) => (
                <div key={d.id || i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(30,41,59,0.08)' }}>
                  <FileText className="w-4 h-4 flex-shrink-0" style={{ color: d.type === 'pdf' ? '#dc2626' : '#2563eb' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color:'#1e293b' }}>{d.name}</div>
                    <div className="text-[10px] uppercase tracking-wide" style={{ color:'#64748b' }}>{d.label}</div>
                  </div>
                  {(d.url || d.path) && (
                    <button onClick={() => openDocument(d)} className="text-xs font-semibold underline" style={{ color:ROLE_COLOR, background:'none', border:'none', cursor:'pointer' }}>Open</button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </motion.div>
    </div>
  )
}

const PRODUCTS = [
  { name:'Current Owner Search', price:75,  tat:'8–16 hr',  desc:'Current owner rundown forward from and including the current vesting document with all supporting documentation. Includes chain of title, legal description, requirements, and exceptions.' },
  { name:'Two Owner Search',     price:100, tat:'16–24 hr', desc:'Current vesting deed and all deeds back to the deed prior to the out-of-family deed. Includes copies of open mortgages and assignments, any judgments and liens against those owners, and tax assessment and current tax info including delinquencies.' },
  { name:'Full Search',          price:150, tat:'24–48 hr', desc:'Current vesting deed and all deeds back to state statute or a developer. Includes open mortgages and assignments, judgments and liens, and tax assessment and current tax information including delinquencies.' },
  { name:'Update / Bringdown',   price:45,  tat:'8–16 hr',  desc:'An extension of a title search to verify no liens have been filed between the original search and the recording of the deed or mortgage. Update on tax info from last effective date; any newly recorded instruments.' },
  { name:'Commercial Search',    price:250, desc:'Commitment-ready report for commercial properties.' },
  { name:'Energy / Infrastructure', price:350, desc:'Solar, wind, pipelines, cell towers, EV infrastructure.' },
  { name:'Tax Search',           desc:'Property tax assessment, current tax status, and delinquency information.' },
  { name:'Patriot Name Search',  desc:'OFAC / Patriot Act compliance name search against government watch lists.' },
  { name:'Bankruptcy Name Search', desc:'Federal bankruptcy court name search for all parties in the transaction.' },
  { name:'Document Retrieval',   desc:'Retrieval of specific recorded documents from county and municipal records.' },
]
const TURNAROUND = [
  { key:'normal', label:'Standard — 48 hrs', fee:0,  desc:'Delivered within 2 business days' },
  { key:'rush',   label:'Rush — 24 hrs',     fee:50, desc:'Priority processing, next business day' },
]

function PlaceOrderPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { createOrder } = useOrders()
  const [step, setStep] = useState(1)
  const [createdId, setCreatedId] = useState(null)
  // BUG_008: a registered client shouldn't retype contact details every order —
  // prefill from the signed-in profile (still editable per order).
  const [first = '', ...rest] = (user?.name || '').split(' ')
  const [form, setForm] = useState({
    searchType:'', state:'', county:'', address:'', city:'', zip:'', parcelId:'',
    buyerFirst:'', buyerLast:'', borrowerFirst:'', borrowerLast:'', sellerFirst:'', sellerLast:'',
    priority:'normal',
    firstName: first, lastName: rest.join(' '),
    email: user?.email || '',
    company: clientName(user?.clientCode) || '',
    role:'', notes:''
  })
  const [submitted, setSubmitted] = useState(false)
  const set = (k,v) => setForm(f => ({ ...f, [k]:v }))
  const submit = async () => {
    const fullName = (a, b) => `${a || ''} ${b || ''}`.trim()
    const buyer = fullName(form.buyerFirst, form.buyerLast)
    const borrower = fullName(form.borrowerFirst, form.borrowerLast)
    const seller = fullName(form.sellerFirst, form.sellerLast)
    const order = await createOrder({
      state: form.state, county: form.county, type: form.searchType || 'Full Search',
      priority: form.priority,
      // Attribute to the signed-in client so the order is trackable in My
      // Orders and readable back under RLS (client_code = my_client_code()).
      clientCode: user?.clientCode || null,
      client: clientName(user?.clientCode) || user?.name || 'Web Order',
      intake: {
        source: 'web', propertyAddress: [form.address, form.city, form.state, form.zip].filter(Boolean).join(', '),
        parcelNumberAPN: form.parcelId, borrowerName: borrower, buyer, seller,
        orderType: form.searchType, from: `${form.firstName} ${form.lastName} <${form.email}>`.trim(),
        company: form.company, role: form.role, specialInstructions: form.notes,
      },
    })
    setCreatedId(order.id)
    setSubmitted(true)
  }

  // Demo is a read-only sandbox — no real orders created.
  if (user?.demo) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ background:'rgba(77,124,47,0.14)' }}>
        <PlusCircle className="w-8 h-8" style={{ color:ROLE_COLOR }} />
      </div>
      <h2 className="text-xl font-bold mb-2" style={{ color:'#1e293b' }}>Placing orders is disabled in the demo</h2>
      <p className="text-sm mb-6" style={{ color:'#475569' }}>
        You're exploring a read-only sandbox. Create a free account to place and track real title orders.
      </p>
      <button onClick={() => navigate('/client/orders')} className="btn-primary text-sm px-5 py-2.5">
        Browse the sample orders instead
      </button>
    </div>
  )

  if (submitted) return (
    <motion.div initial={{ opacity:0, scale:0.95 }} animate={{ opacity:1, scale:1 }}
      className="flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-20 h-20 rounded-full flex items-center justify-center mb-6"
        style={{ background:'rgba(109,188,120,0.18)' }}>
        <CheckCircle className="w-10 h-10" style={{ color:'#15803d' }} />
      </div>
      <h2 className="text-2xl font-bold mb-2" style={{ color:'#1e293b' }}>Order Submitted!</h2>
      <p className="text-sm mb-1" style={{ color:'#475569' }}>
        Assigned <span className="font-mono font-bold" style={{ color:ROLE_COLOR }}>{createdId || 'RTS-10049'}</span>
      </p>
      <p className="text-xs mb-8" style={{ color:'#64748b' }}>
        We'll email a quote to {form.email || 'your email'} within 1 business hour.
      </p>
      <div className="flex gap-3">
        <button onClick={() => { setSubmitted(false); setStep(1); setCreatedId(null) }} className="btn-primary">Place Another</button>
        <button onClick={() => navigate('/client/orders')} className="btn-secondary">Track Order</button>
      </div>
    </motion.div>
  )

  const STEPS = ['Property Info','Search Details','Contact','Review']
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1" style={{ color:'#1e293b' }}>Place a New Order</h1>
        <p className="text-sm" style={{ color:'#64748b' }}>Title search across all 50 states · Confirmation within minutes</p>
      </div>
      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s,i) => (
          <React.Fragment key={s}>
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => i+1 < step && setStep(i+1)}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                style={i+1 < step
                  ? { background:'#3d7020', color:'#f5f7f2' }
                  : i+1 === step
                  ? { background:'#3d7020', color:'#f5f7f2', boxShadow:`0 0 0 3px rgba(90,140,62,0.25)` }
                  : { background:'rgba(30,41,59,0.07)', color:'#64748b' }}>
                {i+1 < step ? <CheckCircle className="w-3.5 h-3.5" /> : i+1}
              </div>
              <span className="text-xs font-medium hidden sm:block"
                style={{ color: i+1===step ? '#1e293b' : '#64748b' }}>{s}</span>
            </div>
            {i < STEPS.length-1 && (
              <div className="flex-1 h-0.5 rounded-full"
                style={{ background: i+1 < step ? '#4d8c2a' : 'rgba(30,41,59,0.10)' }} />
            )}
          </React.Fragment>
        ))}
      </div>
      <AnimatePresence mode="wait">
        <motion.div key={step} initial={{ opacity:0, x:20 }} animate={{ opacity:1, x:0 }} exit={{ opacity:0, x:-20 }}
          className="glass-card p-6">
          <form onSubmit={e => { e.preventDefault(); submit() }}>
            {step===1 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#1e293b' }}>Property Information</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Property State *</label>
                  <select value={form.state} onChange={e=>set('state',e.target.value)} className="input-field text-sm" required>
                    <option value="">Select state…</option>
                    {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>County *</label>
                  <input value={form.county} onChange={e=>set('county',e.target.value)} placeholder="e.g. Miami-Dade" className="input-field text-sm" required/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Property Address</label>
                  <input value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main St, City, State 00000" className="input-field text-sm"/>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>City</label>
                    <input value={form.city} onChange={e=>set('city',e.target.value)} placeholder="Springfield" className="input-field text-sm"/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>ZIP <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.zip} onChange={e=>set('zip',e.target.value)} placeholder="62701" className="input-field text-sm"/>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Parcel / APN # <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <input value={form.parcelId} onChange={e=>set('parcelId',e.target.value)} placeholder="14-25-376-012" className="input-field text-sm"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Parties <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <div className="space-y-2">
                    {[
                      { label:'Buyer',    first:'buyerFirst',    last:'buyerLast' },
                      { label:'Borrower', first:'borrowerFirst', last:'borrowerLast' },
                      { label:'Seller',   first:'sellerFirst',   last:'sellerLast' },
                    ].map(p => (
                      <div key={p.label} className="grid grid-cols-1 sm:grid-cols-[80px,1fr,1fr] gap-2 sm:items-center">
                        <span className="text-xs font-medium" style={{ color:'#475569' }}>{p.label}</span>
                        <input value={form[p.first]} onChange={e=>set(p.first,e.target.value)} placeholder="First Name" className="input-field text-sm"/>
                        <input value={form[p.last]}  onChange={e=>set(p.last,e.target.value)}  placeholder="Last Name"  className="input-field text-sm"/>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {step===2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#1e293b' }}>Search Details</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#64748b' }}>Titled Products *</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PRODUCTS.map(p => {
                      const active = form.searchType === p.name
                      return (
                        <button key={p.name} type="button" onClick={() => set('searchType', p.name)}
                          className="p-3 rounded-xl text-left border transition-all"
                          style={active
                            ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14`, boxShadow:`0 0 0 1px ${ROLE_COLOR}44` }
                            : { border:'1px solid #e2e8f0', background:'#fff' }}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm" style={{ color:'#1e293b' }}>{p.name}</span>
                            {p.price != null && <span className="font-bold text-sm" style={{ color:'#b45309' }}>${p.price}</span>}
                          </div>
                          <p className="text-[11px] mt-1 leading-snug" style={{ color:'#64748b' }}>{p.desc}</p>
                          {p.tat && <span className="inline-block mt-2 text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background:'#f1f5f9', color:'#475569' }}>⏱ {p.tat}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#64748b' }}>Turnaround</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {TURNAROUND.map(t => (
                      <button key={t.key} type="button" onClick={() => set('priority', t.key)}
                        className="p-3 rounded-xl text-left border transition-all"
                        style={form.priority===t.key
                          ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14` }
                          : { border:'1px solid #e2e8f0', background:'#fff' }}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm" style={{ color:'#1e293b' }}>{t.label}</span>
                          <span className="text-xs font-bold" style={{ color: t.fee ? '#b45309' : '#64748b' }}>+${t.fee}</span>
                        </div>
                        <div className="text-xs mt-0.5" style={{ color:'#64748b' }}>{t.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Special Instructions</label>
                  <textarea value={form.notes} onChange={e=>set('notes',e.target.value)} rows={3} className="input-field text-sm resize-none" placeholder="Any notes for the search team…"/>
                </div>
              </div>
            )}
            {step===3 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#1e293b' }}>Contact Information</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>First Name *</label>
                    <input value={form.firstName} onChange={e=>set('firstName',e.target.value)} placeholder="First name" className="input-field text-sm" required/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Last Name *</label>
                    <input value={form.lastName} onChange={e=>set('lastName',e.target.value)} placeholder="Last name" className="input-field text-sm" required/>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Work Email *</label>
                  <input type="email" value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@company.com" className="input-field text-sm" required/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#64748b' }}>Company</label>
                  <input value={form.company} onChange={e=>set('company',e.target.value)} placeholder="Company name" className="input-field text-sm"/>
                </div>
              </div>
            )}
            {step===4 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#1e293b' }}>Review & Submit</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[['State',form.state||'—'],['County',form.county||'—'],['Search Type',form.searchType||'—'],
                    ['Priority',form.priority.toUpperCase()],['Contact',`${form.firstName} ${form.lastName}`.trim()||'—'],['Email',form.email||'—']].map(([k,v]) => (
                    <div key={k} className="glass p-3 rounded-xl">
                      <div className="text-xs mb-0.5" style={{ color:'#64748b' }}>{k}</div>
                      <div className="font-medium text-sm" style={{ color:'#1e293b' }}>{v}</div>
                    </div>
                  ))}
                </div>
                {form.priority==='rush' && (
                  <div className="flex items-center gap-2 p-3 rounded-xl text-sm"
                    style={{ background:'rgba(220,80,60,0.10)', border:'1px solid rgba(220,80,60,0.22)', color:'#dc2626' }}>
                    <Zap className="w-4 h-4 flex-shrink-0" />
                    Rush order selected — additional fees apply. Delivery within 24 hours.
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-3 mt-8">
              {step>1 && <button type="button" onClick={() => setStep(s=>s-1)} className="btn-secondary px-6">Back</button>}
              {step<4
                ? <button type="button" onClick={() => setStep(s=>s+1)} className="btn-primary flex-1">Continue</button>
                : <button type="submit" className="btn-primary flex-1 flex items-center justify-center gap-2">
                    <Send className="w-4 h-4" /> Submit Order
                  </button>
              }
            </div>
          </form>
        </motion.div>
      </AnimatePresence>
    </div>
  )
}

function ClientHome() {
  const myOrders = useMyOrders()
  const navigate = useNavigate()
  const [openOrder, setOpenOrder] = useState(null)
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color:'#1e293b' }}>Client Portal</h1>
          <p className="text-sm" style={{ color:'#475569' }}>Welcome back, Taylor Brooks</p>
        </div>
        <motion.button whileHover={{ scale:1.02 }} whileTap={{ scale:0.98 }} onClick={() => navigate('/client/order')}
          className="btn-primary flex items-center gap-2 text-sm">
          <PlusCircle className="w-4 h-4" /> New Order
        </motion.button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:Package,     label:'Active Orders',   value:'2',   color:ROLE_COLOR },
          { icon:CheckCircle, label:'Completed (YTD)', value:'12',  color:'#15803d' },
          { icon:Clock,       label:'Avg Turnaround',  value:'1.9d',color:'#a16207' },
          { icon:Zap,         label:'Rush Orders',     value:'1',   color:'#b45309' },
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
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="space-y-4">
          <h2 className="font-semibold" style={{ color:'#1e293b' }}>Order Tracking</h2>
          {myOrders.map(o => (
            <React.Fragment key={o.id}>
              <TrackOrder order={o} onOpen={() => setOpenOrder(o)} />
              {o.workflow?.invoiceVisibleToClient && <InvoiceCard order={o} />}
            </React.Fragment>
          ))}
          {openOrder && <ClientOrderModal order={openOrder} onClose={() => setOpenOrder(null)} />}
        </div>
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-1" style={{ color:'#1e293b' }}>Coverage Map</h2>
          <p className="text-xs mb-3" style={{ color:'#64748b' }}>3,140+ counties · All 50 states</p>
          <USAMap compact />
          <div className="mt-4 flex items-center gap-2 text-xs" style={{ color:'#64748b' }}>
            <MapPin className="w-3.5 h-3.5" style={{ color:ROLE_COLOR }} />
            Your searches are in FL, CA, NY
          </div>
        </div>
      </div>
    </div>
  )
}

function SupportPage() {
  const [msg, setMsg]   = useState('')
  const [msgs, setMsgs] = useState([
    { from:'support', text:'Hi Taylor! How can we help you today?', time:'10:30 AM' }
  ])
  const send = () => {
    if (!msg.trim()) return
    setMsgs(m => [...m, { from:'user', text:msg, time:'Now' }])
    setMsg('')
    setTimeout(() => setMsgs(m => [...m, {
      from:'support', text:'Thanks for your message! A team member will respond shortly.', time:'Just now'
    }]), 800)
  }
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color:'#1e293b' }}>Support</h1>
      <div className="glass-card overflow-hidden flex flex-col" style={{ height:500 }}>
        <div className="p-4 flex items-center gap-3" style={{ borderBottom:'1px solid rgba(138,194,104,0.09)' }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background:`${ROLE_COLOR}30` }}>
            <MessageSquare className="w-4 h-4" style={{ color:ROLE_COLOR }} />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color:'#1e293b' }}>Resolute Support</div>
            <div className="flex items-center gap-1.5 text-xs" style={{ color:'#15803d' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background:'#15803d' }} />
              Online · Avg reply under 2 min
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {msgs.map((m,i) => (
            <div key={i} className={`flex ${m.from==='user' ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-xs px-4 py-2.5 rounded-2xl text-sm"
                style={m.from==='user'
                  ? { background:'#3d7020', color:'#f5f7f2' }
                  : { background:'rgba(30,41,59,0.07)', color:'#1e293b', border:'1px solid rgba(138,194,104,0.12)' }}>
                {m.text}
                <div className="text-xs mt-1" style={{ color: m.from==='user' ? '#475569' : '#64748b' }}>
                  {m.time}
                </div>
              </div>
            </div>
          ))}
        </div>
        <div className="p-3 flex gap-2" style={{ borderTop:'1px solid rgba(138,194,104,0.09)' }}>
          <input value={msg} onChange={e=>setMsg(e.target.value)}
            onKeyDown={e => e.key==='Enter' && send()}
            placeholder="Type a message…" className="input-field text-sm flex-1 py-2" />
          <button onClick={send} className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function MyOrdersPage() {
  const myOrders = useMyOrders()
  const [openOrder, setOpenOrder] = useState(null)
  const [q, setQ] = useState('')
  // BUG_006: search across order #, type, status/stage, and property details —
  // works for both active and completed orders so users don't page-hunt.
  const query = q.trim().toLowerCase()
  const shown = !query ? myOrders : myOrders.filter(o => {
    const hay = [
      o.id, o.type, o.status, clientStage(o).label, o.state, o.county,
      o.workflow?.intake?.propertyAddress, o.workflow?.intake?.parcelNumberAPN,
    ].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(query)
  })
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold" style={{ color: '#1e293b' }}>My Orders</h1>
        <div className="relative" style={{ minWidth: 260 }}>
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#94a3b8' }} />
          <input value={q} onChange={e => setQ(e.target.value)}
            placeholder="Search order #, property, status…"
            className="input-field text-sm pl-9 w-full" />
        </div>
      </div>
      <div className="space-y-4">
        {shown.map(o => (
          <React.Fragment key={o.id}>
            <TrackOrder order={o} onOpen={() => setOpenOrder(o)} />
            {o.workflow?.invoiceVisibleToClient && <InvoiceCard order={o} />}
          </React.Fragment>
        ))}
        {shown.length === 0 && (
          <div className="glass-card p-8 text-center text-sm" style={{ color: '#64748b' }}>
            {myOrders.length === 0 ? 'No orders yet.' : `No orders match “${q}”.`}
          </div>
        )}
      </div>
      {openOrder && <ClientOrderModal order={openOrder} onClose={() => setOpenOrder(null)} />}
    </div>
  )
}

function BillingPage() {
  const myOrders = useMyOrders()
  return <ClientBilling myOrders={myOrders} />
}

export default function ClientDashboard() {
  const { user } = useAuth()
  return (
    <Layout navItems={NAV} role="client" roleColor={ROLE_COLOR}>
      {user?.demo && (
        <div className="mb-4 flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm"
          style={{ background:'rgba(77,124,47,0.10)', border:'1px solid rgba(77,124,47,0.28)', color:'#3d7020' }}>
          <Zap className="w-4 h-4 flex-shrink-0" />
          <span><strong>Demo mode</strong> — sample data, read-only. Nothing here is real, and it resets when you refresh.</span>
        </div>
      )}
      <Routes>
        <Route index         element={<ClientHome />} />
        <Route path="order"  element={<PlaceOrderPage />} />
        <Route path="orders" element={<MyOrdersPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="support" element={<SupportPage />} />
      </Routes>
    </Layout>
  )
}
