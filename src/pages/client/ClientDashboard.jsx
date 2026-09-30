import React, { useState, useEffect } from 'react'
import { Routes, Route, useNavigate, useSearchParams, useParams } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import Layout from '../../components/Layout'
import OrderThread from '../../components/OrderThread'
import NotificationSettings from '../../components/NotificationSettings'
import { clientStats } from '../../lib/deskStats'
import {
  LayoutDashboard, PlusCircle, ClipboardList, MessageSquare, Inbox,
  Package, CheckCircle, Clock, ChevronRight, Zap, Send, FileText, DollarSign, Search,
  UploadCloud, Paperclip, Trash2, AlertCircle, Eye, Download
} from 'lucide-react'
import { clientCode as codeByName, clientName, orderProgress, isOrderComplete, US_STATES, stateName } from '../../data/mockData'
import { PRODUCTS } from '../../data/products'
import { isSupabaseConfigured, openDocument, uploadDocument } from '../../lib/backend'
import { fileKind, uid } from '../../data/fulfillment'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { useSupport } from '../../context/SupportContext'
import { DEMO_ORDERS } from '../../data/demoData'
import ClientBilling from './ClientBilling'
import BulkImport from './BulkImport'
import { invoiceAmount, invoiceNumber, money, payStatusOf, PAY_STATUS } from '../../lib/billing'
import { ROLE_COLOR } from '../../lib/ui'

const NAV = [
  { path: '/client',         label: 'Dashboard',   icon: LayoutDashboard },
  { path: '/client/order',   label: 'Place Order', icon: PlusCircle },
  { path: '/client/orders',  label: 'My Orders',   icon: ClipboardList },
  { path: '/client/messages',label: 'Messages',    icon: Inbox },
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
  const working = ['screening','searching','examining','typing','delivery'].includes(order.status)
  if (order.status === 'cancelled')          return { idx: 0, label: 'Cancelled',               color: '#dc2626' }
  if (order.status === 'delivered')          return { idx: 3, label: 'Delivered',               color: '#15803d' }
  if (order.workflow?.onHold)                return { idx: working ? 2 : 1, label: 'On Hold',    color: '#a16207' }
  if (order.clarification === 'pending')     return { idx: 2, label: 'Clarification Required',  color: '#dc2626' }
  if (order.clarification === 'responded')   return { idx: 2, label: 'Clarification Responded',  color: '#2441E5' }
  if (working)                               return { idx: 2, label: 'In Progress',              color: '#b45309' }
  if (confirmed)                             return { idx: 1, label: 'Received',                 color: '#2441E5' }
  return { idx: 0, label: 'Placed', color: '#2441E5' }
}

// BUG_007: clicking an order opens its detail view (see OrderDetailPage).
// List cards stay compact — ID, client, type/state and the status pill only;
// stage-by-stage progress belongs on the order's detail page.
function TrackOrder({ order, onOpen }) {
  const stage = clientStage(order)
  const sc = stage.color
  return (
    <div className={`glass-card p-4 ${onOpen ? 'cursor-pointer transition-shadow hover:shadow-lg' : ''}`}
      role={onOpen ? 'button' : undefined} tabIndex={onOpen ? 0 : undefined}
      onClick={onOpen} onKeyDown={e => onOpen && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onOpen())}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono font-semibold text-sm" style={{ color: ROLE_COLOR }}>{order.id}</div>
          <div className="font-bold" style={{ color:'#12284C' }}>{order.client}</div>
          <div className="text-xs" style={{ color:'#5C6E8C' }}>{order.type} · {order.state}</div>
        </div>
        <span className="text-xs font-semibold px-3 py-1.5 rounded-full"
          style={{ background:`${sc}1e`, color:sc }}>{stage.label}</span>
      </div>
    </div>
  )
}

// BUG_004: client-facing multi-file attach (light theme). Clients attach
// reference material (deed scans, prior policies, payoff letters, etc.).
// `value` is an array of doc refs { id, name, type, status, file?, url?, path? }.
// When `orderId` is given (existing order) files upload immediately to Storage;
// otherwise they're STAGED with the raw File (uploaded on order submit) and an
// object URL so they preview in-session even in mock mode.
const CLIENT_ATTACH_ACCEPT = '.pdf,.doc,.docx,.jpg,.jpeg,.png,.tif,.tiff,application/pdf,image/*'
const validAttach = (file) => /\.(pdf|docx?|jpe?g|png|tiff?)$/i.test(file.name || '')

