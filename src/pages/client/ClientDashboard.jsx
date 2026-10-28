import React, { useState, useEffect } from 'react'
import { Routes, Route, Navigate, useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Layout from '../../components/Layout'
import OrderThread from '../../components/OrderThread'
import NotificationSettings from '../../components/NotificationSettings'
import OrderWizard, { ClientAttach } from '../../components/OrderWizard'
import { clientStats } from '../../lib/deskStats'
import {
  LayoutDashboard, PlusCircle, MessageSquare, Inbox, Building2,
  Package, CheckCircle, Clock, ChevronRight, Zap, Send, FileText, DollarSign,
  UploadCloud, Paperclip, Trash2, AlertCircle, Eye, Download
} from 'lucide-react'
import { clientCode as codeByName, clientName, orderProgress, isOrderComplete, lineItemsOf } from '../../data/mockData'
import SubOrders from '../../components/SubOrders'
import { openDocument } from '../../lib/backend'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { useSupport } from '../../context/SupportContext'
import { DEMO_ORDERS } from '../../data/demoData'
import ClientBilling from './ClientBilling'
import BulkImport from './BulkImport'
import { invoiceAmount, invoiceNumber, money, payStatusOf, isBillable,
  payStatusMeta, clientCodeOf, getClientTerms, hydrateClientTerms } from '../../lib/billing'
import { ROLE_COLOR } from '../../lib/ui'
import OrdersTableView from '../../components/OrdersTableView'
import { propertyOf, statusRank, dueByValue, orderedOnValue } from '../../lib/ordersView'
import CompanySettings from './CompanySettings'

const NAV = [
  { path: '/client',         label: 'Dashboard',   icon: LayoutDashboard },
  { path: '/client/order',   label: 'Place Order', icon: PlusCircle },
  { path: '/client/messages',label: 'Messages',    icon: Inbox },
  { path: '/client/billing', label: 'Billing',     icon: DollarSign },
  { path: '/client/settings',label: 'Company',     icon: Building2 },
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
  const s = payStatusMeta(order, getClientTerms(clientCodeOf(order)))
  return (
    <div className="glass-card p-5" style={{ border: '1px solid rgba(160,192,112,0.28)' }}>
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4" style={{ color: ROLE_COLOR }} />
          <span className="font-semibold text-sm" style={{ color: '#12284C' }}>{invoiceNumber(order)}</span>
          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full" style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
        </div>
        <span className="text-lg font-bold tabular-nums" style={{ color: '#12284C' }}>{money(invoiceAmount(order))}</span>
      </div>
      {status === 'confirmed' ? (
        <div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl"
          style={{ background: 'rgba(0,184,217,0.12)', border: '1px solid rgba(0,184,217,0.25)', color: '#15803d' }}>
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


// Client-facing stages: Placed (awaiting admin confirmation) → Received
// (confirmed by admin) → In Progress (any internal stage) → Delivered. On-Hold
// and Clarification are overlays that ride on top of the current step.
const CLIENT_STEPS = ['Placed','Received','In Progress','Delivered']
function clientStage(order) {
  const confirmed = !!order.workflow?.confirmed
  const working = ['screening','searching','searchqc','examining','typing','qc','delivery'].includes(order.status)
  if (order.status === 'cancelled')          return { idx: 0, label: 'Cancelled',               color: '#dc2626' }
  if (order.status === 'delivered')          return { idx: 3, label: 'Delivered',               color: '#15803d' }
  if (order.workflow?.onHold)                return { idx: working ? 2 : 1, label: 'On Hold',    color: '#a16207' }
  if (order.clarification === 'pending')     return { idx: 2, label: 'Clarification Required',  color: '#dc2626' }
  if (order.clarification === 'responded')   return { idx: 2, label: 'Clarification Responded',  color: '#2441E5' }
  if (working)                               return { idx: 2, label: 'In Progress',              color: '#b45309' }
  if (confirmed)                             return { idx: 1, label: 'Received',                 color: '#2441E5' }
  return { idx: 0, label: 'Placed', color: '#2441E5' }
}

// The client's status pill — the CLIENT-FACING stage (clientStage), never an
// internal production stage (screening/typing/QC). Mirrors the admin StatusBadge.
function ClientStatusBadge({ order }) {
  const s = clientStage(order)
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, whiteSpace:'nowrap',
      padding:'3px 10px', borderRadius:99, fontSize:12, fontWeight:600,
      background:`${s.color}14`, color:s.color }}>
      <span style={{ width:6, height:6, borderRadius:99, background:s.color }} />
      {s.label}
    </span>
  )
}

// BUG_007: clicking an order opens its detail view (see OrderDetailPage).
// List cards stay compact — ID, client, type/state and the status pill only;
// stage-by-stage progress belongs on the order's detail page.

// Colour per activity type — mirrors the notification bell (Layout.jsx) so the
// Activity tab reads the same visual language as the bell feed.
const ACTIVITY_DOT = { new: '#2441E5', delivered: '#16a34a', progress: '#d97706', status: '#00B8D9', user: '#2441E5', payment: '#00B8D9' }

// BUG_007 → full order page. Clicking an order opens /client/orders/:id, a
// dedicated page with three tabs:
//   • Overview  — everything the client submitted, documents, billing, actions
//   • Activity  — the order's own slice of the notification feed (status,
//                 clarifications, payments — one chronological stream)
//   • Inbox     — the per-order message thread (shared OrderThread component)
function OrderDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { updateOrder, cancelOrder, respondClarification, activityLog = [] } = useOrders()
  const { getOrderThread, sendMessage } = useSupport()
  const orders = useMyOrders()
  const order = orders.find(o => o.id === id) || null
  const [tab, setTab] = useState('overview')

  // Hooks must run unconditionally — declare state before the not-found guard.
  const [cancelState, setCancelState] = useState(
    order?.status === 'cancelled' ? 'cancelled'
      : order?.workflow?.cancelRequested ? 'requested' : 'none')
  const [clientDocs, setClientDocs] = useState(order?.workflow?.clientDocs || [])
  // Hydrate client terms so the invoice card can resolve overdue accurately.
  const [, bumpTerms] = useState(0)
  useEffect(() => { hydrateClientTerms().then(ok => ok && bumpTerms(n => n + 1)) }, [])

  if (!order) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
      <div className="text-sm" style={{ color:'#5C6E8C' }}>Order not found, or it isn’t one of yours.</div>
      <button onClick={() => navigate('/client/orders')} className="btn-primary text-sm px-5 py-2.5">Back to My Orders</button>
    </div>
  )

  const stage = clientStage(order)
  const intake = order.workflow?.intake
  const canMessage = !user?.demo && !!user?.clientCode
  const canUpload = !user?.demo
  const thread = getOrderThread(order.id)
  // This order's slice of the activity feed (entries tagged by id, or seed
  // entries that only mention it in their text).
  const activity = activityLog.filter(n =>
    n.orderId === order.id || (String(n.action || '').match(/RTS-\d+/)?.[0] === order.id))

  // BUG_003: cancellation — immediate while queued, else a review request.
  const isQueued = order.status === 'received'
  const canCancel = !user?.demo && order.status !== 'delivered' && cancelState === 'none'
  const doCancel = () => {
    const msg = isQueued
      ? 'Cancel this order? It hasn’t been started yet, so it will be cancelled immediately.'
      : 'This order is already being worked on. Request cancellation? Our team will review and confirm.'
    if (!window.confirm(msg)) return
    setCancelState(cancelOrder(order.id, user?.name || 'Client'))
  }
  const syncDocs = (updater) => setClientDocs(prev => {
    const next = typeof updater === 'function' ? updater(prev) : updater
    updateOrder({ ...order, workflow: { ...order.workflow, clientDocs: next } })
    return next
  })
  const docs = [
    order.workflow?.commitmentDoc && { ...order.workflow.commitmentDoc, label: 'Title Commitment' },
    ...(order.workflow?.supplementaryDocs || []).filter(d => d.sendToCustomer).map(d => ({ ...d.file, label: 'Supplementary' })),
  ].filter(Boolean)
  const onSend = ({ text, attachment }) => {
    if (!canMessage) return
    sendMessage({ clientCode: user.clientCode, clientName: clientName(user.clientCode) || user?.name, from: 'client', text, author: user?.name, orderId: order.id, attachment })
    if (order.clarification === 'pending') respondClarification(order.id)   // replying resolves a clarification
  }

  const Row = ({ k, v }) => v ? (
    <div><span style={{ color:'#5C6E8C' }}>{k}: </span><span className="font-medium" style={{ color:'#12284C' }}>{v}</span></div>
  ) : null
  const TABS = [
    { key:'overview', label:'Overview', icon:FileText },
    { key:'activity', label:'Activity', icon:Clock, badge: activity.length || null },
    { key:'inbox',    label:'Inbox',    icon:Inbox, badge: thread.length || null },
  ]

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      {/* Header */}
      <div>
        <button onClick={() => navigate('/client/orders')} className="flex items-center gap-1.5 text-sm mb-3" style={{ color:'#5C6E8C', background:'none', border:'none', padding:0, cursor:'pointer' }}>
          <ChevronRight className="w-4 h-4" style={{ transform:'rotate(180deg)' }} /> Back to My Orders
        </button>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="font-mono font-semibold text-sm" style={{ color:ROLE_COLOR }}>{order.id}</div>
            <div className="font-bold text-xl" style={{ color:'#12284C' }}>{order.type}</div>
            <div className="text-xs" style={{ color:'#5C6E8C' }}>{order.county}, {order.state} · placed {order.created}</div>
          </div>
          <span className="text-xs font-semibold px-3 py-1.5 rounded-full" style={{ background:`${stage.color}1e`, color:stage.color }}>{stage.label}</span>
        </div>
        {/* Stage tracker — detail page only; list cards (TrackOrder) stay compact.
            Steps follow clientStage().idx; overlays (On Hold, Clarification,
            Cancelled) ride on the status pill above. */}
        <div className="flex items-center gap-1 mt-4">
          {CLIENT_STEPS.map((step, i) => (
            <React.Fragment key={step}>
              <div className="flex flex-col items-center gap-1.5">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                  style={i < stage.idx
                    ? { background:ROLE_COLOR, color:'#FFFFFF' }
                    : i === stage.idx
                    ? { background:ROLE_COLOR, color:'#FFFFFF', boxShadow:`0 0 0 3px rgba(90,140,62,0.25)` }
                    : { background:'rgba(18,40,76,0.08)', color:'#5C6E8C' }}>
                  {i < stage.idx ? <CheckCircle className="w-3.5 h-3.5" /> : i + 1}
                </div>
                <span className="text-[9px] text-center leading-tight whitespace-nowrap hidden sm:block"
                  style={{ color: i <= stage.idx ? '#3D5171' : '#5C6E8C' }}>
                  {step}
                </span>
              </div>
              {i < CLIENT_STEPS.length - 1 && (
                <div className="flex-1 h-0.5 rounded-full sm:mb-5"
                  style={{ background: i < stage.idx ? '#1B34C4' : 'rgba(18,40,76,0.10)' }} />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b" style={{ borderColor:'rgba(18,40,76,0.10)' }}>
        {TABS.map(t => {
          const active = tab === t.key
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors"
              style={{ color: active ? ROLE_COLOR : '#5C6E8C', borderBottom: `2px solid ${active ? ROLE_COLOR : 'transparent'}`, marginBottom:-1, background:'none', cursor:'pointer' }}>
              <t.icon className="w-4 h-4" /> {t.label}
              {t.badge ? <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full" style={{ background:`${ROLE_COLOR}1a`, color:ROLE_COLOR }}>{t.badge}</span> : null}
            </button>
          )
        })}
      </div>

      {/* ── Overview ─────────────────────────────────────────────────────── */}
      {tab === 'overview' && (
        <div className="space-y-4">
          {order.workflow?.onHold && (
            <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background:'rgba(161,98,7,0.10)', border:'1px solid rgba(161,98,7,0.28)', color:'#a16207' }}>
              This order is <strong>On Hold</strong>{order.workflow.holdReason ? ` — ${order.workflow.holdReason}` : ''}. Work is paused; we'll resume and let you know.
            </div>
          )}
          {order.clarification === 'pending' && (
            <div className="space-y-2">
              <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.25)', color:'#dc2626' }}>
                <strong>Action needed:</strong> our team requested a clarification. Reply in the <strong>Inbox</strong> tab (or attach a document below) to keep this order moving.
              </div>
              {canUpload && (
                <div>
                  <div className="text-[11px] font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Provide requested documents</div>
                  <ClientAttach orderId={order.id} value={clientDocs} onChange={syncDocs} />
                </div>
              )}
            </div>
          )}
          <div className="glass-card p-4 space-y-1.5 text-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#5C6E8C' }}>Order details</div>
            <Row k="Property" v={lineItemsOf(order).length > 1 ? `${lineItemsOf(order).length} properties — see sub-orders below` : intake?.propertyAddress} />
            <Row k="County / State" v={[order.county, order.state].filter(Boolean).join(', ')} />
            <Row k="Search type" v={intake?.orderType || order.type} />
            <Row k="Property type" v={intake?.propertyType} />
            <Row k="Parcel / APN" v={intake?.parcelNumberAPN} />
            <Row k="Your file #" v={order.clientFileNo} />
            <Row k="Buyer" v={intake?.buyer} />
            <Row k="Borrower" v={intake?.borrowerName} />
            <Row k="Seller" v={intake?.seller} />
            <Row k="Priority" v={order.priority === 'rush' ? 'RUSH' : 'Normal'} />
            <Row k="Special instructions" v={intake?.specialInstructions} />
            {!intake && <div className="text-xs" style={{ color:'#5C6E8C' }}>Submitted before detailed intake was captured.</div>}
          </div>
          <SubOrders order={order} />
          <div className="glass-card p-4 text-sm space-y-1.5">
            <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#5C6E8C' }}>Timeline</div>
            <Row k="Placed" v={order.created} />
            <Row k="Estimated delivery" v={order.eta} />
            <Row k="Delivered" v={order.completed} />
            <div className="pt-1"><span style={{ color:'#5C6E8C' }}>Progress: </span><span className="font-medium" style={{ color:'#12284C' }}>{isOrderComplete(order) ? 'Completed (100%)' : `${orderProgress(order)}%`}</span></div>
          </div>
          {clientDocs.length > 0 && order.clarification !== 'pending' && (
            <div className="glass-card p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color:'#5C6E8C' }}>Your attachments</div>
              {clientDocs.map((d, i) => (
                <div key={d.id || i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(18,40,76,0.08)' }}>
                  <FileText className="w-4 h-4 flex-shrink-0" style={{ color: d.type === 'pdf' ? '#dc2626' : d.type === 'word' ? '#2441E5' : '#5C6E8C' }} />
                  <div className="flex-1 min-w-0"><div className="text-[13px] font-medium truncate" style={{ color:'#12284C' }}>{d.name}</div></div>
                  {(d.url || d.path) && (
                    <button onClick={() => openDocument(d)} className="text-xs font-semibold underline" style={{ color:ROLE_COLOR, background:'none', border:'none', cursor:'pointer' }}>Open</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {docs.length > 0 && (
            <div className="glass-card p-4 space-y-2">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color:'#5C6E8C' }}>Delivered documents</div>
              {docs.map((d, i) => (
                <div key={d.id || i} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(18,40,76,0.08)' }}>
                  <FileText className="w-4 h-4 flex-shrink-0" style={{ color: d.type === 'pdf' ? '#dc2626' : '#2441E5' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px] font-medium truncate" style={{ color:'#12284C' }}>{d.name}</div>
                    <div className="text-[10px] uppercase tracking-wide" style={{ color:'#5C6E8C' }}>{d.label}</div>
                  </div>
                  {(d.url || d.path) && (
                    <button onClick={() => openDocument(d)} className="text-xs font-semibold underline" style={{ color:ROLE_COLOR, background:'none', border:'none', cursor:'pointer' }}>Open</button>
                  )}
                </div>
              ))}
            </div>
          )}
          {/* Billing summary — the invoice card the client already knows. */}
          {order.workflow?.invoiceVisibleToClient ? (
            <InvoiceCard order={order} />
          ) : (
            <div className="glass-card p-4 text-sm" style={{ color:'#5C6E8C' }}>
              <div className="text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color:'#5C6E8C' }}>Billing</div>
              No invoice yet — it becomes available once the order is delivered.
            </div>
          )}
          {/* Actions */}
          {cancelState === 'cancelled' && (
            <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
              This order has been cancelled.
            </div>
          )}
          {cancelState === 'requested' && (
            <div className="text-xs px-3 py-2.5 rounded-xl" style={{ background:'rgba(220,140,40,0.10)', border:'1px solid rgba(220,140,40,0.25)', color:'#b45309' }}>
              Cancellation requested — our team is reviewing and will confirm shortly.
            </div>
          )}
          {canCancel && (
            <button onClick={doCancel}
              className="w-full text-sm font-semibold px-4 py-2.5 rounded-xl transition-colors"
              style={{ background:'#fff', border:'1px solid rgba(220,38,38,0.35)', color:'#dc2626', cursor:'pointer' }}
              onMouseOver={e => e.currentTarget.style.background = 'rgba(220,38,38,0.06)'}
              onMouseOut={e => e.currentTarget.style.background = '#fff'}>
              {isQueued ? 'Cancel order' : 'Request cancellation'}
            </button>
          )}
        </div>
      )}

      {/* ── Activity ─────────────────────────────────────────────────────── */}
      {tab === 'activity' && (
        <div className="glass-card p-4">
          {activity.length === 0 ? (
            <div className="text-sm text-center py-8" style={{ color:'#5C6E8C' }}>No activity on this order yet.</div>
          ) : (
            <div className="space-y-0">
              {activity.map((n, i) => (
                <div key={n.id || i} className="flex gap-3 py-3 border-b last:border-b-0" style={{ borderColor:'rgba(18,40,76,0.07)' }}>
                  <span className="w-2 h-2 rounded-full mt-1.5 flex-shrink-0" style={{ background: ACTIVITY_DOT[n.type] || '#5C6E8C' }} />
                  <div className="flex-1 min-w-0">
                    <div className="text-[13px]" style={{ color:'#12284C' }}>{n.action}</div>
                    {n.time && <div className="text-[11px] mt-0.5" style={{ color:'#9AA8BF' }}>{n.time}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Inbox ────────────────────────────────────────────────────────── */}
      {tab === 'inbox' && (
        <div className="glass-card p-4">
          <OrderThread orderId={order.id} messages={thread} viewerSide="client" canSend={canMessage} onSend={onSend}
            emptyText="No messages yet on this order. Send a question or a document to the team." />
        </div>
      )}
    </div>
  )
}


// The client's landing page IS the orders hub: at-a-glance tiles + a recent-
// activity panel over the same filterable/sortable orders table used everywhere
// (OrdersTableView). It replaced the old tracking-card list and the separate
// My Orders page, so a client has one place to see and organize their orders.
function ClientHome() {
  const myOrders = useMyOrders()
  const { user } = useAuth()
  const { getOrderThread } = useSupport()
  const navigate = useNavigate()
  const stats = clientStats(myOrders)
  // Pull durable payment terms into the cache so the orders table's Outstanding /
  // Overdue chips use this client's real due dates (not the per-order default).
  const [, bumpTerms] = useState(0)
  useEffect(() => { hydrateClientTerms().then(ok => ok && bumpTerms(n => n + 1)) }, [])
  // Outstanding $ — billable orders not yet confirmed paid (the money still owed).
  const outstanding = myOrders.filter(isBillable)
    .filter(o => payStatusOf(o) !== 'confirmed')
    .reduce((a, o) => a + invoiceAmount(o), 0)

  // Recent activity — the client's most recent orders with their latest message
  // (a reply from Resolute is flagged with a dot), or the order's placement line.
  const recent = [...myOrders]
    .sort((a, b) => String(b.created || '').localeCompare(String(a.created || '')))
    .slice(0, 5)
    .map(o => ({ o, last: getOrderThread(o.id).slice(-1)[0] || null }))

  // Export every one of this client's orders to Excel (moved from My Orders).
  const [exporting, setExporting] = useState(false)
  const [exportErr, setExportErr] = useState('')
  const exportOrders = async () => {
    if (exporting || !myOrders.length) return
    setExporting(true); setExportErr('')
    try {
      const XLSX = await import('xlsx')
      const ws = XLSX.utils.json_to_sheet(myOrders.map(exportRow), { header: EXPORT_COLUMNS.map(([label]) => label) })
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'Orders')
      XLSX.writeFile(wb, 'resolute-my-orders.xlsx')
    } catch (e) {
      console.error('[exportOrders]', e?.message || e)
      setExportErr('We couldn’t create the export just now. Please try again.')
    } finally { setExporting(false) }
  }

  const tiles = [
    { icon:Package,     label:'Active orders',      value:stats.active,       color:ROLE_COLOR },
    { icon:CheckCircle, label:'Completed this year', value:stats.completedYtd, color:'#15803d' },
    { icon:Zap,         label:'Rush in progress',    value:stats.rush,         color:'#b45309' },
    { icon:DollarSign,  label:'Outstanding',         value:money(outstanding), color:'#b45309' },
  ]

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Client Portal</h1>
          <p className="text-sm" style={{ color:'#3D5171' }}>Welcome back{user?.name ? `, ${user.name}` : ''}</p>
        </div>
        <motion.button whileHover={{ scale:1.02 }} whileTap={{ scale:0.98 }} onClick={() => navigate('/client/order')}
          className="btn-primary flex items-center gap-2 text-sm">
          <PlusCircle className="w-4 h-4" /> New Order
        </motion.button>
      </div>

      {/* At-a-glance tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {tiles.map(s => (
          <motion.div key={s.label} initial={{ opacity:0, y:12 }} animate={{ opacity:1, y:0 }} className="stat-card">
            <div className="w-9 h-9 rounded-xl mb-3 flex items-center justify-center" style={{ background:`${s.color}22` }}>
              <s.icon className="w-4 h-4" style={{ color:s.color }} />
            </div>
            <div className="text-2xl font-bold" style={{ color:'#12284C' }}>{s.value}</div>
            <div className="text-sm" style={{ color:'#3D5171' }}>{s.label}</div>
          </motion.div>
        ))}
      </div>

      {/* Recent activity */}
      {recent.length > 0 && (
        <div className="glass-card p-5">
          <h2 className="font-semibold mb-3" style={{ color:'#12284C' }}>Recent activity</h2>
          <div className="space-y-1">
            {recent.map(({ o, last }) => (
              <button key={o.id} onClick={() => navigate(last ? `/client/messages?order=${o.id}` : `/client/orders/${o.id}`)}
                className="w-full text-left flex items-center gap-3 p-2.5 rounded-xl transition-colors"
                onMouseOver={e => e.currentTarget.style.background = 'rgba(18,40,76,0.03)'}
                onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                <span className="font-mono text-xs font-semibold flex-shrink-0" style={{ color:ROLE_COLOR }}>{o.id}</span>
                <ClientStatusBadge order={o} />
                <span className="text-xs flex-1 truncate" style={{ color:'#5C6E8C' }}>
                  {last
                    ? `${last.from === 'support' ? 'Reply from Resolute' : 'You'}: ${(last.text || (last.attachment ? `📎 ${last.attachment.name}` : '')).slice(0, 72)}`
                    : `${o.type} · placed ${o.created || '—'}`}
                </span>
                {last?.from === 'support' && <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background:'#dc2626' }} title="New reply" />}
                <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color:'rgba(18,40,76,0.18)' }} />
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Orders hub — the same filters + column sorting used across the portal */}
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <h2 className="font-semibold" style={{ color:'#12284C' }}>Your Orders</h2>
          <button type="button" onClick={exportOrders} disabled={exporting || !myOrders.length}
            title={myOrders.length ? 'Download all your orders as an Excel file' : 'No orders to export yet'}
            className="btn-secondary text-sm px-4 py-2.5 flex items-center gap-2"
            style={exporting || !myOrders.length ? { opacity:0.6, cursor:'not-allowed' } : undefined}>
            <Download className="w-4 h-4" /> {exporting ? 'Exporting…' : 'Export'}
          </button>
        </div>
        {exportErr && <div className="text-xs" style={{ color:'#dc2626' }}>{exportErr}</div>}
        <OrdersTableView
          orders={myOrders} columns={clientOrderColumns} search={clientOrderSearch}
          onRowClick={o => navigate(`/client/orders/${o.id}`)} accent={ROLE_COLOR}
          emptyText={myOrders.length ? 'No orders match your filters.' : 'No orders yet.'} />
      </div>
    </div>
  )
}

// Support routes to an in-portal Admin inbox (SupportContext). The client sees
// their own thread; Admin replies land here. Demo users get a local-only echo.
// Dedicated per-order Messages inbox (Qualia-style): order list on the left,
// the selected order's full thread (cards + attachments) on the right.
function MessagesPage() {
  const { user } = useAuth()
  const { getOrderThread, sendMessage } = useSupport()
  const { respondClarification } = useOrders()
  const orders = useMyOrders()
  const [params] = useSearchParams()
  const [activeId, setActiveId] = useState(null)
  const active = orders.find(o => o.id === activeId) || orders[0] || null
  // Preselect from ?order= (deep link from an order's "Open conversation").
  React.useEffect(() => {
    const q = params.get('order')
    if (q && orders.some(o => o.id === q)) setActiveId(q)
  }, [params, orders])

  const canMessage = !user?.demo && !!user?.clientCode
  const thread = active ? getOrderThread(active.id) : []
  const lastOf = (o) => { const t = getOrderThread(o.id); return t[t.length - 1] || null }
  const onSend = ({ text, attachment }) => {
    if (!active || !canMessage) return
    sendMessage({ clientCode: user.clientCode, clientName: clientName(user.clientCode) || user?.name, from: 'client', text, author: user?.name, orderId: active.id, attachment })
    if (active.clarification === 'pending') respondClarification(active.id)   // replying resolves a clarification
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Messages</h1>
      {orders.length === 0 ? (
        <div className="glass-card p-8 text-center text-sm" style={{ color:'#5C6E8C' }}>No orders yet — messages are tied to an order.</div>
      ) : (
        <div className="grid gap-4" style={{ gridTemplateColumns:'minmax(220px, 300px) 1fr' }}>
          {/* order list */}
          <div className="glass-card overflow-hidden" style={{ padding:0 }}>
            {orders.map(o => {
              const last = lastOf(o); const isActive = active && o.id === active.id
              return (
                <button key={o.id} onClick={() => setActiveId(o.id)}
                  className="w-full text-left p-3 border-b" style={{ borderColor:'rgba(18,40,76,0.08)', background: isActive ? 'rgba(36,65,229,0.08)' : 'transparent', cursor:'pointer' }}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs font-semibold" style={{ color:ROLE_COLOR }}>{o.id}</span>
                    {last && last.from === 'support' && <span className="w-2 h-2 rounded-full" style={{ background:'#dc2626' }} title="New reply" />}
                  </div>
                  <div className="text-[13px] font-medium truncate" style={{ color:'#12284C' }}>{o.type}</div>
                  <div className="text-[11px] truncate" style={{ color:'#9AA8BF' }}>
                    {last ? `${last.from === 'client' ? 'You: ' : ''}${last.text || (last.attachment ? '📎 ' + last.attachment.name : '')}` : 'No messages yet'}
                  </div>
                </button>
              )
            })}
          </div>
          {/* thread */}
          <div className="glass-card p-4">
            {active && (
              <div className="mb-3 pb-3" style={{ borderBottom:'1px solid #DDE3EC' }}>
                <div className="font-mono text-xs font-semibold" style={{ color:ROLE_COLOR }}>{active.id}</div>
                <div className="font-bold" style={{ color:'#12284C' }}>{active.type} · {active.county}, {active.state}</div>
              </div>
            )}
            {active && (
              <OrderThread orderId={active.id} messages={thread} viewerSide="client" canSend={canMessage} onSend={onSend}
                emptyText="No messages yet on this order. Send a question or a document to the team." />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SupportPage() {
  const { user } = useAuth()
  const { getThread, sendMessage } = useSupport()
  const [msg, setMsg] = useState('')
  const clientCode = user?.clientCode || (user?.demo ? 'DEMO' : null)
  const thread = clientCode ? getThread(clientCode) : null
  const greeting = { from:'support', text:`Hi ${(user?.name || '').split(' ')[0] || 'there'}! How can we help you today?`, time:'' }
  const messages = thread?.messages?.length ? thread.messages : [greeting]

  const send = () => {
    const text = msg.trim()
    if (!text || !clientCode) return
    sendMessage({ clientCode, clientName: clientName(user?.clientCode) || user?.name, from:'client', text, author: user?.name })
    setMsg('')
  }
  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Support</h1>
      <div className="glass-card overflow-hidden flex flex-col" style={{ height:500 }}>
        <div className="p-4 flex items-center gap-3" style={{ borderBottom:'1px solid rgba(36,65,229,0.09)' }}>
          <div className="w-8 h-8 rounded-xl flex items-center justify-center"
            style={{ background:`${ROLE_COLOR}30` }}>
            <MessageSquare className="w-4 h-4" style={{ color:ROLE_COLOR }} />
          </div>
          <div>
            <div className="font-semibold text-sm" style={{ color:'#12284C' }}>Resolute Support</div>
            <div className="flex items-center gap-1.5 text-xs" style={{ color:'#15803d' }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ background:'#15803d' }} />
              We reply from the portal — you'll see responses here.
            </div>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.map((m,i) => (
            <div key={m.id || i} className={`flex ${m.from==='client' ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-xs px-4 py-2.5 rounded-2xl text-sm"
                style={m.from==='client'
                  ? { background:'#2441E5', color:'#FFFFFF' }
                  : { background:'rgba(18,40,76,0.07)', color:'#12284C', border:'1px solid rgba(36,65,229,0.12)' }}>
                {m.text}
                {m.time && <div className="text-xs mt-1" style={{ color: m.from==='client' ? '#c7d9b8' : '#5C6E8C' }}>{m.time}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="p-3 flex gap-2" style={{ borderTop:'1px solid rgba(36,65,229,0.09)' }}>
          <input value={msg} onChange={e=>setMsg(e.target.value)}
            placeholder="Type a message…" className="input-field text-sm flex-1 py-2" />
          <button onClick={send} className="btn-primary px-4 py-2 text-sm flex items-center gap-1.5">
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

// My Orders → Excel: one flat row per order. Property/contact details live on
// workflow.intake, read defensively for older, partial and combined bulk
// orders; missing values export as ''. A combined bulk order stays one row —
// its property columns are the first property, which the import keeps at the
// intake root. The intake stores the address as one line (propertyAddress),
// so it exports whole rather than as separate City/ZIP columns.
const cell = (v) => (v == null || typeof v === 'object' ? '' : typeof v === 'number' ? v : String(v))
const text = (v) => String(cell(v)).trim()
// Explicit intake field first (e.g. intake.buyer), else that role's names in intake.parties.
const partyNames = (intake, field, role) => text(intake[field])
  || (Array.isArray(intake.parties) ? intake.parties : [])
    .filter(p => p && p.role === role).map(p => text(p.name)).filter(Boolean).join(', ')
const EXPORT_COLUMNS = [
  ['Order ID',         (o) => o.id],
  ['Business Name',    (o, i) => cell(i.company) || o.client],
  ['Your File #',      (o) => o.clientFileNo],
  ['Search Type',      (o, i) => cell(o.type) || i.orderType],
  ['Property Type',    (o, i) => i.propertyType],
  ['State',            (o) => o.state],
  ['County',           (o) => o.county],
  ['Property Address', (o, i) => i.propertyAddress],
  ['Parcel / APN',     (o, i) => i.parcelNumberAPN],
  ['Properties',       (o, i) => (Array.isArray(i.properties) && i.properties.length) || 1],
  ['Buyer',            (o, i) => partyNames(i, 'buyer', 'Buyer')],
  ['Seller',           (o, i) => partyNames(i, 'seller', 'Seller')],
  ['Borrower',         (o, i) => partyNames(i, 'borrowerName', 'Borrower')],
  ['Priority',         (o) => (o.priority === 'rush' ? 'Rush' : o.priority === 'normal' ? 'Normal' : o.priority)],
  ['Status',           (o) => clientStage(o).label],
  ['Placed',           (o) => o.created],
]
const exportRow = (o) => {
  const intake = (o.workflow?.intake && typeof o.workflow.intake === 'object') ? o.workflow.intake : {}
  return Object.fromEntries(EXPORT_COLUMNS.map(([label, get]) => [label, cell(get(o, intake))]))
}

// Client columns = the Qualia set MINUS Customer and Assignee. C1: the client's
// own company name never appears on their own orders list. Status is the
// client-facing stage (ClientStatusBadge), never an internal production stage.
const clientOrderColumns = [
  { header: 'Order', render: o => (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}>
      <span style={{ fontFamily:'monospace', fontWeight:700, fontSize:12, color:ROLE_COLOR }}>{o.id}</span>
      {o.priority === 'rush' && (
        <span style={{ fontSize:10, fontWeight:700, padding:'2px 6px', borderRadius:4, background:'#fef2f2', color:'#dc2626' }}>RUSH</span>
      )}
    </span>
  ) },
  { header: 'Status', render: o => <ClientStatusBadge order={o} />, sortValue: statusRank },
  { header: 'File #', render: o => <span style={{ fontFamily:'monospace', fontSize:11.5 }}>{o.clientFileNo || '—'}</span> },
  { header: 'Product', render: o => o.type },
  { header: 'Property', render: o => (
    <span title={propertyOf(o)} style={{ display:'inline-block', maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'bottom' }}>{propertyOf(o)}</span>
  ) },
  { header: 'Total Price', render: o => {
    // A payment-status word (Outstanding / Overdue / Awaiting confirmation /
    // Paid / Bounced) applies only once an order is billable; before delivery
    // the amount is a catalog estimate, so show "est." rather than a false status.
    const m = isBillable(o) ? payStatusMeta(o, getClientTerms(clientCodeOf(o))) : null
    return (
      <span>
        <span style={{ fontWeight:600, color:'#12284C' }}>{money(invoiceAmount(o))}</span>
        {m
          ? <span style={{ marginLeft:6, fontSize:11, fontWeight:600, color:m.color }}>{m.label}</span>
          : <span style={{ marginLeft:6, fontSize:11, color:'#9AA8BF' }}>est.</span>}
      </span>
    )
  }, sortValue: o => invoiceAmount(o) },
  { header: 'Ordered On', render: o => o.created || '—', sortValue: orderedOnValue },
  { header: 'Due By', render: o => o.completed ? `Done ${o.completed}` : (o.eta || '—'), sortValue: dueByValue },
]

// Search across order #, product, client-facing status and property details.
const clientOrderSearch = (o) => [
  o.id, o.type, clientStage(o).label, o.state, o.county,
  o.workflow?.intake?.propertyAddress, o.workflow?.intake?.parcelNumberAPN, o.clientFileNo,
].filter(Boolean).join(' ')

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
          style={{ background:'rgba(36,65,229,0.10)', border:'1px solid rgba(36,65,229,0.28)', color:'#2441E5' }}>
          <Zap className="w-4 h-4 flex-shrink-0" />
          <span><strong>Demo mode</strong> — sample data, read-only. Nothing here is real, and it resets when you refresh.</span>
        </div>
      )}
      <Routes>
        <Route index         element={<ClientHome />} />
        <Route path="order"  element={<OrderWizard mode="client" />} />
        {/* My Orders was folded into the Dashboard (orders hub); keep the path as
            a redirect so old links/bookmarks still land somewhere sensible. */}
        <Route path="orders" element={<Navigate to="/client" replace />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        {/* No nav entry and no email ever links here — client contact is
            portal-only, so a client is never a notification recipient. The route
            exists so the URL explains itself instead of rendering a blank page. */}
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="settings" element={<CompanySettings />} />
        <Route path="support" element={<SupportPage />} />
      </Routes>
    </Layout>
  )
}