function ClientAttach({ orderId = null, value = [], onChange, accent = ROLE_COLOR }) {
  const inputRef = React.useRef(null)
  const [err, setErr] = useState('')
  const [drag, setDrag] = useState(false)

  const add = async (list) => {
    const incoming = Array.from(list || [])
    if (!incoming.length) return
    if (incoming.some(f => !validAttach(f))) { setErr('PDF, Word, or image files only'); return }
    setErr('')
    for (const file of incoming) {
      const ref = { id: uid(), name: file.name, type: fileKind(file.name), status: 'staged', file, url: URL.createObjectURL(file) }
      if (orderId && isSupabaseConfigured) {
        ref.status = 'uploading'; delete ref.file
        onChange(v => [...v, ref])
        try { const { url, path } = await uploadDocument(orderId, file); onChange(v => v.map(x => x.id === ref.id ? { ...x, status: 'done', url, path } : x)) }
        catch { onChange(v => v.map(x => x.id === ref.id ? { ...x, status: 'error' } : x)) }
      } else {
        onChange(v => [...v, ref])
      }
    }
  }
  const remove = (id) => onChange(v => v.filter(x => x.id !== id))

  return (
    <div className="space-y-2">
      <div role="button" tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputRef.current?.click() } }}
        onDragOver={e => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={e => { e.preventDefault(); setDrag(false); add(e.dataTransfer.files) }}
        className="rounded-xl flex flex-col items-center justify-center py-5 px-4 cursor-pointer transition-all"
        style={{ border:`1.5px dashed ${drag ? accent : 'rgba(36,65,229,0.30)'}`, background: drag ? `${accent}10` : 'transparent' }}>
        <UploadCloud className="w-6 h-6 mb-1.5" style={{ color: drag ? accent : '#5C6E8C' }} />
        <div className="text-sm font-medium" style={{ color:'#12284C' }}>Drag &amp; drop or <span style={{ color:accent }}>browse</span></div>
        <div className="text-[11px] mt-0.5" style={{ color:'#5C6E8C' }}>PDF, Word, or image · up to 25 MB each</div>
        <input ref={inputRef} type="file" accept={CLIENT_ATTACH_ACCEPT} multiple className="hidden"
          onChange={e => { add(e.target.files); e.target.value = '' }} />
      </div>
      {err && <div className="flex items-center gap-1.5 text-[12px]" style={{ color:'#dc2626' }}><AlertCircle className="w-3.5 h-3.5" /> {err}</div>}
      {value.length > 0 && (
        <div className="space-y-1.5">
          {value.map(f => (
            <div key={f.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(18,40,76,0.10)' }}>
              <FileText className="w-4 h-4 flex-shrink-0" style={{ color: f.type === 'pdf' ? '#dc2626' : f.type === 'word' ? '#2441E5' : '#5C6E8C' }} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-medium truncate" style={{ color:'#12284C' }}>{f.name}</div>
                <div className="text-[10px]" style={{ color:'#5C6E8C' }}>
                  {f.status === 'uploading' ? 'Uploading…' : f.status === 'error' ? 'Upload failed' : f.status === 'staged' ? 'Ready to send' : 'Uploaded'}
                </div>
              </div>
              {(f.url || f.path) && f.status !== 'uploading' && (
                <button type="button" onClick={() => openDocument(f)} title="Preview" className="p-1" style={{ color:'#5C6E8C' }}><Eye className="w-4 h-4" /></button>
              )}
              <button type="button" onClick={() => remove(f.id)} title="Remove" className="p-1" style={{ color:'#dc2626' }}><Trash2 className="w-4 h-4" /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

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
            <Row k="Property" v={intake?.propertyAddress} />
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
          {Array.isArray(intake?.properties) && intake.properties.length > 1 && (
            <div className="glass-card p-4 space-y-2 text-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color:'#5C6E8C' }}>
                Properties in this order ({intake.properties.length})
              </div>
              {intake.properties.map((p, i) => {
                const addr = [p.address, p.city, stateName(p.state) || p.state, p.zip].filter(Boolean).join(', ')
                return (
                  <div key={i} className="px-3 py-2 rounded-lg" style={{ background:'#fff', border:'1px solid rgba(18,40,76,0.08)' }}>
                    <div className="font-medium" style={{ color:'#12284C' }}>{i + 1}. {addr || '—'}</div>
                    <div className="text-xs" style={{ color:'#5C6E8C' }}>
                      {[p.county && `${p.county} County`, p.parcelId && `APN ${p.parcelId}`].filter(Boolean).join(' · ') || '—'}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
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

const TURNAROUND = [
  { key:'normal', label:'Standard — 48 hrs', fee:0,  desc:'Delivered within 2 business days' },
  { key:'rush',   label:'Rush — 24 hrs',     fee:50, desc:'Priority processing, next business day' },
]

// County list per state, served from public/ (us-atlas, ~32 KB) and fetched once
// on demand so it never weighs down the initial bundle. Module-level cache keeps
// it across wizard remounts. Absent/failed load → the county field is a plain
// text input (still works), so it degrades gracefully offline.
let _countiesCache = null
function PlaceOrderPage() {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { createOrder, updateOrder } = useOrders()
  const [step, setStep] = useState(1)
  const [mode, setMode] = useState('single')   // 'single' wizard | 'bulk' spreadsheet import
  const [counties, setCounties] = useState(_countiesCache)
  useEffect(() => {
    if (_countiesCache) return
    fetch(`${import.meta.env.BASE_URL}us-counties.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) { _countiesCache = d; setCounties(d) } })
      .catch(() => {})
  }, [])
  const [createdId, setCreatedId] = useState(null)
  const [attachments, setAttachments] = useState([])   // BUG_004: staged reference docs
  const [busy, setBusy] = useState(false)
  // BUG_008: a registered client shouldn't retype contact details every order —
  // prefill from the signed-in profile (still editable per order).
  // A fresh blank form (contact prefilled from the profile). Used for the initial
  // state and to fully reset on "Place Another" — new party ids each time.
  const makeInitialForm = () => ({
    searchType:'', customSearch:'', state:'', county:'', address:'', city:'', zip:'', parcelId:'', clientFileNo:'',
    propertyType:'', propertyTypeOther:'',
    // Parties are a single-name list you can extend (add more buyers/sellers),
    // rather than fixed first/last fields.
    parties: [
      { id: uid(), role:'Buyer',  name:'' },
      { id: uid(), role:'Seller', name:'' },
    ],
    priority:'normal',
    contactName: user?.name || '',
    email: user?.email || '',
    company: clientName(user?.clientCode) || '',
    role:'', notes:''
  })
  const [form, setForm] = useState(makeInitialForm)
  const [submitted, setSubmitted] = useState(false)
  const [stepErr, setStepErr] = useState(false)
  const [submitErr, setSubmitErr] = useState('')
  const set = (k,v) => setForm(f => ({ ...f, [k]:v }))
  // Party list helpers (single name field + role; add/remove rows).
  const addParty = (role = 'Buyer') => setForm(f => ({ ...f, parties: [...f.parties, { id: uid(), role, name:'' }] }))
  const setParty = (id, patch) => setForm(f => ({ ...f, parties: f.parties.map(p => p.id === id ? { ...p, ...patch } : p) }))
  const removeParty = (id) => setForm(f => ({ ...f, parties: f.parties.filter(p => p.id !== id) }))
  // Required-field gate per step. The wizard unmounts prior steps, so relying on
  // HTML5 `required` at final submit let empty State/County slip through — guard
  // each step explicitly before advancing.
  const stepValid = (s) => {
    if (s === 1) return !!(form.state.trim() && form.county.trim())
    // A product or a custom search must be chosen (the "Titled Products *" gate).
    if (s === 2) return !!(form.searchType.trim() || form.customSearch.trim())
    if (s === 3) return !!(form.company.trim() && form.contactName.trim() && /\S+@\S+\.\S+/.test(form.email))
    return true
  }
  const goNext = () => { if (!stepValid(step)) { setStepErr(true); return } setStepErr(false); setStep(s => s + 1) }
  const submit = async () => {
    if (busy) return
    setBusy(true)
    setSubmitErr('')
    try {
      // The party list is the source of truth; keep buyer/seller/borrower as the
      // first named party of each role so existing order-detail views still read.
      const parties = form.parties.map(p => ({ role: p.role, name: (p.name || '').trim() })).filter(p => p.name)
      // Roll every name of a role into the buyer/seller/borrower fields the
      // existing order views render, so added parties are visible to staff, not
      // just the first one. The structured list stays on intake.parties.
      const namesByRole = (role) => parties.filter(p => p.role === role).map(p => p.name).join(', ')
      const buyer = namesByRole('Buyer'), seller = namesByRole('Seller'), borrower = namesByRole('Borrower')
      const propertyType = form.propertyType === 'Other' ? (form.propertyTypeOther.trim() || 'Other') : form.propertyType
      const customSearch = form.customSearch.trim()
      // A custom (non-catalogue) search becomes the order type when no product is picked.
      const type = form.searchType || customSearch || 'Full Search'
      const order = await createOrder({
        state: form.state, county: form.county, type,
        priority: form.priority,
        clientFileNo: form.clientFileNo,
        // Attribute to the signed-in client so the order is trackable in My
        // Orders and readable back under RLS (client_code = my_client_code()).
        clientCode: user?.clientCode || null,
        // Business Name (required in step 3) identifies the order, matching
        // BulkImport. Falls back to the account's client name / user name.
        client: form.company.trim() || clientName(user?.clientCode) || user?.name || 'Web Order',
        intake: {
          source: 'web', propertyAddress: [form.address, form.city, stateName(form.state), form.zip].filter(Boolean).join(', '),
          parcelNumberAPN: form.parcelId, borrowerName: borrower, buyer, seller,
          parties, propertyType: propertyType || null, customSearch: customSearch || null,
          orderType: type, from: `${form.contactName} <${form.email}>`.trim(),
          company: form.company, role: form.role, specialInstructions: form.notes,
        },
      })
      // BUG_004: only now do we have an order id to key Storage uploads on.
      // Upload staged files, then persist the doc refs onto the order so they
      // travel with it to Admin and every downstream stage (orderFiles()).
      if (attachments.length) {
        const clientDocs = []
        for (const a of attachments) {
          if (isSupabaseConfigured && a.file) {
            try { const { url, path } = await uploadDocument(order.id, a.file); clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'done', url, path }) }
            catch { clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'error' }) }
          } else {
            // Mock mode — keep the in-session object URL so it still opens.
            clientDocs.push({ id: a.id, name: a.name, type: a.type, status: 'done', url: a.url || null })
          }
        }
        updateOrder({ ...order, workflow: { ...order.workflow, clientDocs } })
      }
      setCreatedId(order.id)
      setSubmitted(true)
    } catch (e) {
      // Surface a real failure instead of a phantom "submitted" (e.g. the order
      // insert was rejected) so the client can retry rather than lose the order.
      console.error('[placeOrder]', e?.message || e)
      setSubmitErr('We couldn’t submit your order just now. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  // Demo is a read-only sandbox — no real orders created.
  if (user?.demo) return (
    <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[60vh] text-center">
      <div className="w-16 h-16 rounded-full flex items-center justify-center mb-5" style={{ background:'rgba(36,65,229,0.14)' }}>
        <PlusCircle className="w-8 h-8" style={{ color:ROLE_COLOR }} />
      </div>
      <h2 className="text-xl font-bold mb-2" style={{ color:'#12284C' }}>Placing orders is disabled in the demo</h2>
      <p className="text-sm mb-6" style={{ color:'#3D5171' }}>
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
        style={{ background:'rgba(0,184,217,0.18)' }}>
        <CheckCircle className="w-10 h-10" style={{ color:'#15803d' }} />
      </div>
      <h2 className="text-2xl font-bold mb-2" style={{ color:'#12284C' }}>Order Submitted!</h2>
      <p className="text-sm mb-1" style={{ color:'#3D5171' }}>
        Resolute file # <span className="font-mono font-bold" style={{ color:ROLE_COLOR }}>{createdId || 'RTS-10049'}</span>
      </p>
      <p className="text-xs mb-8" style={{ color:'#5C6E8C' }}>
        We'll email a quote to {form.email || 'your email'} within 1 business hour.
      </p>
      <div className="flex gap-3">
        <button onClick={() => { setSubmitted(false); setStep(1); setCreatedId(null); setForm(makeInitialForm()); setAttachments([]) }} className="btn-primary">Place Another</button>
        <button onClick={() => navigate('/client/orders')} className="btn-secondary">Track Order</button>
      </div>
    </motion.div>
  )

  const STEPS = ['Property Info','Search Details','Contact','Review']
  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-1" style={{ color:'#12284C' }}>Place a New Order</h1>
        <p className="text-sm" style={{ color:'#5C6E8C' }}>Title search across all 50 states · Confirmation within minutes</p>
      </div>
      {/* Single order vs bulk import */}
      <div className="inline-flex p-1 rounded-xl mb-6" style={{ background:'rgba(18,40,76,0.05)' }}>
        {[['single','Single order'],['bulk','Bulk import']].map(([k,l]) => (
          <button key={k} type="button" onClick={()=>setMode(k)}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold transition-all"
            style={mode===k ? { background:'#fff', color:'#12284C', boxShadow:'0 1px 2px rgba(18,40,76,0.10)' } : { color:'#5C6E8C' }}>
            {l}
          </button>
        ))}
      </div>
      {mode === 'bulk' ? <BulkImport /> : (<>
      {/* Steps indicator */}
      <div className="flex items-center gap-2 mb-8">
        {STEPS.map((s,i) => (
          <React.Fragment key={s}>
            <div className="flex items-center gap-2 cursor-pointer" onClick={() => i+1 < step && setStep(i+1)}>
              <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all"
                style={i+1 < step
                  ? { background:'#2441E5', color:'#FFFFFF' }
                  : i+1 === step
                  ? { background:'#2441E5', color:'#FFFFFF', boxShadow:`0 0 0 3px rgba(90,140,62,0.25)` }
                  : { background:'rgba(18,40,76,0.07)', color:'#5C6E8C' }}>
                {i+1 < step ? <CheckCircle className="w-3.5 h-3.5" /> : i+1}
              </div>
              <span className="text-xs font-medium hidden sm:block"
                style={{ color: i+1===step ? '#12284C' : '#5C6E8C' }}>{s}</span>
            </div>
            {i < STEPS.length-1 && (
              <div className="flex-1 h-0.5 rounded-full"
                style={{ background: i+1 < step ? '#1B34C4' : 'rgba(18,40,76,0.10)' }} />
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
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Property Information</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property State *</label>
                  <select value={form.state} onChange={e=>{ set('state', e.target.value); set('county', '') }} className="input-field text-sm" required>
                    <option value="">Select state…</option>
                    {US_STATES.map(s => <option key={s.code} value={s.code}>{s.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>County *</label>
                  <input value={form.county} onChange={e=>set('county',e.target.value)}
                    list="county-options" disabled={!form.state}
                    placeholder={form.state ? 'Start typing or pick a county…' : 'Select a state first'}
                    className="input-field text-sm" required/>
                  <datalist id="county-options">
                    {(counties?.[form.state] || []).map(c => <option key={c} value={c} />)}
                  </datalist>
                  {form.state && counties?.[form.state] && (
                    <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>{counties[form.state].length} counties · type to filter</div>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property Address</label>
                  <input value={form.address} onChange={e=>set('address',e.target.value)} placeholder="123 Main St, City, State 00000" className="input-field text-sm"/>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>City</label>
                    <input value={form.city} onChange={e=>set('city',e.target.value)} placeholder="Springfield" className="input-field text-sm"/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>ZIP <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.zip} onChange={e=>set('zip',e.target.value)} placeholder="62701" className="input-field text-sm"/>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Parcel / APN # <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.parcelId} onChange={e=>set('parcelId',e.target.value)} placeholder="14-25-376-012" className="input-field text-sm"/>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Your file # <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                    <input value={form.clientFileNo} onChange={e=>set('clientFileNo',e.target.value)} placeholder="ABC-2291" className="input-field text-sm"/>
                    <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>Your own reference — we quote it back on every update.</div>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Property Type <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                    {['Residential','Commercial','Vacant Land','Agriculture','Other'].map(pt => (
                      <button key={pt} type="button" onClick={() => set('propertyType', pt)}
                        className="py-2 px-2 rounded-lg text-xs font-medium border transition-all"
                        style={form.propertyType === pt
                          ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14`, color:'#12284C' }
                          : { border:'1px solid #DDE3EC', background:'#fff', color:'#5C6E8C' }}>
                        {pt}
                      </button>
                    ))}
                  </div>
                  {form.propertyType === 'Other' && (
                    <input value={form.propertyTypeOther} onChange={e=>set('propertyTypeOther', e.target.value)}
                      placeholder="Describe the property type" className="input-field text-sm mt-2"/>
                  )}
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Parties <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <div className="space-y-2">
                    {form.parties.map(p => (
                      <div key={p.id} className="grid grid-cols-[104px,1fr,auto] gap-2 items-center">
                        <select value={p.role} onChange={e=>setParty(p.id, { role: e.target.value })} className="input-field text-sm">
                          {['Buyer','Seller','Borrower'].map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <input value={p.name} onChange={e=>setParty(p.id, { name: e.target.value })} placeholder="Full name" className="input-field text-sm"/>
                        <button type="button" onClick={()=>removeParty(p.id)} disabled={form.parties.length <= 1}
                          title="Remove" className="p-2" style={{ color: form.parties.length <= 1 ? '#C7CFDB' : '#dc2626' }}>
                          <Trash2 className="w-4 h-4"/>
                        </button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-3 mt-2">
                    <button type="button" onClick={()=>addParty('Buyer')} className="text-xs font-semibold flex items-center gap-1" style={{ color:ROLE_COLOR }}><PlusCircle className="w-3.5 h-3.5"/> Add buyer</button>
                    <button type="button" onClick={()=>addParty('Seller')} className="text-xs font-semibold flex items-center gap-1" style={{ color:ROLE_COLOR }}><PlusCircle className="w-3.5 h-3.5"/> Add seller</button>
                  </div>
                </div>
              </div>
            )}
            {step===2 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Search Details</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#5C6E8C' }}>Titled Products *</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {PRODUCTS.map(p => {
                      const active = form.searchType === p.name
                      return (
                        <button key={p.name} type="button" onClick={() => set('searchType', p.name)}
                          className="p-3 rounded-xl text-left border transition-all"
                          style={active
                            ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14`, boxShadow:`0 0 0 1px ${ROLE_COLOR}44` }
                            : { border:'1px solid #DDE3EC', background:'#fff' }}>
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-semibold text-sm" style={{ color:'#12284C' }}>{p.name}</span>
                            {p.price != null && <span className="font-bold text-sm" style={{ color:'#b45309' }}>${p.price}</span>}
                          </div>
                          <p className="text-[11px] mt-1 leading-snug" style={{ color:'#5C6E8C' }}>{p.desc}</p>
                          {p.tat && <span className="inline-block mt-2 text-[10px] font-medium px-1.5 py-0.5 rounded" style={{ background:'#EDF0F5', color:'#3D5171' }}>⏱ {p.tat}</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Custom search <span style={{textTransform:'none',opacity:.6}}>(not in the list above?)</span></label>
                  <input value={form.customSearch} onChange={e=>set('customSearch', e.target.value)}
                    placeholder="e.g. Mineral rights search, Foreclosure guarantee…" className="input-field text-sm"/>
                  <div className="text-[11px] mt-1" style={{ color:'#9AA8BF' }}>Describe a search outside our standard products and we’ll quote it.</div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-2" style={{ color:'#5C6E8C' }}>Turnaround</label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {TURNAROUND.map(t => (
                      <button key={t.key} type="button" onClick={() => set('priority', t.key)}
                        className="p-3 rounded-xl text-left border transition-all"
                        style={form.priority===t.key
                          ? { border:`1px solid ${ROLE_COLOR}66`, background:`${ROLE_COLOR}14` }
                          : { border:'1px solid #DDE3EC', background:'#fff' }}>
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-sm" style={{ color:'#12284C' }}>{t.label}</span>
                          <span className="text-xs font-bold" style={{ color: t.fee ? '#b45309' : '#5C6E8C' }}>+${t.fee}</span>
                        </div>
                        <div className="text-xs mt-0.5" style={{ color:'#5C6E8C' }}>{t.desc}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Special Instructions</label>
                  <textarea value={form.notes} onChange={e=>set('notes',e.target.value)} rows={3} className="input-field text-sm resize-none" placeholder="Any notes for the search team…"/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Attachments <span style={{textTransform:'none',opacity:.6}}>(optional)</span></label>
                  <p className="text-[11px] mb-2" style={{ color:'#5C6E8C' }}>Deed scans, prior title policies, payoff letters, or anything else the search team should reference.</p>
                  <ClientAttach value={attachments} onChange={setAttachments} />
                </div>
              </div>
            )}
            {step===3 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Contact Information</h2>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Business Name *</label>
                  <input value={form.company} onChange={e=>set('company',e.target.value)} placeholder="Business name" className="input-field text-sm" required/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Contact Name *</label>
                  <input value={form.contactName} onChange={e=>set('contactName',e.target.value)} placeholder="Full name" className="input-field text-sm" required/>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider mb-1.5" style={{ color:'#5C6E8C' }}>Work Email *</label>
                  <input type="email" value={form.email} onChange={e=>set('email',e.target.value)} placeholder="you@company.com" className="input-field text-sm" required/>
                </div>
              </div>
            )}
            {step===4 && (
              <div className="space-y-4">
                <h2 className="text-lg font-semibold mb-4" style={{ color:'#12284C' }}>Review & Submit</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {[['State',stateName(form.state)||'—'],['County',form.county||'—'],
                    ['Search Type',form.searchType || form.customSearch || '—'],
                    ['Property Type',(form.propertyType==='Other' ? (form.propertyTypeOther.trim()||'Other') : form.propertyType) || '—'],
                    ['Parties', form.parties.filter(p=>p.name.trim()).length ? `${form.parties.filter(p=>p.name.trim()).length} listed` : '—'],
                    ['Your file #',form.clientFileNo||'—'],
                    ['Priority',form.priority.toUpperCase()],['Business Name',form.company||'—'],
                    ['Contact',form.contactName||'—'],['Email',form.email||'—']].map(([k,v]) => (
                    <div key={k} className="glass p-3 rounded-xl">
                      <div className="text-xs mb-0.5" style={{ color:'#5C6E8C' }}>{k}</div>
                      <div className="font-medium text-sm" style={{ color:'#12284C' }}>{v}</div>
                    </div>
                  ))}
                </div>
                {attachments.length > 0 && (
                  <div className="flex items-center gap-2 text-sm px-3 py-2.5 rounded-xl" style={{ background:'rgba(36,65,229,0.08)', border:'1px solid rgba(36,65,229,0.20)', color:'#2441E5' }}>
                    <Paperclip className="w-4 h-4 flex-shrink-0" />
                    {attachments.length} {attachments.length === 1 ? 'file' : 'files'} attached
                  </div>
                )}
                {form.priority==='rush' && (
                  <div className="flex items-center gap-2 p-3 rounded-xl text-sm"
                    style={{ background:'rgba(220,80,60,0.10)', border:'1px solid rgba(220,80,60,0.22)', color:'#dc2626' }}>
                    <Zap className="w-4 h-4 flex-shrink-0" />
                    Rush order selected — additional fees apply. Delivery within 24 hours.
                  </div>
                )}
                <div className="flex items-start gap-2 p-3 rounded-xl text-[12px] leading-snug"
                  style={{ background:'rgba(18,40,76,0.04)', border:'1px solid rgba(18,40,76,0.10)', color:'#3D5171' }}>
                  <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color:'#15803d' }} />
                  <span><strong>Free cancellation.</strong> There is no charge to cancel an order any time before we begin the title search (screening). Once work has started, a cancellation becomes a request our team reviews.</span>
                </div>
              </div>
            )}
            {stepErr && !stepValid(step) && (
              <div className="mt-4 text-[12px] px-3 py-2 rounded-lg" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
                {step===1 ? 'Property State and County are required.'
                  : step===2 ? 'Choose a product or describe a custom search.'
                  : 'Business name, contact name, and a valid email are required.'}
              </div>
            )}
            {submitErr && (
              <div className="mt-4 text-[12px] px-3 py-2 rounded-lg" style={{ background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
                {submitErr}
              </div>
            )}
            <div className="flex gap-3 mt-8">
              {step>1 && <button type="button" onClick={() => { setStepErr(false); setStep(s=>s-1) }} className="btn-secondary px-6">Back</button>}
              {step<4
                ? <button type="button" onClick={goNext} className="btn-primary flex-1">Continue</button>
                : <button type="submit" disabled={busy} className="btn-primary flex-1 flex items-center justify-center gap-2" style={busy ? { opacity:0.7, cursor:'wait' } : undefined}>
                    <Send className="w-4 h-4" /> {busy ? 'Submitting…' : 'Submit Order'}
                  </button>
              }
            </div>
          </form>
        </motion.div>
      </AnimatePresence>
      </>)}
    </div>
  )
}

function ClientHome() {
  const myOrders = useMyOrders()
  const { user } = useAuth()
  const navigate = useNavigate()
  const stats = clientStats(myOrders)
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold" style={{ color:'#12284C' }}>Client Portal</h1>
          {/* The signed-in person, not whoever happened to be in the fixture. */}
          <p className="text-sm" style={{ color:'#3D5171' }}>Welcome back{user?.name ? `, ${user.name}` : ''}</p>
        </div>
        <motion.button whileHover={{ scale:1.02 }} whileTap={{ scale:0.98 }} onClick={() => navigate('/client/order')}
          className="btn-primary flex items-center gap-2 text-sm">
          <PlusCircle className="w-4 h-4" /> New Order
        </motion.button>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { icon:Package,     label:'Active orders',    value:stats.active,       color:ROLE_COLOR },
          { icon:CheckCircle, label:'Completed this year', value:stats.completedYtd, color:'#15803d' },
          { icon:Clock,       label:'Avg turnaround',   value:stats.turnaround,   color:'#a16207' },
          { icon:Zap,         label:'Rush in progress', value:stats.rush,         color:'#b45309' },
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
      <div className="space-y-4">
        <h2 className="font-semibold" style={{ color:'#12284C' }}>Order Tracking</h2>
        {myOrders.map(o => (
          <React.Fragment key={o.id}>
            <TrackOrder order={o} onOpen={() => navigate(`/client/orders/${o.id}`)} />
            {o.workflow?.invoiceVisibleToClient && <InvoiceCard order={o} />}
          </React.Fragment>
        ))}
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

function MyOrdersPage() {
  const myOrders = useMyOrders()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const [exporting, setExporting] = useState(false)
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
  // S8: export the currently shown orders to Excel. xlsx is lazily imported so
  // the bundle only pulls it when a client actually exports (mirrors BulkImport).
  const exportXlsx = async () => {
    if (!shown.length || exporting) return
    setExporting(true)
    try {
      const XLSX = await import('xlsx')
      const rows = shown.map(o => {
        const intake = o.workflow?.intake || {}
        return {
          'Order #': o.id,
          Type: o.type || '',
          Status: clientStage(o).label,
          State: o.state || '',
          County: o.county || '',
          'Property Address': intake.propertyAddress || '',
          'Parcel / APN': intake.parcelNumberAPN || '',
          Created: o.created || '',
          ETA: o.eta || '',
        }
      })
      const ws = XLSX.utils.json_to_sheet(rows)
      const wb = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(wb, ws, 'My Orders')
      XLSX.writeFile(wb, `my-orders-${new Date().toISOString().slice(0, 10)}.xlsx`)
    } finally {
      setExporting(false)
    }
  }
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>My Orders</h1>
        <div className="flex items-center gap-3 flex-wrap">
          <button type="button" onClick={exportXlsx} disabled={!shown.length || exporting}
            className="btn-secondary text-sm flex items-center gap-2"
            style={{ opacity: (!shown.length || exporting) ? 0.5 : 1 }}
            title="Export the orders shown below to an Excel file">
            <Download className="w-4 h-4" />
            {exporting ? 'Exporting…' : 'Export to Excel'}
          </button>
          <div className="relative" style={{ minWidth: 260 }}>
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2" style={{ color: '#9AA8BF' }} />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search order #, property, status…"
              className="input-field text-sm pl-9 w-full" />
          </div>
        </div>
      </div>
      <div className="space-y-4">
        {shown.map(o => (
          <React.Fragment key={o.id}>
            <TrackOrder order={o} onOpen={() => navigate(`/client/orders/${o.id}`)} />
            {o.workflow?.invoiceVisibleToClient && <InvoiceCard order={o} />}
          </React.Fragment>
        ))}
        {shown.length === 0 && (
          <div className="glass-card p-8 text-center text-sm" style={{ color: '#5C6E8C' }}>
            {myOrders.length === 0 ? 'No orders yet.' : `No orders match “${q}”.`}
          </div>
        )}
      </div>
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
          style={{ background:'rgba(36,65,229,0.10)', border:'1px solid rgba(36,65,229,0.28)', color:'#2441E5' }}>
          <Zap className="w-4 h-4 flex-shrink-0" />
          <span><strong>Demo mode</strong> — sample data, read-only. Nothing here is real, and it resets when you refresh.</span>
        </div>
      )}
      <Routes>
        <Route index         element={<ClientHome />} />
        <Route path="order"  element={<PlaceOrderPage />} />
        <Route path="orders" element={<MyOrdersPage />} />
        <Route path="orders/:id" element={<OrderDetailPage />} />
        {/* No nav entry and no email ever links here — client contact is
            portal-only, so a client is never a notification recipient. The route
            exists so the URL explains itself instead of rendering a blank page. */}
        <Route path="notifications" element={<NotificationSettings />} />
        <Route path="messages" element={<MessagesPage />} />
        <Route path="billing" element={<BillingPage />} />
        <Route path="support" element={<SupportPage />} />
      </Routes>
    </Layout>
  )
}
