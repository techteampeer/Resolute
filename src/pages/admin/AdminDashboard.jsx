import React, { useState, useEffect, useMemo } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import USAMap from '../../components/USAMap'
import StagePlanModal from '../../components/StagePlanModal'
import NotificationSettings from '../../components/NotificationSettings'
import StatusBadge from '../../components/StatusBadge'
import {
  LayoutDashboard, ClipboardList, Users, BarChart3, Settings, MapPin,
  Package, CheckCircle, Clock, Search, Plus, Filter, Eye, DollarSign,
  ChevronDown, ChevronUp, FileText, ArrowUpRight, X, Lock, ShieldCheck, Download,
  MessageSquare, Send, StickyNote, Bell, Workflow,
} from 'lucide-react'
import AdminBilling from './AdminBilling'
import AdminPlaceOrder from './AdminPlaceOrder'
import AdminSettings from './AdminSettings'
import { downloadCsv } from '../../lib/exportCsv'
import { openDocument, getAccessToken } from '../../lib/backend'
import { isSupabaseConfigured } from '../../lib/backend'
import { useProfiles, refreshProfiles } from '../../lib/useProfiles'
import { PRODUCT_PRICE } from '../../data/products'
import { money, invoiceAmount, payStatusOf, PAY_STATUS } from '../../lib/billing'
import { orderSourceOf, orderSourceLabel } from '../../lib/orderSource'
import { STATUS_META as STATUS_MAP } from '../../lib/orderStatus'
import { ORDER_TABS, tabOf, tabCounts, withinRange, propertyOf, DATE_RANGES, statusRank, dueByValue, orderedOnValue, sortByAccessor } from '../../lib/ordersView'
import { ROLE_COLOR, density } from '../../lib/ui'
import FulfillmentScreen from '../typer/fulfillment/FulfillmentScreen'
import AttachedDocs from '../../components/AttachedDocs'
import { orderSubtitle } from '../../components/OrderDetailLayout'
import OrderThread from '../../components/OrderThread'
import SubOrders from '../../components/SubOrders'
import {
  USERS, MONTHLY_STATS, PAYMENT_METHODS,
  displayClient, clientByName, clientCode, stateCode,
  REGIONS, regionOf, nextRoleFor, lineItemsOf, workloadWeight,
  stagePlanOf, hasStagePlan, isSingleSeatingPlan,
  ROLE_SEQUENCE, can, workableStages,
} from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

const ROLE_HOVER  = '#1B34C4'

// The admin's view of an order's course of flow (E2). Shows who owns each stage,
// which stage the order is with right now, and what's already done — and opens
// the plan editor. Read-only awareness here; editing happens in StagePlanModal.
const PLAN_STAGES = [
  { key:'screener', label:'Screener' }, { key:'examiner', label:'Examiner' }, { key:'searchqc', label:'Search QC' },
  { key:'typer', label:'Typer' }, { key:'qc', label:'Typing QC' }, { key:'delivery', label:'Delivery' },
]
function StagePlanPanel({ order, profiles, onEdit }) {
  const plan = stagePlanOf(order)
  const isSet = hasStagePlan(order)
  const due = nextRoleFor(order)
  const nameOf = (id) => profiles.find(p => p.id === id)?.name || (id ? 'Unknown user' : null)
  const mode = isSingleSeatingPlan(order) ? 'Single seating' : 'Stage by stage'
  const dueLabel = (PLAN_STAGES.find(s => s.key === due) || {}).label || ''
  return (
    <div style={{ background:Q.bg, border:`1px solid ${Q.border}`, borderRadius:10, padding:'14px 16px' }}>
      <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: isSet ? 12 : 8 }}>
        <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:11, fontWeight:700,
          textTransform:'uppercase', letterSpacing:'0.05em', color:Q.faint }}>
          <Workflow style={{ width:13, height:13 }} /> Stage plan
          {isSet && <span style={{ textTransform:'none', letterSpacing:0, fontSize:10.5, fontWeight:700,
            color:ROLE_COLOR, background:`${ROLE_COLOR}14`, borderRadius:5, padding:'2px 7px' }}>{mode}</span>}
        </div>
        <button onClick={onEdit} style={{ fontSize:12, fontWeight:600, color:ROLE_COLOR,
          background:'none', border:'none', cursor:'pointer', padding:0 }}>
          {isSet ? 'Edit plan' : 'Set plan'}
        </button>
      </div>
      {!isSet ? (
        <div style={{ fontSize:13, color:Q.muted, lineHeight:1.5 }}>
          No one is assigned yet. Set the plan to route this order to the production
          team — it can’t start until you do.
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'8px 16px' }}>
          {PLAN_STAGES.map(s => {
            const owner = plan[s.key]
            const isDue = due === s.key
            const doneDate = order.completedDates?.[s.key]
            return (
              <div key={s.key} style={{ display:'flex', alignItems:'center', gap:8, fontSize:12.5 }}>
                <span style={{ width:7, height:7, borderRadius:'50%', flexShrink:0,
                  background: doneDate ? '#16a34a' : isDue ? ROLE_COLOR : Q.border }} />
                <span style={{ minWidth:0 }}>
                  <span style={{ color:Q.faint }}>{s.label}: </span>
                  <span style={{ color: owner ? Q.text : '#b45309', fontWeight:600 }}>{nameOf(owner) || 'unassigned'}</span>
                  {isDue && !doneDate && <span style={{ color:ROLE_COLOR, fontWeight:600, fontSize:11 }}> · here now</span>}
                  {doneDate && <span style={{ color:'#16a34a', fontSize:11 }}> · done</span>}
                </span>
              </div>
            )
          })}
        </div>
      )}
      {isSet && due && !plan[due] && (
        <div style={{ marginTop:10, fontSize:12, color:'#b45309' }}>
          The {dueLabel} stage (due now) has no one assigned — the order is parked with Admin.
        </div>
      )}
    </div>
  )
}

const NAV = [
  { path: '/admin',          label: 'Dashboard',    icon: LayoutDashboard },
  { path: '/admin/orders',   label: 'Orders',       icon: ClipboardList },
  { path: '/admin/place-order', label: 'Place Order', icon: Plus },
  { path: '/admin/users',    label: 'Users',        icon: Users },
  { path: '/admin/billing',  label: 'Billing',      icon: DollarSign },
  { path: '/admin/support',  label: 'Support',      icon: MessageSquare },
  { path: '/admin/map',      label: 'Coverage Map', icon: MapPin },
  { path: '/admin/reports',  label: 'Reports',      icon: BarChart3 },
  { path: '/admin/notifications', label: 'Notifications', icon: Bell },
  { path: '/admin/settings', label: 'Settings',     icon: Settings },
]

// Light theme palette
const Q = {
  bg:      '#F3F5F8',
  card:    '#ffffff',
  border:  '#DDE3EC',
  text:    '#12284C',
  muted:   '#5C6E8C',
  faint:   '#9AA8BF',
  shadow:  '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
  rowHover:'#F9FBFD',
}

// Export the full order list to CSV (used on Dashboard + Orders — moved here
// from Reports, where the order-level export was less relevant).
export function exportOrdersCsv(orders, user) {
  downloadCsv('orders.csv', [
    { label: 'Order', get: o => o.id }, { label: 'Client File #', get: o => o.clientFileNo || '' },
    { label: 'Client', get: o => displayClient(o, user) },
    { label: 'State', get: o => o.state }, { label: 'County', get: o => o.county },
    { label: 'Type', get: o => o.type }, { label: 'Status', get: o => STATUS_MAP[o.status]?.label || o.status },
    { label: 'Priority', get: o => o.priority }, { label: 'Payment', get: o => o.payment },
    { label: 'Created', get: o => o.created }, { label: 'ETA', get: o => o.eta }, { label: 'Completed', get: o => o.completed || '' },
  ], orders)
}

const csvBtnStyle = {
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8,
  border: '1px solid #DDE3EC', background: '#fff', color: '#12284C', fontSize: 13, fontWeight: 600, cursor: 'pointer',
}

function QCard({ children, className = '', style = {} }) {
  return (
    <div className={className}
      style={{ background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 10, boxShadow: Q.shadow, ...style }}>
      {children}
    </div>
  )
}

function StatCard({ icon: Icon, label, value, sub, color = ROLE_COLOR, trend, delay = 0 }) {
  return (
    <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ delay }}
      style={{ background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 10,
        boxShadow: Q.shadow, padding: '18px 20px' }}>
      <div className="flex items-center justify-between mb-3">
        <div className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ background: `${color}18` }}>
          <Icon style={{ color, width: 18, height: 18 }} />
        </div>
        {trend && (
          <span className="text-xs font-semibold flex items-center gap-0.5 px-2 py-0.5 rounded-full"
            style={{ background: '#f0fdf4', color: '#16a34a' }}>
            <ArrowUpRight style={{ width: 11, height: 11 }} />{trend}
          </span>
        )}
      </div>
      <div className="text-2xl font-bold tracking-tight" style={{ color: Q.text }}>{value}</div>
      <div className="text-sm mt-0.5" style={{ color: Q.muted }}>{label}</div>
      {sub && <div className="text-xs mt-1" style={{ color: Q.faint }}>{sub}</div>}
    </motion.div>
  )
}

function Field({ label, children }) {
  return (
    <div>
      <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
        letterSpacing:'0.05em', color:Q.faint, marginBottom:6 }}>{label}</label>
      {children}
    </div>
  )
}

// Read-only label/value row for the order-detail overview. Renders nothing when
// the value is empty so partially-filled intakes stay tidy. `wide` spans both
// grid columns (for long values like the full property address).
function Detail({ label, value, wide }) {
  if (!value) return null
  return (
    <div style={wide ? { gridColumn:'1 / -1' } : undefined}>
      <span style={{ color:Q.faint }}>{label}: </span>
      <span style={{ color:Q.text, fontWeight:500 }}>{value}</span>
    </div>
  )
}

const selectStyle = {
  width:'100%', padding:'8px 10px', borderRadius:8, border:`1px solid ${Q.border}`,
  background:Q.bg, color:Q.text, fontSize:13, outline:'none',
}

const STAGE_FIELDS = [
  { key:'screener', label:'Screener' },
  { key:'searchqc', label:'Search QC' },
  { key:'examiner', label:'Examiner' },
  { key:'typer',    label:'Typer' },
  { key:'qc',       label:'Typing QC' },
  { key:'delivery', label:'Delivery' },
]
const DETAIL_TABS = [
  { key:'overview', label:'Overview' },
  { key:'activity', label:'Activity' },
  { key:'inbox',    label:'Inbox' },
  { key:'files',    label:'Files' },
]
// Real files attached to an order by earlier stages (carried on order.workflow).
const orderFiles = (order) => {
  const w = order.workflow || {}
  const out = []
  ;(w.clientDocs || []).forEach(d => out.push({ ...d, stage: 'Client · Upload' }))
  if (w.screenerDoc) out.push({ ...w.screenerDoc, stage: 'Screening' })
  if (w.examinerDoc) out.push({ ...w.examinerDoc, stage: 'Examination' })
  if (w.commitmentDoc) out.push({ ...w.commitmentDoc, stage: 'Typing · Commitment' })
  return out
}

// Internal notes on an order — written by any staff member (screener, examiner,
// typer, delivery, Single Seating) to flag something for Admin. RLS keeps these
// invisible to clients; this is where Admin reads them, and can reply in kind.
function InternalNotes({ order, notes, user, clientCode }) {
  const { sendMessage } = useSupport()
  const [draft, setDraft] = useState('')
  const add = () => {
    const body = draft.trim()
    if (!body || !clientCode) return
    sendMessage({
      clientCode, clientName: order.client, from: 'support', text: body,
      author: user?.name || 'Admin', orderId: order.id, visibility: 'internal',
    })
    setDraft('')
  }
  return (
    <div style={{ marginTop:18, paddingTop:16, borderTop:`1px solid ${Q.border}` }}>
      <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:10 }}>
        <StickyNote style={{ width:14, height:14, color:'#a16207' }} />
        <span style={{ fontSize:11, fontWeight:700, textTransform:'uppercase',
          letterSpacing:'0.05em', color:Q.muted }}>Internal Notes</span>
        <span style={{ fontSize:11, color:Q.faint }}>· from staff · never visible to the client</span>
        {notes.length > 0 && (
          <span style={{ fontSize:10, fontWeight:700, padding:'1px 7px', borderRadius:99,
            background:'rgba(196,164,78,0.18)', color:'#a16207' }}>{notes.length}</span>
        )}
      </div>
      {notes.length === 0 ? (
        <div style={{ fontSize:12.5, color:Q.faint, marginBottom:10 }}>
          No internal notes on this order yet.
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8, marginBottom:10 }}>
          {notes.map(n => (
            <div key={n.id} style={{ borderRadius:10, padding:'9px 12px',
              background:'rgba(196,164,78,0.08)', border:'1px dashed rgba(196,164,78,0.45)' }}>
              <div style={{ display:'flex', justifyContent:'space-between', gap:8, marginBottom:2 }}>
                <span style={{ fontSize:12, fontWeight:600, color:'#a16207' }}>{n.author || 'Staff'}</span>
                <span style={{ fontSize:11, color:Q.faint }}>{n.time}</span>
              </div>
              <div style={{ fontSize:13, color:Q.text, whiteSpace:'pre-wrap' }}>{n.text}</div>
            </div>
          ))}
        </div>
      )}
      <div style={{ display:'flex', gap:8 }}>
        <input value={draft} onChange={e => setDraft(e.target.value)}
          placeholder={clientCode ? 'Add an internal note…' : 'Order has no linked client account'}
          disabled={!clientCode}
          style={{ flex:1, padding:'8px 11px', borderRadius:8, border:`1px solid ${Q.border}`,
            background: clientCode ? Q.card : Q.bg, color:Q.text, fontSize:13, outline:'none' }} />
        <button onClick={add} disabled={!draft.trim() || !clientCode}
          style={{ display:'flex', alignItems:'center', gap:5, padding:'8px 14px', borderRadius:8,
            border:'none', fontSize:12.5, fontWeight:600,
            background: draft.trim() && clientCode ? '#a16207' : Q.border,
            color: draft.trim() && clientCode ? '#fff' : Q.faint,
            cursor: draft.trim() && clientCode ? 'pointer' : 'not-allowed' }}>
          <Send style={{ width:13, height:13 }} /> Note
        </button>
      </div>
    </div>
  )
}


// Confirming an order is the moment it gets a price and a committed date. Both
// used to be skipped for portal orders: the price fell through to the catalogue
// (or a flat $125 for the quote-only products) and the ETA was never set at all.
// `started` = the order is already past intake. Admin still needs to be able to
// price a row that got moving without ever being confirmed (every seeded order,
// and anything placed before pricing existed), but calling that "Confirm order"
// and mailing the client "received and confirmed — we'll begin work shortly" on
// a file that is 65% done is a lie. Same modal, different framing and message.
function ConfirmOrderModal({ order, started, onCancel, onConfirm }) {
  const catalogue = PRODUCT_PRICE[order.type]
  const quoteOnly = catalogue == null
  const [price, setPrice] = useState(String(order.workflow?.invoiceAmount ?? catalogue ?? ''))
  const [eta, setEta] = useState(() => {
    // A rush order promises a tighter date than a normal one.
    const d = new Date(); d.setDate(d.getDate() + (order.priority === 'rush' ? 2 : 4))
    const suggested = d.toISOString().slice(0, 10)
    // Only carry an existing ETA forward while it is still in the future.
    // Pricing an older order prefilled its stale date and saved it, so the
    // client was shown a committed date that had already passed.
    return order.eta && order.eta >= new Date().toISOString().slice(0, 10) ? order.eta : suggested
  })
  const n = Number(price)
  const priceValid = price !== '' && !Number.isNaN(n) && n >= 0
  const field = { width:'100%', padding:'9px 11px', borderRadius:8, border:`1px solid ${Q.border}`,
                  background:Q.bg, color:Q.text, fontSize:13, outline:'none' }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background:'rgba(12,29,56,0.45)' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()}
        style={{ background:Q.card, borderRadius:12, width:'100%', maxWidth:420, boxShadow:'0 20px 50px rgba(0,0,0,0.25)' }}>
        <div style={{ padding:'18px 22px', borderBottom:`1px solid ${Q.border}` }}>
          <div style={{ fontFamily:'monospace', fontWeight:700, fontSize:13, color:ROLE_COLOR }}>{order.id}</div>
          <div style={{ fontSize:17, fontWeight:700, color:Q.text }}>{started ? 'Set price & committed date' : 'Confirm & price order'}</div>
          <div style={{ fontSize:12, color:Q.muted }}>{order.type}{order.county ? ` · ${order.county}, ${order.state}` : ''}</div>
        </div>
        <div style={{ padding:'18px 22px', display:'grid', gap:14 }}>
          {started && (
            <div style={{ fontSize:12, lineHeight:1.5, padding:'9px 11px', borderRadius:8,
              background:'#fffbeb', border:'1px solid #fde68a', color:'#a16207' }}>
              Work on this order has already started ({order.status}, {order.progress || 0}% complete).
              This sets the price and the date the client sees — it is not an acknowledgment of a new order.
            </div>
          )}
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
              letterSpacing:'0.05em', color:Q.faint, marginBottom:6 }}>Agreed price (USD)</label>
            <input style={field} value={price} inputMode="decimal"
              onChange={e => setPrice(e.target.value.replace(/[^0-9.]/g, ''))} />
            <div style={{ fontSize:11.5, color: quoteOnly ? '#b45309' : Q.muted, marginTop:5 }}>
              {quoteOnly
                ? `${order.type} is quote-only — there is no catalogue price, so this must be set here.`
                : `Catalogue price for ${order.type} is ${money(catalogue)}${order.priority === 'rush' ? ' (rush adds $50 at invoicing)' : ''}.`}
            </div>
          </div>
          <div>
            <label style={{ display:'block', fontSize:11, fontWeight:600, textTransform:'uppercase',
              letterSpacing:'0.05em', color:Q.faint, marginBottom:6 }}>Committed date (ETA)</label>
            <input style={field} type="date" value={eta} onChange={e => setEta(e.target.value)} />
            <div style={{ fontSize:11.5, color:Q.muted, marginTop:5 }}>
              Shown to the client on their order. {order.priority === 'rush' ? 'Rush order — defaulted to two days out.' : 'Defaulted to four days out.'}
            </div>
          </div>
        </div>
        <div style={{ display:'flex', gap:10, padding:'0 22px 20px' }}>
          <button disabled={!priceValid} onClick={() => onConfirm({ price: n, eta })}
            style={{ flex:1, padding:'10px', background: priceValid ? ROLE_COLOR : Q.border, border:'none',
              borderRadius:8, color:'#fff', fontSize:13, fontWeight:600, cursor: priceValid ? 'pointer' : 'not-allowed' }}>
            {started ? 'Save price & date' : 'Confirm order'}
          </button>
          <button onClick={onCancel} style={{ padding:'10px 18px', background:Q.bg,
            border:`1px solid ${Q.border}`, borderRadius:8, color:Q.muted, fontSize:13, fontWeight:600, cursor:'pointer' }}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// Full-page order detail (replaces the old modal). Route: /admin/orders/:id
function AdminOrderPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, activityLog, resolveCancel, updateOrder } = useOrders()
  const order = orders.find(o => o.id === id)
  const onClose = () => navigate('/admin/orders')
  // The old modal was handed AdminOrders' local `saveOrder`, which was just a
  // pass-through to updateOrder — the context never exported one.
  const onSave  = (o) => updateOrder(o)
  return order
    ? <AdminOrderDetail {...{ order, user, onClose, onSave, activityLog, resolveCancel, updateOrder }} />
    : (
      <div className="max-w-lg mx-auto flex flex-col items-center justify-center min-h-[50vh] text-center gap-4">
        <div style={{ fontSize:13, color:Q.muted }}>Order not found.</div>
        <button onClick={onClose} className="btn-primary text-sm px-5 py-2.5">Back to Orders</button>
      </div>
    )
}

// Portal (client-login) orders carry workflow.intake.source === 'web' and are
// priced when the client places them, so they skip the admin price-confirmation
// step entirely. Mail / website orders (negotiated price — built separately) are
// the only ones that still need "Confirm & price" before work starts.
const isPortalOrder = (o) => o?.workflow?.intake?.source === 'web'

// A small styled prompt — replaces window.prompt for the hold reason and the
// clarification question, so these actions feel part of the app and give the
// admin a real text box (not a browser popup).
function ActionPrompt({ title, hint, placeholder, confirmLabel, requireText = false, onConfirm, onCancel }) {
  const [text, setText] = useState('')
  const ok = !requireText || text.trim()
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 70, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(12,29,56,0.45)' }} onClick={onCancel}>
      <div onClick={e => e.stopPropagation()} style={{ background: Q.card, borderRadius: 12, width: '100%', maxWidth: 420, padding: 22 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: Q.text }}>{title}</div>
        {hint && <div style={{ fontSize: 12.5, color: Q.muted, margin: '4px 0 10px' }}>{hint}</div>}
        <textarea value={text} onChange={e => setText(e.target.value)} rows={3} placeholder={placeholder} autoFocus
          style={{ width: '100%', padding: '9px 12px', border: `1px solid ${Q.border}`, borderRadius: 8, fontSize: 13, outline: 'none', resize: 'none', color: Q.text, background: '#fff' }} />
        <div style={{ display: 'flex', gap: 10, marginTop: 14 }}>
          <button disabled={!ok} onClick={() => onConfirm(text.trim())}
            style={{ flex: 1, padding: '10px', background: ok ? ROLE_COLOR : Q.border, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: ok ? 'pointer' : 'not-allowed' }}>{confirmLabel}</button>
          <button onClick={onCancel} style={{ padding: '10px 18px', background: Q.bg, border: `1px solid ${Q.border}`, borderRadius: 8, color: Q.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// Hooks below must run unconditionally, so the not-found guard lives in the
// wrapper above and this component always receives a real order.
function AdminOrderDetail({ order, user, onClose, onSave, activityLog, resolveCancel, updateOrder }) {
  const navigate = useNavigate()
  const { logAction } = useOrders()
  const { getOrderThread, getOrderNotes, sendMessage } = useSupport()
  const cli = clientByName(order.client)
  // BUG_003: a client requested cancellation of an in-progress order; Admin
  // decides. (Orders cancelled while still queued never reach here.)
  const cancelReq = order.status !== 'cancelled' ? order.workflow?.cancelRequested : null
  const [tab, setTab] = useState('overview')
  // Hold / clarification UX: a styled prompt + an auto-dismissing confirmation
  // toast, both local to this still-mounted detail view (the actions no longer
  // navigate away).
  const [prompt, setPrompt] = useState(null)   // { kind: 'hold' | 'clarify' } | null
  const [toast, setToast] = useState(null)
  const flash = (m) => setToast(m)
  useEffect(() => { if (!toast) return undefined; const t = setTimeout(() => setToast(null), 3500); return () => clearTimeout(t) }, [toast])
  const profiles = useProfiles()
  // The order's owner, status and pipeline position are DERIVED and set through
  // the stage plan (StagePlanModal) — not free-typed here. This editor keeps only
  // the genuinely editable field, the mode of payment. The old owner/status/stage
  // dropdowns routed nothing and let the two silently drift; they're gone.
  const [form, setForm] = useState({ payment: order.payment })
  const [planning, setPlanning] = useState(false)
  const save = () => {
    onSave({ ...order, payment: form.payment })
    onClose()
  }

  const cd = order.completedDates || {}
  const cb = order.completedBy || {}
  const orderActivity = activityLog.filter(a => a.action && a.action.includes(order.id))
  // Per-order inbox thread (client ⇄ staff), shared with the client's order view.
  const orderMessages = getOrderThread(order.id)
  // Internal notes any staff member left on this order. Clients never see
  // these (RLS); Admin reads them here and can add their own.
  const orderNotes = getOrderNotes(order.id)
  const orderClientCode = order.clientCode || cli?.code || null
  const sendThread = ({ text, attachment }) => {
    if ((!text?.trim() && !attachment) || !orderClientCode) return
    sendMessage({ clientCode: orderClientCode, clientName: order.client, from: 'support', text, author: user?.name || 'Support', orderId: order.id, attachment })
  }
  // Order actions: On-Hold (pauses; client sees "On Hold") and Request
  // clarification (client sees "Clarification Required" + a prompt to reply).
  const onHold = !!order.workflow?.onHold
  const notify = (text) => { if (orderClientCode) sendMessage({ clientCode: orderClientCode, clientName: order.client, from: 'support', text, author: user?.name || 'Admin', orderId: order.id }) }
  // Hold / clarification stay ON the order (no more jumping back to the list),
  // use a styled prompt (no browser popup), and confirm with a toast + a
  // persistent banner so it's obvious the change landed. The actions are recorded
  // in the audit trail, as before.
  const applyHold = (reason) => {
    updateOrder({ ...order, workflow: { ...order.workflow, onHold: true, holdReason: reason || null, holdBy: user?.name || 'Admin', holdAt: new Date().toISOString().slice(0, 10) } })
    notify(`Your order was placed on hold${reason ? `: ${reason}` : ''}.`)
    logAction({ orderId: order.id, actor: user?.name || 'Admin', action: `${user?.name || 'Admin'} put ${order.id} on hold${reason ? ` — ${reason}` : ''}` })
    setPrompt(null); flash('Order placed on hold — client notified.')
  }
  const resumeHold = () => {
    updateOrder({ ...order, workflow: { ...order.workflow, onHold: false, holdReason: null } })
    notify('Your order has resumed.')
    logAction({ orderId: order.id, actor: user?.name || 'Admin', action: `${user?.name || 'Admin'} resumed ${order.id}` })
    flash('Order resumed — client notified.')
  }
  const toggleHold = () => (onHold ? resumeHold() : setPrompt({ kind: 'hold' }))
  const applyClarify = (noteText) => {
    if (!noteText) return
    updateOrder({ ...order, clarification: 'pending', workflow: { ...order.workflow, clarificationNote: noteText } })
    notify(`Clarification needed: ${noteText}`)
    logAction({ orderId: order.id, actor: user?.name || 'Admin', action: `${user?.name || 'Admin'} requested clarification from the client on ${order.id} — ${noteText}` })
    setPrompt(null); flash('Clarification requested — client notified.')
  }
  const requestClarification = () => setPrompt({ kind: 'clarify' })
  // Confirm step: portal orders (source 'web') are a one-click acknowledgment;
  // website/email orders need a negotiated price entered before confirming.
  const confirmed = !!order.workflow?.confirmed
  // Confirming an order is where it gets priced and given a committed date.
  // Previously a price was only asked for when the order did NOT come through the
  // portal, so every client-placed order was confirmed silently and
  // workflow.invoiceAmount stayed unset — billing then fell back to the catalogue
  // price, or a flat $125 for the four quote-only products (Tax Search, Patriot
  // Name Search, Bankruptcy Name Search, Document Retrieval), so the client was
  // billed a number nobody had chosen. ETA had the same problem from the other
  // side: no screen set it for a portal order, so it stayed NULL from placement
  // to delivery and the client's order detail rendered "ETA:" with nothing after.
  const [confirming, setConfirming] = useState(false)
  const confirmOrder = () => setConfirming(true)
  // Past intake already? Then this is a pricing correction, not a confirmation.
  // Status is the test, not progress: a newly placed order already reads 5%
  // (progressFor('received')), so a progress check called every new order started.
  const started = order.status !== 'received'
  const applyConfirm = ({ price, eta }) => {
    updateOrder({
      ...order,
      eta: eta || order.eta || null,
      workflow: {
        ...order.workflow,
        confirmed: true,
        confirmedAt: new Date().toISOString().slice(0, 10),
        confirmedBy: user?.name || 'Admin',
        ...(price != null ? { invoiceAmount: price } : {}),
      },
    })
    // "total" was wrong: this is the agreed price, and the invoice issued on
    // delivery can carry extra costs on top of it.
    notify(started
      ? `Your order ${order.id} has been priced${price != null ? ` at ${money(price)}` : ''}${eta ? `, with an estimated completion of ${eta}` : ''}. Work is already under way.`
      : `Your order ${order.id} has been received and confirmed${price != null ? ` — agreed price ${money(price)}` : ''}${eta ? `. Estimated completion ${eta}` : ''}. We'll begin work shortly.`)
    setConfirming(false)
    onClose()
  }
  const files = orderFiles(order)
  // Order specifics the client submitted on the place-order form, carried on
  // order.workflow.intake (property, parties/owner names, APN, contact, notes).
  const intake = order.workflow?.intake

  return (
    <div style={{ maxWidth:900, margin:'0 auto' }}>
      {confirming && <ConfirmOrderModal order={order} started={started} onCancel={() => setConfirming(false)} onConfirm={applyConfirm} />}
      {planning && <StagePlanModal order={order} user={user} onClose={() => setPlanning(false)} />}
      {prompt?.kind === 'hold' && (
        <ActionPrompt title={`Put ${order.id} on hold`} hint="The client sees “On Hold”. Add a reason (optional) — it’s recorded and shown here."
          placeholder="Reason (optional)…" confirmLabel="Put on hold" onConfirm={applyHold} onCancel={() => setPrompt(null)} />
      )}
      {prompt?.kind === 'clarify' && (
        <ActionPrompt title={`Request clarification on ${order.id}`} hint="Sent to the client in the portal; they’ll see a prompt to reply." requireText
          placeholder="What do you need from the client?" confirmLabel="Send request" onConfirm={applyClarify} onCancel={() => setPrompt(null)} />
      )}
      {toast && (
        <div style={{ position:'fixed', bottom:20, right:20, zIndex:80, background:'#12284C', color:'#fff', padding:'11px 16px',
          borderRadius:10, fontSize:13, fontWeight:500, boxShadow:'0 10px 30px rgba(0,0,0,0.25)', display:'flex', alignItems:'center', gap:8 }}>
          <CheckCircle style={{ width:15, height:15 }} /> {toast}
        </div>
      )}
      <motion.div initial={{ opacity:0, y:8 }} animate={{ opacity:1, y:0 }} transition={{ duration:0.18 }}
        style={{ background:Q.card, borderRadius:12, border:`1px solid ${Q.border}`, overflow:'hidden' }}>
        <div style={{ padding:'16px 22px 0' }}>
          <button onClick={onClose}
            style={{ display:'flex', alignItems:'center', gap:6, background:'none', border:'none',
              padding:0, cursor:'pointer', color:Q.muted, fontSize:13 }}>
            <ChevronDown style={{ width:15, height:15, transform:'rotate(90deg)' }} /> Back to Orders
          </button>
        </div>
        <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between',
          padding:'12px 22px 18px' }}>
          <div>
            <div style={{ fontFamily:'monospace', fontWeight:700, fontSize:13, color:ROLE_COLOR }}>{order.id}</div>
            <div style={{ fontSize:20, fontWeight:700, color:Q.text }}>{displayClient(order, user)}</div>
            <div style={{ fontSize:12, color:Q.muted }}>{orderSubtitle(order)}</div>
            <div style={{ fontSize:12, color:Q.muted, marginTop:2 }}>
              Source: <span style={{ color:Q.text, fontWeight:600 }}>{orderSourceLabel(order)}</span>
            </div>
          </div>
          {order.priority === 'rush' && (
            <span style={{ fontSize:11, fontWeight:700, padding:'4px 10px', borderRadius:99,
              background:'rgba(220,38,38,0.12)', color:'#dc2626' }}>RUSH</span>
          )}
        </div>

        {order.status === 'cancelled' && (
          <div style={{ margin:'0 22px 14px', padding:'10px 14px', borderRadius:10, fontSize:13, fontWeight:600,
            background:'rgba(220,38,38,0.08)', border:'1px solid rgba(220,38,38,0.22)', color:'#dc2626' }}>
            This order has been cancelled.
          </div>
        )}
        {cancelReq && (
          <div style={{ margin:'0 22px 14px', padding:'12px 14px', borderRadius:10,
            background:'rgba(220,140,40,0.10)', border:'1px solid rgba(220,140,40,0.28)' }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#b45309', marginBottom:8 }}>
              Cancellation requested{cancelReq.by ? ` by ${cancelReq.by}` : ''}{cancelReq.at ? ` · ${cancelReq.at}` : ''}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={() => { resolveCancel(order.id, true, user?.name || 'Admin'); onClose() }}
                style={{ padding:'7px 14px', background:'#dc2626', border:'none', borderRadius:8, color:'#fff', fontSize:12.5, fontWeight:600, cursor:'pointer' }}>
                Approve cancellation
              </button>
              <button onClick={() => { resolveCancel(order.id, false, user?.name || 'Admin'); onClose() }}
                style={{ padding:'7px 14px', background:Q.bg, border:`1px solid ${Q.border}`, borderRadius:8, color:Q.muted, fontSize:12.5, fontWeight:600, cursor:'pointer' }}>
                Keep order active
              </button>
            </div>
          </div>
        )}
        {/* On-hold banner — who/why/when, with Resume right here (no page jump). */}
        {order.status !== 'cancelled' && onHold && (
          <div style={{ margin:'0 22px 14px', padding:'12px 14px', borderRadius:10, display:'flex', alignItems:'flex-start', justifyContent:'space-between', gap:12,
            background:'rgba(220,140,40,0.10)', border:'1px solid rgba(220,140,40,0.28)' }}>
            <div>
              <div style={{ fontSize:13, fontWeight:700, color:'#b45309' }}>On hold{order.workflow?.holdReason ? ` — ${order.workflow.holdReason}` : ''}</div>
              <div style={{ fontSize:11.5, color:'#a16207', marginTop:2 }}>{[order.workflow?.holdBy, order.workflow?.holdAt].filter(Boolean).join(' · ') || 'Paused'}</div>
            </div>
            <button onClick={resumeHold} style={{ flexShrink:0, padding:'7px 14px', background:'#fff', border:'1px solid rgba(220,140,40,0.45)', borderRadius:8, color:'#b45309', fontSize:12.5, fontWeight:600, cursor:'pointer' }}>Resume</button>
          </div>
        )}
        {/* Clarification-requested banner — the question + awaiting-reply state. */}
        {order.status !== 'cancelled' && order.clarification === 'pending' && (
          <div style={{ margin:'0 22px 14px', padding:'12px 14px', borderRadius:10, background:'rgba(220,60,60,0.08)', border:'1px solid rgba(220,60,60,0.22)' }}>
            <div style={{ fontSize:13, fontWeight:700, color:'#dc2626' }}>Clarification requested — awaiting client reply</div>
            {order.workflow?.clarificationNote && <div style={{ fontSize:12.5, color:'#b91c1c', marginTop:3, whiteSpace:'pre-wrap' }}>“{order.workflow.clarificationNote}”</div>}
          </div>
        )}

        {/* Admin can work the commitment itself, not only approve the finished PDF.
            Opens the same sectioned fulfillment form the typer and Single Seating
            desk use; submitting there stamps the typing stage and parks the order
            back here for the delivery hand-off. */}
        {order.status !== 'cancelled' && (
          <div style={{ padding:'0 22px 14px' }}>
            <button onClick={() => navigate(`/admin/order/${order.id}`)}
              style={{ display:'inline-flex', alignItems:'center', gap:7, padding:'8px 14px', borderRadius:8,
                fontSize:12.5, fontWeight:600, cursor:'pointer', background:Q.bg,
                border:`1px solid ${Q.border}`, color:ROLE_COLOR }}>
              <FileText style={{ width:14, height:14 }} />
              {order.completedDates?.typer ? 'Review commitment' : 'Open fulfillment form'}
            </button>
          </div>
        )}

        {/* Detail tabs */}
        <div className="overflow-x-auto" style={{ display:'flex', gap:0, padding:'0 22px', borderBottom:`1px solid ${Q.border}` }}>
          {DETAIL_TABS.map(t => {
            const badge = t.key === 'inbox' ? orderMessages.length + orderNotes.length : t.key === 'files' ? files.length : 0
            return (
              <button key={t.key} onClick={() => setTab(t.key)}
                className="shrink-0 whitespace-nowrap"
                style={{ display:'flex', alignItems:'center', gap:6, padding:'10px 14px', fontSize:13, fontWeight:600,
                  background:'transparent', border:'none', cursor:'pointer',
                  color: tab === t.key ? ROLE_COLOR : Q.muted,
                  borderBottom: tab === t.key ? `2px solid ${ROLE_COLOR}` : '2px solid transparent', marginBottom:-1 }}>
                {t.label}
                {badge > 0 && <span style={{ fontSize:10, fontWeight:700, padding:'1px 6px', borderRadius:99,
                  background:`${ROLE_COLOR}18`, color:ROLE_COLOR }}>{badge}</span>}
              </button>
            )
          })}
        </div>

        {/* OVERVIEW */}
        {tab === 'overview' && (<>
          <div style={{ padding:'16px 22px', borderBottom:`1px solid ${Q.border}` }}>
            {user?.superAdmin && cli ? (
              <div style={{ background:'rgba(36,65,229,0.05)', border:'1px solid rgba(36,65,229,0.18)', borderRadius:10, padding:'12px 14px' }}>
                <div style={{ display:'flex', alignItems:'center', gap:6, fontSize:11, fontWeight:700,
                  textTransform:'uppercase', letterSpacing:'0.05em', color:'#2441E5', marginBottom:8 }}>
                  <ShieldCheck style={{ width:13, height:13 }} /> Client details ({cli.code})
                </div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 16px', fontSize:13 }}>
                  <div><span style={{ color:Q.faint }}>Name: </span><span style={{ color:Q.text, fontWeight:500 }}>{cli.name}</span></div>
                  <div><span style={{ color:Q.faint }}>Contact: </span><span style={{ color:Q.text }}>{cli.contact}</span></div>
                  <div><span style={{ color:Q.faint }}>Email: </span><span style={{ color:Q.text }}>{cli.email}</span></div>
                  <div><span style={{ color:Q.faint }}>Phone: </span><span style={{ color:Q.text }}>{cli.phone}</span></div>
                </div>
              </div>
            ) : (
              <div style={{ display:'flex', alignItems:'center', gap:8, background:Q.bg,
                border:`1px solid ${Q.border}`, borderRadius:10, padding:'12px 14px', color:Q.muted, fontSize:13 }}>
                <Lock style={{ width:14, height:14, color:Q.faint }} />
                Client <strong style={{ color:Q.text }}>{cli?.code || displayClient(order, user)}</strong> — detailed info restricted to super admins.
              </div>
            )}
          </div>

          {/* Order details submitted by the client on the place-order form */}
          {intake && (
            <div style={{ padding:'16px 22px 0' }}>
              <div style={{ background:Q.bg, border:`1px solid ${Q.border}`, borderRadius:10, padding:'12px 14px' }}>
                <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em',
                  color:Q.faint, marginBottom:8 }}>Order details (from client)</div>
                <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 16px', fontSize:13 }}>
                  <Detail label="Property" value={lineItemsOf(order).length > 1 ? `${lineItemsOf(order).length} properties — see sub-orders` : intake.propertyAddress} wide />
                  <Detail label="County / State" value={[order.county, order.state].filter(Boolean).join(', ')} />
                  <Detail label="Property type" value={intake.propertyType} />
                  <Detail label="Parcel / APN" value={intake.parcelNumberAPN} />
                  <Detail label="Client file #" value={order.clientFileNo} />
                  <Detail label="Buyer" value={intake.buyer} />
                  <Detail label="Borrower" value={intake.borrowerName} />
                  <Detail label="Seller" value={intake.seller} />
                  <Detail label="Product" value={intake.orderType || order.type} />
                  <Detail label="Requested by" value={intake.from} wide />
                  <Detail label="Company" value={intake.company} />
                </div>
                {/* Internal intake metadata — Admin's view only, and by code only */}
                {intake.clientCreated && (
                  <div style={{ marginTop:10, fontSize:12.5, fontWeight:600, color:'#b45309' }}>
                    {orderSourceOf(order) !== 'website'
                      ? <>New client created from email: {intake.clientCode}</>
                      : <>New client created from website order: {intake.clientCode}</>}
                  </div>
                )}
                {intake.reviewNotes?.length > 0 && (
                  <div style={{ marginTop:10, padding:'10px 12px', borderRadius:8,
                    background:'#fffbeb', border:'1px solid #fde68a' }}>
                    <div style={{ fontSize:12.5, fontWeight:700, color:'#b45309', marginBottom:4 }}>Check before approving</div>
                    {intake.reviewNotes.map((note, i) => (
                      <div key={i} style={{ fontSize:12.5, color:Q.text }}>• {note}</div>
                    ))}
                  </div>
                )}
                {intake.specialInstructions && (
                  <div style={{ marginTop:10 }}>
                    <div style={{ fontSize:11, color:Q.faint, marginBottom:2 }}>Special instructions</div>
                    <div style={{ fontSize:13, color:Q.text, whiteSpace:'pre-wrap' }}>{intake.specialInstructions}</div>
                  </div>
                )}
                <div style={{ marginTop:10 }}><SubOrders order={order} /></div>
              </div>
            </div>
          )}

          {/* Stage plan — the admin-set course of flow (E2). Who works each stage,
              where the order is now, and the editor. Replaces the old owner /
              status / per-stage dropdowns that routed nothing. */}
          <div style={{ padding:'16px 22px 0' }}>
            <StagePlanPanel order={order} profiles={profiles} onEdit={() => setPlanning(true)} />
          </div>

          <div style={{ padding:'14px 22px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
            <Field label="Mode of Payment">
              <select style={selectStyle} value={form.payment} onChange={e => setForm(f => ({ ...f, payment: e.target.value }))}>
                {PAYMENT_METHODS.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </Field>
          </div>

          {/* Per-stage completion history */}
          <div style={{ padding:'0 22px 18px' }}>
            <div style={{ background:Q.bg, border:`1px solid ${Q.border}`, borderRadius:10, padding:'12px 14px' }}>
              <div style={{ fontSize:11, fontWeight:700, textTransform:'uppercase', letterSpacing:'0.05em',
                color:Q.faint, marginBottom:8 }}>Stage history</div>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:'6px 16px', fontSize:13 }}>
                {STAGE_FIELDS.map(s => (
                  <div key={s.key}>
                    <span style={{ color:Q.faint }}>{s.label}: </span>
                    <span style={{ color: cd[s.key] ? '#16a34a' : Q.muted, fontWeight: cd[s.key] ? 600 : 400 }}>
                      {cd[s.key] ? `${cd[s.key]}${cb[s.key] ? ` · ${cb[s.key]}` : ''}` : 'Pending'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {order.workflow && (order.workflow.screenerDoc || order.workflow.examinerDoc) && (
            <div style={{ padding:'0 22px 18px' }}><AttachedDocs workflow={order.workflow} /></div>
          )}

          {/* Order actions — confirm + on-hold + clarification (live orders) */}
          {order.status !== 'delivered' && order.status !== 'cancelled' && (
            <div style={{ display:'flex', gap:8, flexWrap:'wrap', padding:'0 22px 14px' }}>
              {/* Portal orders are priced at placement → no confirm-price step.
                  Only mail/website orders (negotiated) still get it. */}
              {!confirmed && !isPortalOrder(order) && (
                <button onClick={confirmOrder} style={{ padding:'8px 14px', borderRadius:8, fontSize:12.5, fontWeight:700, cursor:'pointer',
                  background:ROLE_COLOR, border:'none', color:'#fff' }}>
                  {started ? 'Set price & date' : 'Confirm & price order'}
                </button>
              )}
              {confirmed && (
                <span style={{ padding:'8px 12px', borderRadius:8, fontSize:12.5, fontWeight:600, background:'#EEF1FE', color:'#2441E5', border:'1px solid #C6CFFA' }}>
                  Confirmed{order.workflow?.confirmedBy ? ` · ${order.workflow.confirmedBy}` : ''}
                </span>
              )}
              <button onClick={toggleHold} style={{ padding:'8px 14px', borderRadius:8, fontSize:12.5, fontWeight:600, cursor:'pointer',
                background: onHold ? '#fffbeb' : Q.bg, border:`1px solid ${onHold ? '#fde68a' : Q.border}`, color: onHold ? '#a16207' : Q.muted }}>
                {onHold ? 'Resume order' : 'Put on hold'}
              </button>
              <button onClick={requestClarification} disabled={!orderClientCode || order.clarification === 'pending'}
                title={!orderClientCode ? 'No linked client account' : ''}
                style={{ padding:'8px 14px', borderRadius:8, fontSize:12.5, fontWeight:600,
                  cursor: (!orderClientCode || order.clarification === 'pending') ? 'not-allowed' : 'pointer',
                  background: Q.bg, border:`1px solid ${Q.border}`, color: (!orderClientCode || order.clarification === 'pending') ? Q.faint : Q.muted }}>
                {order.clarification === 'pending' ? 'Clarification pending…' : 'Request clarification'}
              </button>
            </div>
          )}

          <div style={{ display:'flex', gap:10, padding:'0 22px 20px' }}>
            <button onClick={save} style={{ flex:1, padding:'10px', background:ROLE_COLOR, border:'none',
              borderRadius:8, color:'#fff', fontSize:13, fontWeight:600, cursor:'pointer' }}>
              Save Changes
            </button>
            <button onClick={onClose} style={{ padding:'10px 18px', background:Q.bg,
              border:`1px solid ${Q.border}`, borderRadius:8, color:Q.muted, fontSize:13, fontWeight:600, cursor:'pointer' }}>
              Cancel
            </button>
          </div>
        </>)}

        {/* ACTIVITY */}
        {tab === 'activity' && (
          <div style={{ padding:'18px 22px' }}>
            {orderActivity.length === 0 && <div style={{ fontSize:13, color:Q.faint }}>No activity recorded for this order yet.</div>}
            <div style={{ display:'flex', flexDirection:'column', gap:12 }}>
              {orderActivity.map((a, i) => (
                <div key={a.id ?? i} style={{ display:'flex', gap:10 }}>
                  <div style={{ width:8, height:8, borderRadius:99, flexShrink:0, marginTop:5,
                    background: a.type==='new' ? ROLE_COLOR : a.type==='delivered' ? '#16a34a'
                      : a.type==='progress' ? '#d97706' : '#00B8D9' }} />
                  <div>
                    <p style={{ fontSize:13, lineHeight:'1.5', color:Q.text }}>{a.action}</p>
                    <p style={{ fontSize:11, marginTop:2, color:Q.faint }}>{a.time}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* INBOX — per-order client ⇄ staff thread (shared OrderThread) */}
        {tab === 'inbox' && (
          <div style={{ padding:'18px 22px' }}>
            <OrderThread orderId={order.id} messages={orderMessages} viewerSide="support"
              canSend={!!orderClientCode} onSend={sendThread} height={420}
              emptyText={orderClientCode ? 'No messages on this order yet.' : 'This order has no linked client account to message.'} />
            <InternalNotes order={order} notes={orderNotes} user={user} clientCode={orderClientCode} />
          </div>
        )}

        {/* FILES */}
        {tab === 'files' && (
          <div style={{ padding:'18px 22px' }}>
            {files.length === 0 ? (
              <div style={{ fontSize:13, color:Q.muted, textAlign:'center', padding:'24px 0' }}>
                No documents attached yet. Files uploaded by the client, screener, and examiner appear here.
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                {files.map(f => (
                  <div key={f.id || f.name} style={{ display:'flex', alignItems:'center', gap:12,
                    border:`1px solid ${Q.border}`, borderRadius:10, padding:'10px 14px' }}>
                    <FileText style={{ width:18, height:18, color: f.type === 'pdf' ? '#dc2626' : '#2441E5', flexShrink:0 }} />
                    <div style={{ flex:1 }}>
                      <div style={{ fontSize:13, fontWeight:500, color:Q.text }}>{f.name}</div>
                      <div style={{ fontSize:11, color:Q.faint }}>{f.stage} · {(f.type || 'file').toUpperCase()}</div>
                    </div>
                    {(f.url || f.path) && (
                      <button onClick={() => openDocument(f)} title="Preview / download"
                        style={{ background:'transparent', border:'none', cursor:'pointer', color:Q.muted }}>
                        <Eye style={{ width:16, height:16 }} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </motion.div>
    </div>
  )
}

const cap = (s) => s ? s.charAt(0).toUpperCase() + s.slice(1) : s

// Derive the order's routing state for the admin view:
//   delivered   – pipeline finished
//   inprogress  – a role currently holds it (assignedTo set)
//   new         – never assigned, nothing completed yet
//   ready       – between stages, waiting for admin to route the next role
const routingState = (o) => {
  if (o.status === 'delivered') return { kind: 'delivered' }
  // Parked with Admin: waiting on a routing decision, not being worked.
  if (o.assignedTo === 'admin') {
    const anyDone = Object.values(o.completedDates || {}).some(Boolean)
    return { kind: anyDone ? 'ready' : 'new', next: nextRoleFor(o) }
  }
  if (o.assignedTo)             return { kind: 'inprogress', role: o.assignedTo, person: o[o.assignedTo] }
  const anyDone = Object.values(o.completedDates || {}).some(Boolean)
  return { kind: anyDone ? 'ready' : 'new', next: nextRoleFor(o) }
}

// What the STATUS column shows. Status is derived from the owning role, but an
// order parked with Admin would otherwise display the next stage ('Examining')
// while nobody is examining it — so say what is actually true.
const awaitingApproval = (o) =>
  o.assignedTo === 'admin' && o.status !== 'delivered' && o.status !== 'cancelled'

// Admin-side intake. Orders placed here land in Admin's own queue
// (createOrder parks with assignedTo 'admin'), exactly like a client-placed
// order, so the approval path is identical.
// A small pill for a workload status (busiest / available).
const wlChip = (fg, bg) => ({
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: fg, background: bg, padding: '2px 6px', borderRadius: 5,
})
const wlInitials = (n = '') =>
  n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'

// A5 — Team Workload. Visualizes each production user's live active-order count
// so Admin can spot who's overloaded vs idle and rebalance: expand a person to
// see their orders and open the stage plan to move one to someone else (the
// plan editor is the single assignment surface — StagePlanModal).
function TeamWorkload() {
  const { orders } = useOrders()
  const { user } = useAuth()
  const profiles = useProfiles()
  const [assigning, setAssigning] = useState(null)
  const [openId, setOpenId] = useState(null)

  const isClosed = (o) => o.status === 'delivered' || o.status === 'cancelled'
  // Load is WEIGHTED by sub-orders: a grouped order of N searches counts as N,
  // so the bars show real work, not order count (matches the assign picker).
  const team = profiles
    .filter(p => p.role === 'user' && (p.status || 'active') === 'active')
    .map(p => {
      const active = orders.filter(o => o.assignedUserId === p.id && !isClosed(o))
      return { ...p, active, load: active.reduce((s, o) => s + workloadWeight(o), 0) }
    })
    .sort((a, b) => b.load - a.load)   // busiest first
  const maxLoad = Math.max(1, ...team.map(t => t.load))
  const busiest = team.length ? team[0].load : 0

  return (
    <QCard className="p-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold" style={{ color: Q.text }}>Team Workload</h2>
        <span style={{ fontSize: 11, color: Q.faint }}>active orders per person · click to reassign and balance</span>
      </div>
      <div className="mt-3" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {team.length === 0 && <p style={{ fontSize: 13, color: Q.muted }}>Loading the team…</p>}
        {team.map(p => {
          const load = p.load
          const overloaded = load > 1 && load === busiest
          const idle = load === 0
          return (
            <div key={p.id} style={{ border: `1px solid ${Q.border}`, borderRadius: 10, padding: '10px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, cursor: load ? 'pointer' : 'default' }}
                onClick={() => load && setOpenId(openId === p.id ? null : p.id)}>
                <span style={{ width: 32, height: 32, borderRadius: '50%', flexShrink: 0, display: 'grid',
                  placeItems: 'center', fontSize: 12, fontWeight: 700, color: '#fff', background: ROLE_COLOR }}>
                  {wlInitials(p.name)}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13.5, fontWeight: 600, color: Q.text }}>
                    {p.name}
                    {overloaded && <span style={wlChip('#d97706', '#fffbeb')}>Busiest</span>}
                    {idle && <span style={wlChip('#16a34a', '#f0fdf4')}>Available</span>}
                  </div>
                  <div style={{ height: 6, borderRadius: 4, background: Q.bg, marginTop: 5, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.round(load / maxLoad * 100)}%`,
                      background: overloaded ? '#d97706' : ROLE_COLOR, borderRadius: 4, transition: 'width 0.3s' }} />
                  </div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: Q.text, fontVariantNumeric: 'tabular-nums',
                  minWidth: 18, textAlign: 'right' }}>{load}</span>
              </div>
              {openId === p.id && load > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {p.active.map(o => (
                    <div key={o.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, color: Q.muted }}>
                      <span style={{ fontFamily: 'monospace', fontWeight: 600, color: Q.text }}>{o.id}</span>
                      {workloadWeight(o) > 1 && (
                        <span style={{ flexShrink: 0, fontSize: 10.5, fontWeight: 700, color: ROLE_COLOR,
                          background: `${ROLE_COLOR}14`, borderRadius: 5, padding: '1px 6px' }}>×{workloadWeight(o)}</span>
                      )}
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {o.type} · {STATUS_MAP[o.status]?.label || o.status}
                      </span>
                      <button onClick={(e) => { e.stopPropagation(); setAssigning(o) }}
                        style={{ marginLeft: 'auto', flexShrink: 0, fontSize: 11.5, fontWeight: 600, color: ROLE_COLOR,
                          background: `${ROLE_COLOR}12`, border: `1px solid ${ROLE_COLOR}33`, borderRadius: 6,
                          padding: '4px 9px', cursor: 'pointer' }}>
                        Reassign
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {assigning && <StagePlanModal order={assigning} user={user} onClose={() => setAssigning(null)} />}
    </QCard>
  )
}

// Which header labels are sortable, and the value each sorts on. Shared accessors
// (ordersView) keep Admin's sort identical to the client's; Total uses the billing
// estimate. Headers not listed here are not sortable.
const PIPELINE_SORT = {
  'Status': statusRank,
  'Total Price': o => invoiceAmount(o),
  'Ordered On': orderedOnValue,
  'Due By': dueByValue,
}

function OrdersPipeline({ pageSize = 6, scrollable = false }) {
  const { user } = useAuth()
  const { orders } = useOrders()
  const profiles = useProfiles()
  const ownerName = (o) => profiles.find(p => p.id === o.assignedUserId)?.name || null
  const navigate = useNavigate()
  const [assigning, setAssigning] = useState(null)  // focused assign modal
  const [search, setSearch]     = useState('')
  const [activeTab, setActiveTab] = useState('all')   // lifecycle tab
  const [showMap, setShowMap]   = useState(false)
  // Real orders per state for the inline coverage map — same source as the
  // Coverage Map page, so the two cannot disagree.
  const ordersByState = useMemo(() => orders.reduce(
    (m, o) => (o.state ? { ...m, [stateCode(o.state)]: (m[stateCode(o.state)] || 0) + 1 } : m), {}), [orders])
  const [region, setRegion]     = useState('all')
  const [stateF, setStateF]     = useState('all')
  const [countyF, setCountyF]   = useState('all')
  const [dateRange, setDateRange] = useState('365')   // "Ordered within" (days)
  const [rushOnly, setRushOnly] = useState(false)
  const [page, setPage]         = useState(1)
  const [sortKey, setSortKey]   = useState(null)   // header label of the active sort
  const [sortDir, setSortDir]   = useState(null)   // 'asc' | 'desc' | null
  const PAGE_SIZE = pageSize
  // Compact, Qualia-style rows: one padding for every header and body cell.
  const CELL_PAD = `${density.rowPadY}px ${density.rowPadX}px`

  // Cascading geographic options: state list narrows by region, county by state.
  const inRegion = (o) => region === 'all' || regionOf(o.state) === region
  const statesAvail   = [...new Set(orders.filter(inRegion).map(o => stateCode(o.state)))].sort()
  const countiesAvail = [...new Set(orders
    .filter(o => inRegion(o) && (stateF === 'all' || stateCode(o.state) === stateCode(stateF)))
    .map(o => o.county))].sort()
  const pickRegion = (v) => { setRegion(v); setStateF('all'); setCountyF('all') }
  const pickState  = (v) => { setStateF(v); setCountyF('all') }
  const resetGeo   = () => { setRegion('all'); setStateF('all'); setCountyF('all') }
  const geoActive  = region !== 'all' || stateF !== 'all' || countyF !== 'all'

  // Lifecycle tabs come from the shared orders-view model (tabOf), so Admin and
  // the client portal classify every order identically. Counts are over all
  // orders, not the filtered subset, so each tab always shows its true total.
  const counts = tabCounts(orders)
  const tabs = ORDER_TABS.map(t => ({ ...t, count: counts[t.key] }))

  const filtered = orders.filter(o => {
    const q = search.toLowerCase()
    // Search across the columns on screen: order #, client, their own file number
    // (quoted on the phone / in email subjects), product and property.
    const matchSearch = !q || displayClient(o, user).toLowerCase().includes(q)
      || o.id.toLowerCase().includes(q)
      || (o.clientFileNo || '').toLowerCase().includes(q)
      || (o.type || '').toLowerCase().includes(q)
      || propertyOf(o).toLowerCase().includes(q)
    const matchTab    = activeTab === 'all' || tabOf(o) === activeTab
    const matchRegion = region === 'all'  || regionOf(o.state) === region
    const matchState  = stateF === 'all'  || stateCode(o.state) === stateCode(stateF)
    const matchCounty = countyF === 'all' || o.county === countyF
    const matchRush   = !rushOnly || o.priority === 'rush'
    const matchDate   = withinRange(o, dateRange)
    return matchSearch && matchTab && matchRegion && matchState && matchCounty && matchRush && matchDate
  })

  // Column sort (applied before paging). Clicking a header cycles asc → desc → off.
  const sortAcc = sortKey ? PIPELINE_SORT[sortKey] : null
  const sorted = sortAcc ? sortByAccessor(filtered, sortAcc, sortDir) : filtered
  const onSort = (h) => {
    if (!PIPELINE_SORT[h]) return
    if (sortKey !== h) { setSortKey(h); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null); setSortDir(null)
  }

  // Pagination
  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const paged      = sorted.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  // Reset to first page whenever the filter set or sort changes.
  useEffect(() => { setPage(1) }, [activeTab, search, region, stateF, countyF, dateRange, rushOnly, sortKey, sortDir])

  const CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>\")"
  const filterSelectStyle = {
    appearance:'none', WebkitAppearance:'none', MozAppearance:'none',
    height:38, padding:'0 30px 0 12px', borderRadius:8, border:`1px solid ${Q.border}`,
    background:`${Q.card} ${CHEVRON} no-repeat right 10px center`, backgroundSize:'12px',
    color:Q.text, fontSize:13, fontWeight:500, outline:'none', cursor:'pointer',
  }
  const ctlBtn = {
    height:38, display:'flex', alignItems:'center', gap:6, padding:'0 14px',
    borderRadius:8, fontSize:13, fontWeight:600, cursor:'pointer',
  }

  return (
    <div className="space-y-4">
      {assigning && <StagePlanModal order={assigning} user={user} onClose={() => setAssigning(null)} />}
      {/* Toolbar — row 1: search · date range · new order */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative" style={{ flex:'1 1 260px', minWidth: 240 }}>
          <Search style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', width:15, height:15, color:Q.faint }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search order #, client, file #, product, property…"
            style={{
              width:'100%', height:38, paddingLeft:34, paddingRight:12,
              background:Q.card, border:`1px solid ${Q.border}`, borderRadius:8,
              color:Q.text, fontSize:13, outline:'none',
            }}
            onFocus={e => e.target.style.borderColor = ROLE_COLOR}
            onBlur={e => e.target.style.borderColor = Q.border}
          />
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:13, color:Q.muted, whiteSpace:'nowrap' }}>Ordered within</span>
          <select value={dateRange} onChange={e => setDateRange(e.target.value)} style={filterSelectStyle} title="Ordered within">
            {DATE_RANGES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
      </div>

      {/* Toolbar — row 2: filter chips */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap',
        background:Q.card, border:`1px solid ${Q.border}`, borderRadius:10, padding:'8px 12px' }}>
        <Filter style={{ width:15, height:15, color:Q.faint }} />
        <span style={{ fontSize:12, fontWeight:600, color:Q.faint, textTransform:'uppercase', letterSpacing:'0.05em', marginRight:2 }}>Filters</span>
        <select value={region} onChange={e => pickRegion(e.target.value)} style={filterSelectStyle} title="Region">
          <option value="all">All regions</option>
          {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={stateF} onChange={e => pickState(e.target.value)} style={filterSelectStyle} title="State">
          <option value="all">All states</option>
          {statesAvail.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={countyF} onChange={e => setCountyF(e.target.value)} style={filterSelectStyle} title="County">
          <option value="all">All counties</option>
          {countiesAvail.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <button onClick={() => setRushOnly(v => !v)} title="Show rush-priority orders only" style={{
          ...ctlBtn,
          background: rushOnly ? '#fef2f2' : Q.card,
          color:      rushOnly ? '#dc2626' : Q.muted,
          border: `1px solid ${rushOnly ? '#fecaca' : Q.border}`,
        }}>
          <span style={{ width:7, height:7, borderRadius:99, background: rushOnly ? '#dc2626' : Q.faint }} />
          Rush only
        </button>
        {(geoActive || rushOnly) && (
          <button onClick={() => { resetGeo(); setRushOnly(false) }} style={{
            ...ctlBtn, background:'transparent', border:`1px solid ${Q.border}`, color:Q.muted, marginLeft:'auto',
          }}>
            <X style={{ width:13, height:13 }} /> Clear filters
          </button>
        )}
      </div>

      {/* Tab bar */}
      <div className="overflow-x-auto" style={{ display:'flex', gap:0, borderBottom:`1px solid ${Q.border}` }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            className="shrink-0 whitespace-nowrap"
            style={{
              display:'flex', alignItems:'center', gap:6,
              padding:'10px 16px', fontSize:13, fontWeight:500,
              color: activeTab === t.key ? ROLE_COLOR : Q.muted,
              borderBottom: activeTab === t.key ? `2px solid ${ROLE_COLOR}` : '2px solid transparent',
              marginBottom: -1, background:'transparent', border:'none',
              borderBottomWidth:2, borderBottomStyle:'solid',
              borderBottomColor: activeTab === t.key ? ROLE_COLOR : 'transparent',
              cursor:'pointer', transition:'color 0.15s',
            }}>
            {t.label}
            <span style={{
              padding:'1px 7px', borderRadius:99, fontSize:11, fontWeight:700,
              background: activeTab === t.key ? `${ROLE_COLOR}18` : Q.bg,
              color: activeTab === t.key ? ROLE_COLOR : Q.faint,
            }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Orders table */}
      <div style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:10, boxShadow:Q.shadow, overflow:'hidden' }}>
        {/* scrollable=true (Orders page): the body scrolls within a capped height
            with a sticky header, so all rows are reachable without paging away.
            The cap never drops below 560px but grows on tall screens so a
            20-row page fits without an inner scroll. */}
        <div style={{ overflowX:'auto', ...(scrollable ? { maxHeight:'max(560px, calc(100vh - 410px))', overflowY:'auto' } : {}) }}>
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:density.bodySize, lineHeight:density.lineHeight, minWidth:990 }}>
          <thead>
            <tr style={{ background:'#F9FBFD', borderBottom:`1px solid ${Q.border}` }}>
              {['Order','Status','Customer','Customer File','Product','Property','Total Price','Ordered On','Due By','Assignee',''].map(h => {
                const sortable = !!PIPELINE_SORT[h]
                const active = sortable && sortKey === h
                const caret = active ? (sortDir === 'asc' ? '▲' : '▼') : (sortable ? '↕' : '')
                return (
                  <th key={h} onClick={sortable ? () => onSort(h) : undefined}
                    title={sortable ? `Sort by ${h}` : undefined}
                    style={{
                      padding:CELL_PAD, textAlign:'left', fontSize:density.headSize,
                      fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em',
                      color: active ? ROLE_COLOR : Q.faint, whiteSpace:'nowrap',
                      cursor: sortable ? 'pointer' : 'default', userSelect:'none',
                      ...(scrollable ? { position:'sticky', top:0, background:'#F9FBFD', zIndex:1 } : {}),
                    }}>
                    {h}
                    {sortable && <span style={{ marginLeft:5, fontSize:9, color: active ? ROLE_COLOR : Q.faint, opacity: active ? 1 : 0.5 }}>{caret}</span>}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody>
            {paged.map((o, i) => {
              const r = routingState(o)
              return (
                <motion.tr key={o.id}
                  initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: i * 0.04 }}
                  style={{ borderBottom:`1px solid ${Q.border}`, cursor:'pointer' }}
                  onMouseOver={e => e.currentTarget.style.background = Q.rowHover}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => navigate(`/admin/orders/${o.id}`)}>
                  <td style={{ padding:CELL_PAD, whiteSpace:'nowrap' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{ fontFamily:'monospace', fontWeight:700, fontSize:12, color:ROLE_COLOR }}>{o.id}</span>
                      {o.priority === 'rush' && (
                        <span style={{ fontSize:10, fontWeight:700, padding:'2px 6px',
                          borderRadius:4, background:'#fef2f2', color:'#dc2626' }}>RUSH</span>
                      )}
                    </div>
                  </td>
                  {/* ONE status badge (O3): the current stage, colour-coded, with
                      On-Hold / Clarification as modifiers. The routing noise that
                      used to stack here (New / Ready / Assigned / Awaiting-confirm)
                      lives in the Assignee column, which names who holds the order. */}
                  <td style={{ padding:CELL_PAD, whiteSpace:'nowrap' }}>
                    <StatusBadge status={o.status} awaiting={awaitingApproval(o)}
                      onHold={!!o.workflow?.onHold} clarification={o.clarification === 'pending'} />
                  </td>
                  <td style={{ padding:CELL_PAD, fontWeight:500, color:Q.text, whiteSpace:'nowrap' }}>{displayClient(o, user)}</td>
                  <td style={{ padding:CELL_PAD, fontFamily:'monospace', fontSize:11.5, color:Q.muted, whiteSpace:'nowrap' }}>{o.clientFileNo || '—'}</td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, whiteSpace:'nowrap', fontSize:12 }}>{o.type}</td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, fontSize:12, maxWidth:220, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }} title={propertyOf(o)}>{propertyOf(o)}</td>
                  {/* Total Price — the order's amount (catalogue estimate until the
                      Typer stamps the final invoice), with the payment status beneath
                      so money lives in its own column, never mixed into Status. */}
                  <td style={{ padding:CELL_PAD, whiteSpace:'nowrap' }}>
                    <div style={{ fontSize:12.5, fontWeight:600, color:Q.text }}>{money(invoiceAmount(o))}</div>
                    <div style={{ fontSize:10.5, fontWeight:600, color:(PAY_STATUS[payStatusOf(o)] || PAY_STATUS.unpaid).color }}>
                      {(PAY_STATUS[payStatusOf(o)] || PAY_STATUS.unpaid).label}
                    </div>
                  </td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, fontSize:12, whiteSpace:'nowrap' }}>{o.created || '—'}</td>
                  <td style={{ padding:CELL_PAD, fontSize:12, whiteSpace:'nowrap',
                    color: o.completed ? '#16a34a' : Q.muted }}>
                    {o.completed ? `Done ${o.completed}` : (o.eta || '—')}
                  </td>
                  {/* Assignee — the real current owner (assigned_user_id → name)
                      and which stage they hold, not the empty o[assignedTo]. */}
                  <td style={{ padding:CELL_PAD, fontSize:12, whiteSpace:'nowrap',
                    color: (o.assignedTo && o.assignedTo !== 'admin') ? Q.text : Q.faint }}>
                    {o.assignedTo === 'admin'
                      ? 'Admin'
                      : o.assignedTo === 'user'
                        ? (ownerName(o)
                            ? <>{ownerName(o)}{nextRoleFor(o) ? <span style={{ color:Q.faint }}> · {cap(nextRoleFor(o))}</span> : null}</>
                            : 'Production (unassigned)')
                        : '—'}
                  </td>
                  <td style={{ padding:CELL_PAD }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      {r.kind !== 'delivered' && (
                        <button onClick={e => { e.stopPropagation(); setAssigning(o) }}
                          style={{ display:'flex', alignItems:'center', gap:5, padding:'6px 12px', borderRadius:7,
                            background:`${ROLE_COLOR}12`, border:`1px solid ${ROLE_COLOR}40`, cursor:'pointer',
                            color:ROLE_COLOR, fontSize:12, fontWeight:600, whiteSpace:'nowrap' }}
                          onMouseOver={e => e.currentTarget.style.background = `${ROLE_COLOR}22`}
                          onMouseOut={e => e.currentTarget.style.background = `${ROLE_COLOR}12`}>
                          <Workflow style={{ width:13, height:13 }} />
                          {hasStagePlan(o) ? 'Edit plan' : 'Set plan'}
                        </button>
                      )}
                      <button title="View details" onClick={e => { e.stopPropagation(); navigate(`/admin/orders/${o.id}`) }}
                        style={{ padding:6, borderRadius:6, background:'transparent', border:'none', cursor:'pointer', color:Q.faint }}
                        onMouseOver={e => e.currentTarget.style.background = '#EDF0F5'}
                        onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
                        <Eye style={{ width:14, height:14 }} />
                      </button>
                    </div>
                  </td>
                </motion.tr>
              )
            })}
          </tbody>
        </table>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:'48px 16px', textAlign:'center', color:Q.faint }}>
            <FileText style={{ width:32, height:32, margin:'0 auto 8px', opacity:0.4 }} />
            <p style={{ fontSize:13 }}>No orders match your filters</p>
          </div>
        )}
        {filtered.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'10px 16px', borderTop:`1px solid ${Q.border}`, background:'#F9FBFD' }}>
            <span style={{ fontSize:12, color:Q.muted }}>
              Showing <strong style={{ color:Q.text }}>{(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filtered.length)}</strong> of <strong style={{ color:Q.text }}>{filtered.length}</strong> orders
            </span>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage <= 1}
                style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600,
                  border:`1px solid ${Q.border}`, background:Q.card,
                  color: safePage <= 1 ? Q.faint : Q.text, cursor: safePage <= 1 ? 'not-allowed' : 'pointer' }}>
                Prev
              </button>
              <span style={{ fontSize:12, color:Q.muted }}>Page {safePage} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}
                style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600,
                  border:`1px solid ${Q.border}`, background:Q.card,
                  color: safePage >= totalPages ? Q.faint : Q.text, cursor: safePage >= totalPages ? 'not-allowed' : 'pointer' }}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Collapsible coverage map */}
      <div style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:10, boxShadow:Q.shadow, overflow:'hidden' }}>
        <button onClick={() => setShowMap(!showMap)} style={{
          width:'100%', display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'12px 20px', background:'transparent', border:'none', cursor:'pointer',
          fontSize:13, fontWeight:600, color:Q.text,
        }}
          onMouseOver={e => e.currentTarget.style.background = '#F9FBFD'}
          onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
          <span style={{ display:'flex', alignItems:'center', gap:8 }}>
            <MapPin style={{ width:15, height:15, color:ROLE_COLOR }} />
            National Coverage Map
            <span style={{ fontSize:12, fontWeight:400, color:Q.faint }}>— hover states for order details</span>
          </span>
          {showMap
            ? <ChevronUp style={{ width:15, height:15, color:Q.faint }} />
            : <ChevronDown style={{ width:15, height:15, color:Q.faint }} />}
        </button>
        {showMap && (
          <div style={{ borderTop:`1px solid ${Q.border}`, padding:'16px 20px 20px' }}>
            <USAMap counts={ordersByState} />
          </div>
        )}
      </div>
    </div>
  )
}

function AdminHome() {
  const { activityLog, orders } = useOrders()
  const { user } = useAuth()
  const isClosed       = (o) => o.status === 'delivered' || o.status === 'cancelled'
  const activeCount    = orders.filter(o => !isClosed(o)).length
  const deliveredCount = orders.filter(o => o.status === 'delivered').length
  const rushCount      = orders.filter(o => o.priority === 'rush' && !isClosed(o)).length
  // Orders sitting with Admin: parked for approval between stages, or never
  // routed at all. Previously this tested `assignedTo == null`, which parked
  // orders never satisfy (they carry assignedTo 'admin'), so it always read 0.
  const toAssignCount  = orders.filter(o => !isClosed(o) && (o.assignedTo === 'admin' || o.assignedTo == null)).length
  // A client counts as active while it has at least one order in flight.
  const activeClients  = new Set(orders.filter(o => !isClosed(o)).map(o => o.clientCode || clientCode(o.client)).filter(Boolean)).size
  const navigate = useNavigate()
  const orderIds = useMemo(() => new Set(orders.map(o => o.id)), [orders])
  // Recent Activity: the referenced order links to its detail page. The entry's
  // own orderId wins; otherwise an RTS-#### mentioned in the text is used. When
  // that id appears verbatim in the text we underline just that token; when the
  // order is known but its id isn't in the text, the whole line opens it. No
  // known order at all → the line stays plain.
  const linkStyle = { background:'none', border:'none', padding:0, font:'inherit', color:'inherit',
    cursor:'pointer', textAlign:'left' }
  const activityText = (a) => {
    const parts  = String(a.action || '').split(/(RTS-\d+)/)   // odd indexes are whole RTS tokens
    const id = [a.orderId, ...parts.filter((_, i) => i % 2)].find(x => x && orderIds.has(x))
    if (!id) return a.action
    const open = () => navigate(`/admin/orders/${id}`)
    const hover = { onMouseOver: e => e.currentTarget.style.color = ROLE_COLOR,
      onMouseOut: e => e.currentTarget.style.color = 'inherit' }
    const at = parts.indexOf(id)
    if (at > 0 && at % 2 === 1) {   // id is a token in the text → underline it inline
      return <>
        {parts.slice(0, at).join('')}
        <button type="button" onClick={open} title={`Open ${id}`} {...hover}
          style={{ ...linkStyle, textDecoration:'underline', textDecorationColor:Q.faint, textUnderlineOffset:2 }}>{id}</button>
        {parts.slice(at + 1).join('')}
      </>
    }
    // Known order, but its id isn't written in the text → make the line clickable.
    return <button type="button" onClick={open} title={`Open ${id}`} {...hover} style={linkStyle}>{a.action}</button>
  }
  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: Q.text }}>Operations Dashboard</h1>
          <p className="text-sm mt-0.5" style={{ color: Q.muted }}>Resolute Title Services — June 2026</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => exportOrdersCsv(orders, user)} style={csvBtnStyle} title="Download all orders as CSV">
            <Download style={{ width: 14, height: 14 }} /> Export Orders CSV
          </button>
          <span className="text-xs px-3 py-1.5 rounded-full font-semibold"
            style={{ background:'#f0fdf4', color:'#16a34a', border:'1px solid #bbf7d0' }}>
            All systems operational
          </span>
        </div>
      </div>

      {/* Stats — live from order data */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={Package}     label="Active Orders"     value={activeCount}    sub={`${rushCount} rush priority`}      color={ROLE_COLOR} delay={0}    />
        <StatCard icon={CheckCircle} label="Delivered"         value={deliveredCount} sub="completed orders"                 color="#16a34a"    delay={0.05} />
        <StatCard icon={Clock}       label="Awaiting Approval" value={toAssignCount}  sub="parked with Admin"                color="#d97706"    delay={0.10} />
        <StatCard icon={Users}       label="Active Clients"    value={activeClients}  sub="with orders in flight"            color="#00B8D9"    delay={0.15} />
      </div>

      {/* Chart + Activity */}
      <div className="grid lg:grid-cols-3 gap-4">
        <QCard className="lg:col-span-2 p-5">
          <h2 className="text-sm font-semibold mb-4" style={{ color: Q.text }}>Monthly Order Volume</h2>
          <ResponsiveContainer width="100%" height={175}>
            <AreaChart data={MONTHLY_STATS}>
              <defs>
                <linearGradient id="ogGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor={ROLE_COLOR} stopOpacity={0.22}/>
                  <stop offset="95%" stopColor={ROLE_COLOR} stopOpacity={0}/>
                </linearGradient>
              </defs>
              <XAxis dataKey="month" tick={{ fill:Q.faint, fontSize:11 }} axisLine={false} tickLine={false}/>
              <YAxis tick={{ fill:Q.faint, fontSize:11 }} axisLine={false} tickLine={false}/>
              <Tooltip contentStyle={{ background:'#fff', border:`1px solid ${Q.border}`, borderRadius:8, fontSize:12, boxShadow:Q.shadow }}/>
              <Area type="monotone" dataKey="orders"    stroke={ROLE_COLOR} fill="url(#ogGrad)" strokeWidth={2} name="Orders"/>
              <Area type="monotone" dataKey="delivered" stroke="#16a34a"    fill="none"          strokeWidth={2} strokeDasharray="4 4" name="Delivered"/>
            </AreaChart>
          </ResponsiveContainer>
        </QCard>

        <QCard className="p-5">
          <h2 className="text-sm font-semibold mb-4" style={{ color: Q.text }}>Recent Activity</h2>
          <div className="space-y-3">
            {activityLog.slice(0, 5).map((a, i) => (
              <div key={a.id ?? i} style={{ display:'flex', gap:10 }}>
                <div style={{
                  width:8, height:8, borderRadius:99, flexShrink:0, marginTop:5,
                  background: a.type==='new' ? ROLE_COLOR : a.type==='delivered' ? '#16a34a'
                    : a.type==='progress' ? '#d97706' : '#00B8D9',
                }} />
                <div>
                  <p style={{ fontSize:12, lineHeight:'1.5', color:Q.muted }}>{activityText(a)}</p>
                  <p style={{ fontSize:11, marginTop:2, color:Q.faint }}>{a.time}</p>
                </div>
              </div>
            ))}
          </div>
        </QCard>
      </div>

      {/* A5 — per-person workload, with reassign to rebalance */}
      <TeamWorkload />

      {/* Qualia-like orders pipeline */}
      <OrdersPipeline />
    </div>
  )
}

function AdminOrders() {
  const { orders } = useOrders()
  const { user } = useAuth()
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: Q.text }}>Order Management</h1>
          <p className="text-sm" style={{ color: Q.muted }}>All active and completed title search orders</p>
        </div>
        <button onClick={() => exportOrdersCsv(orders, user)} style={csvBtnStyle} title="Download all orders as CSV">
          <Download style={{ width: 14, height: 14 }} /> Export Orders CSV
        </button>
      </div>
      <OrdersPipeline pageSize={20} scrollable />
    </div>
  )
}

// Admin User Management (CRUD) — live users via the service-role serverless
// endpoint (/api/admin/users) when Supabase is configured; falls back to the
// read-only mock roster otherwise (e.g. local mock mode / no serverless).
// Post-D3 the four stage login roles are retired: a new staff account is either
// an admin or a production `user`. (client is set on the client side.) The enum
// still carries the stage labels for history, but Admin never mints them.
const USER_ROLES = ['admin', 'user', 'client']

// Stage-scope (trainee) helper: translate the four work stages a production user
// may do, to/from the portable permissions grants. All four selected = unscoped
// (empty grants); a subset = revoke the all-stages default, then re-grant scoped.
const permissionsForStages = (stages) => {
  if (stages.length >= ROLE_SEQUENCE.length) return []
  return [
    { capability: 'orders.work', effect: 'revoke' },
    ...(stages.length ? [{ capability: 'orders.work', effect: 'grant', scope: { stages } }] : []),
  ]
}
const stagesForUser = (role, permissions) => {
  const w = workableStages({ role, permissions: permissions || [] })
  return w === null ? ROLE_SEQUENCE.slice() : w   // null = every stage
}

async function usersApi(method, body) {
  const token = await getAccessToken()
  const res = await fetch('/api/admin/users', {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `Request failed (HTTP ${res.status})`)
  return j
}

// `canGrantSuper` — whether the signed-in admin is a super admin. Only then are
// the super-admin / billing toggles editable (a plain admin manages basic users).
function UserFormModal({ initial, onClose, onSave, busy, canGrantSuper }) {
  const isEdit = !!initial?.id
  const [f, setF] = useState({
    name: initial?.name || '', email: initial?.email || '', role: initial?.role || 'client',
    clientCode: initial?.clientCode || '',
    superAdmin: !!initial?.superAdmin,
    canConfirmPayments: !!initial?.canConfirmPayments,
    stages: stagesForUser(initial?.role || 'user', initial?.permissions),
  })
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const toggleStage = (s) => setF(st => ({ ...st, stages: st.stages.includes(s) ? st.stages.filter(x => x !== s) : [...st.stages, s] }))
  const inputStyle = { width: '100%', padding: '9px 12px', border: `1px solid ${Q.border}`, borderRadius: 8, fontSize: 13, outline: 'none', color: Q.text, background: '#fff' }
  const lbl = { fontSize: 11, fontWeight: 600, color: Q.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }

  const submit = () => {
    const payload = { id: initial?.id, name: f.name, email: f.email, role: f.role, clientCode: f.clientCode }
    // Stage scope only applies to production users; everyone else clears grants.
    payload.permissions = f.role === 'user' ? permissionsForStages(f.stages) : []
    // Only send the elevated bits when the caller may set them AND the role is admin,
    // so a plain admin's basic edits never trip the server's super-admin gate.
    if (canGrantSuper && f.role === 'admin') {
      payload.superAdmin = f.superAdmin
      payload.canConfirmPayments = f.canConfirmPayments
    }
    onSave(payload)
  }

  const Toggle = ({ k, label, hint }) => (
    <button type="button" disabled={!canGrantSuper} onClick={() => set(k, !f[k])}
      style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left', padding: '9px 11px',
        borderRadius: 8, cursor: canGrantSuper ? 'pointer' : 'not-allowed', background: f[k] ? `${ROLE_COLOR}10` : Q.bg,
        border: `1px solid ${f[k] ? ROLE_COLOR : Q.border}`, opacity: canGrantSuper ? 1 : 0.55 }}>
      <span style={{ width: 34, height: 20, borderRadius: 99, flexShrink: 0, position: 'relative', transition: 'all .15s',
        background: f[k] ? ROLE_COLOR : Q.border }}>
        <span style={{ position: 'absolute', top: 2, left: f[k] ? 16 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'all .15s' }} />
      </span>
      <span style={{ minWidth: 0 }}>
        <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: Q.text }}>{label}</span>
        <span style={{ display: 'block', fontSize: 11, color: Q.muted }}>{hint}</span>
      </span>
    </button>
  )

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(12,29,56,0.45)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: Q.card, borderRadius: 12, width: '100%', maxWidth: 440, maxHeight: '90vh', overflowY: 'auto', padding: 22 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: Q.text, marginBottom: 14 }}>{isEdit ? 'Edit user' : 'Invite / add user'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={lbl}>Name</label>
            <input value={f.name} onChange={e => set('name', e.target.value)} style={inputStyle} placeholder="Full name" />
          </div>
          <div>
            <label style={lbl}>Email</label>
            <input value={f.email} onChange={e => set('email', e.target.value)} disabled={isEdit} style={{ ...inputStyle, opacity: isEdit ? 0.6 : 1 }} placeholder="user@company.com" />
          </div>
          <div>
            <label style={lbl}>Role</label>
            <select value={f.role} onChange={e => set('role', e.target.value)} style={inputStyle}>
              {USER_ROLES.map(r => <option key={r} value={r}>{r === 'user' ? 'production' : r}</option>)}
            </select>
          </div>
          {f.role === 'client' && (
            <div>
              <label style={lbl}>Client code</label>
              <input value={f.clientCode} onChange={e => set('clientCode', e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. CL08" />
            </div>
          )}

          {/* Admin access level — super admin (PII + payouts) and the money gate. */}
          {f.role === 'admin' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={lbl}>Access</label>
              <Toggle k="superAdmin" label="Super admin" hint="Sees client details + vendor payouts" />
              <Toggle k="canConfirmPayments" label="Billing — confirm payments" hint="The only one who can mark funds received" />
              {!canGrantSuper && <div style={{ fontSize: 11, color: '#b45309' }}>Only a super admin can change these.</div>}
            </div>
          )}

          {/* Production stage scope — the trainee case ("screener only", etc.). */}
          {f.role === 'user' && (
            <div>
              <label style={lbl}>Stages this person can work</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginTop: 6 }}>
                {ROLE_SEQUENCE.map(s => {
                  const on = f.stages.includes(s)
                  return (
                    <button key={s} type="button" onClick={() => toggleStage(s)}
                      style={{ padding: '7px 10px', borderRadius: 8, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize',
                        background: on ? `${ROLE_COLOR}12` : Q.bg, border: `1px solid ${on ? ROLE_COLOR : Q.border}`, color: on ? ROLE_COLOR : Q.muted }}>
                      {on ? '✓ ' : ''}{s}
                    </button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: Q.muted, marginTop: 6 }}>
                {f.stages.length >= ROLE_SEQUENCE.length ? 'All stages (full production access).'
                  : f.stages.length ? `Limited to ${f.stages.join(', ')} — admin can only route these stages to them.`
                  : 'No stages selected — they won’t be assignable to any stage.'}
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button disabled={busy || !f.email || !f.role} onClick={submit}
            style={{ flex: 1, padding: '10px', background: ROLE_COLOR, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: busy ? 'wait' : 'pointer', opacity: (!f.email || !f.role) ? 0.6 : 1 }}>
            {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create user'}
          </button>
          <button onClick={onClose} style={{ padding: '10px 18px', background: Q.bg, border: `1px solid ${Q.border}`, borderRadius: 8, color: Q.muted, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

function AdminUsers() {
  const { user: me } = useAuth()
  const canGrantSuper = can(me, 'users.grant_super')   // super admins elevate others
  const live = isSupabaseConfigured
  const [users, setUsers] = useState(() => live ? [] : USERS.map(u => ({ ...u, active: u.status !== 'inactive' })))
  const [loading, setLoading] = useState(live)
  const [err, setErr] = useState('')
  const [editing, setEditing] = useState(null)   // form initial, or {} for new
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')       // temp password / reset link

  const load = () => {
    if (!live) return
    setLoading(true)
    usersApi('GET').then(j => setUsers(j.users || [])).catch(e => setErr(e.message)).finally(() => setLoading(false))
  }
  useEffect(() => { load() }, [])   // eslint-disable-line react-hooks/exhaustive-deps

  // After any roster-changing action, refresh BOTH the admin user table (load, the
  // /api/admin/users GET) and the shared profiles cache (refreshProfiles, used by
  // the Stage-plan assign picker) so a newly-created production user is immediately
  // selectable for assignment — no page reload required.
  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); load(); refreshProfiles() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const toggleActive = (u) => run(() => usersApi('POST', { action: 'setActive', id: u.id, active: !u.active }))
  const remove = (u) => { if (window.confirm(`Remove ${u.name || u.email}? This permanently deletes their account.`)) run(() => usersApi('POST', { action: 'remove', id: u.id })) }
  const reset = (u) => run(async () => { const j = await usersApi('POST', { action: 'resetPassword', email: u.email }); setNotice(`Password reset link for ${u.email}:\n\n${j.link || '(recovery email sent)'}`) })
  const save = (form) => run(async () => {
    // Forward the elevated bits only when present (the form includes them solely
    // for a super-admin caller editing an admin), plus the stage-scope grants.
    const base = { name: form.name, role: form.role, clientCode: form.clientCode, permissions: form.permissions }
    if ('superAdmin' in form) base.superAdmin = form.superAdmin
    if ('canConfirmPayments' in form) base.canConfirmPayments = form.canConfirmPayments
    if (form.id) await usersApi('POST', { action: 'update', id: form.id, ...base })
    else {
      const j = await usersApi('POST', { action: 'create', email: form.email, ...base })
      setNotice(j.inviteLink
        ? `Invitation ready for ${form.email}.\n\nSend them this secure link to set their own password (expires shortly):\n\n${j.inviteLink}`
        : `User ${form.email} created. Use “Reset” on their row to send a set-password link.`)
    }
    setEditing(null)
  })

  // Post-D3 (ADR 0001) production staff are one consolidated `user` role, so the
  // roster breaks down as Admins / Production / Clients — no per-stage buckets.
  const counts = [
    { role: 'Admins', count: users.filter(u => u.role === 'admin').length, color: '#2441E5' },
    { role: 'Production', count: users.filter(u => u.role === 'user').length, color: '#1B34C4' },
    { role: 'Clients', count: users.filter(u => u.role === 'client').length, color: '#2441E5' },
  ]
  const btn = (label, onClick, tone = 'muted', disabled = false) => (
    <button onClick={onClick} disabled={disabled || busy}
      style={{ padding: '5px 10px', borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: (disabled || busy) ? 'not-allowed' : 'pointer',
        background: '#fff', border: `1px solid ${Q.border}`, color: tone === 'danger' ? '#dc2626' : tone === 'accent' ? ROLE_COLOR : Q.muted, whiteSpace: 'nowrap' }}>
      {label}
    </button>
  )

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: Q.text }}>User Management</h1>
          <p className="text-sm" style={{ color: Q.muted }}>Team members and client accounts{live ? '' : ' · read-only (backend not configured)'}</p>
        </div>
        {live && (
          <button onClick={() => setEditing({})} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', background: ROLE_COLOR, border: 'none', borderRadius: 8, color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}
            onMouseOver={e => e.currentTarget.style.background = ROLE_HOVER} onMouseOut={e => e.currentTarget.style.background = ROLE_COLOR}>
            <Plus style={{ width: 15, height: 15 }} /> Invite User
          </button>
        )}
      </div>

      {err && <div style={{ padding: '10px 14px', borderRadius: 8, background: '#fef2f2', border: '1px solid #fecaca', color: '#dc2626', fontSize: 13 }}>{err}</div>}
      {notice && (
        <div style={{ padding: '12px 14px', borderRadius: 8, background: '#f0fdf4', border: '1px solid #bbf7d0', color: '#166534', fontSize: 13, whiteSpace: 'pre-wrap', position: 'relative' }}>
          <button onClick={() => setNotice('')} style={{ position: 'absolute', top: 8, right: 10, background: 'none', border: 'none', cursor: 'pointer', color: '#166534', fontWeight: 700 }}>×</button>
          {notice}
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
        {counts.map(r => (
          <div key={r.role} style={{ background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 10, boxShadow: Q.shadow, padding: '16px 20px' }}>
            <div style={{ fontSize: 28, fontWeight: 700, color: Q.text }}>{r.count}</div>
            <div style={{ fontSize: 13, color: Q.muted, marginTop: 2 }}>{r.role}</div>
            <div style={{ marginTop: 10, height: 3, borderRadius: 99, background: r.color, opacity: 0.5 }} />
          </div>
        ))}
      </div>

      <div style={{ background: Q.card, border: `1px solid ${Q.border}`, borderRadius: 10, boxShadow: Q.shadow, overflow: 'hidden' }}>
        <div className="overflow-x-auto">
          <table className="min-w-[760px]" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#F9FBFD', borderBottom: `1px solid ${Q.border}` }}>
                {['Name', 'Email', 'Role', 'Status', live ? 'Actions' : 'Joined'].map(h => (
                  <th key={h} style={{ padding: '10px 16px', textAlign: 'left', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: Q.faint }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={5} style={{ padding: '28px 16px', textAlign: 'center', color: Q.faint, fontSize: 13 }}>Loading users…</td></tr>}
              {!loading && users.length === 0 && <tr><td colSpan={5} style={{ padding: '28px 16px', textAlign: 'center', color: Q.faint, fontSize: 13 }}>No users.</td></tr>}
              {!loading && users.map((u, i) => {
                const active = live ? u.active : u.status !== 'inactive'
                return (
                  <tr key={u.id || u.email || i} style={{ borderBottom: `1px solid ${Q.border}` }}>
                    <td style={{ padding: '10px 16px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 700, background: `${ROLE_COLOR}18`, color: ROLE_COLOR }}>
                          {(u.name || u.email || '?').split(' ').map(n => n[0]).join('').slice(0, 2).toUpperCase()}
                        </div>
                        <span style={{ fontWeight: 500, color: Q.text }}>
                          {u.name || '—'}
                          {u.superAdmin && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#b45309' }}>SUPER</span>}
                          {u.canConfirmPayments && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#16a34a' }}>BILLING</span>}
                          {u.role === 'user' && workableStages({ role: 'user', permissions: u.permissions }) && (
                            <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: ROLE_COLOR }}>
                              {workableStages({ role: 'user', permissions: u.permissions }).map(s => s[0].toUpperCase()).join('')}-ONLY
                            </span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '10px 16px', color: Q.muted, fontSize: 12 }}>{u.email}</td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, background: `${ROLE_COLOR}14`, color: ROLE_COLOR, textTransform: 'capitalize' }}>{u.role || '—'}{u.role === 'client' && u.clientCode ? ` · ${u.clientCode}` : ''}</span>
                    </td>
                    <td style={{ padding: '10px 16px' }}>
                      <span style={{ padding: '3px 10px', borderRadius: 99, fontSize: 11, fontWeight: 600, ...(active ? { background: '#f0fdf4', color: '#16a34a', border: '1px solid #bbf7d0' } : { background: '#fef2f2', color: '#dc2626', border: '1px solid #fecaca' }) }}>
                        {active ? 'active' : 'inactive'}
                      </span>
                    </td>
                    {live ? (
                      <td style={{ padding: '10px 16px' }}>
                        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {btn('Edit', () => setEditing({ id: u.id, name: u.name, email: u.email, role: u.role, clientCode: u.clientCode, superAdmin: u.superAdmin, canConfirmPayments: u.canConfirmPayments, permissions: u.permissions }), 'accent')}
                          {btn(active ? 'Deactivate' : 'Activate', () => toggleActive(u))}
                          {btn('Reset', () => reset(u))}
                          {btn('Remove', () => remove(u), 'danger')}
                        </div>
                      </td>
                    ) : (
                      <td style={{ padding: '10px 16px', fontSize: 12, color: Q.faint }}>{u.joined || '—'}</td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <UserFormModal initial={editing} busy={busy} canGrantSuper={canGrantSuper} onClose={() => setEditing(null)} onSave={save} />}
    </div>
  )
}

function AdminMap() {
  const { orders } = useOrders()
  // Top five states by live order volume; no fabricated totals.
  const byState = orders.reduce((m, o) => (o.state ? { ...m, [stateCode(o.state)]: (m[stateCode(o.state)] || 0) + 1 } : m), {})
  const top = Object.entries(byState).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([s, c]) => ({ s, c }))
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold" style={{ color: Q.text }}>Coverage Map</h1>
        <p className="text-sm" style={{ color: Q.muted }}>Real-time order distribution across all 50 states</p>
      </div>
      <QCard className="p-6"><USAMap counts={byState} /></QCard>
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
        {top.map(({s,c}) => (
          <div key={s}
            style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:10,
              boxShadow:Q.shadow, padding:'16px', textAlign:'center' }}>
            <div style={{ fontSize:30, fontWeight:700, color:ROLE_COLOR }}>{c}</div>
            <div style={{ fontSize:13, fontWeight:600, marginTop:4, color:Q.muted }}>{s}</div>
            <div style={{ fontSize:11, color:Q.faint }}>active orders</div>
          </div>
        ))}
      </div>
    </div>
  )
}

function AdminReports() {
  const { user } = useAuth()
  const { orders } = useOrders()
  const [dim, setDim] = useState('state')
  const [region, setRegion]   = useState('all')
  const [stateF, setStateF]   = useState('all')
  const [countyF, setCountyF] = useState('all')
  const DIMS = [
    { key:'state',   label:'By State' },
    { key:'county',  label:'By County' },
    { key:'region',  label:'By Region' },
    { key:'status',  label:'By Status' },
    { key:'type',    label:'By Search Type' },
    { key:'client',  label:'By Client' },
    { key:'payment', label:'By Payment Mode' },
  ]
  const keyFn = {
    state:   o => stateCode(o.state),
    county:  o => `${o.county}, ${stateCode(o.state)}`,
    region:  o => regionOf(o.state),
    status:  o => STATUS_MAP[o.status]?.label || o.status,
    type:    o => o.type,
    client:  o => displayClient(o, user),
    payment: o => o.payment,
  }[dim]

  // Geographic filters (cascading), applied before grouping.
  const inRegion = (o) => region === 'all' || regionOf(o.state) === region
  const statesAvail   = [...new Set(orders.filter(inRegion).map(o => stateCode(o.state)))].sort()
  const countiesAvail = [...new Set(orders
    .filter(o => inRegion(o) && (stateF === 'all' || stateCode(o.state) === stateCode(stateF)))
    .map(o => o.county))].sort()
  const pickRegion = (v) => { setRegion(v); setStateF('all'); setCountyF('all') }
  const pickState  = (v) => { setStateF(v); setCountyF('all') }
  const resetGeo   = () => { setRegion('all'); setStateF('all'); setCountyF('all') }
  const geoActive  = region !== 'all' || stateF !== 'all' || countyF !== 'all'

  const scoped = orders.filter(o =>
    (region === 'all'  || regionOf(o.state) === region) &&
    (stateF === 'all'  || stateCode(o.state) === stateCode(stateF)) &&
    (countyF === 'all' || o.county === countyF)
  )
  const counts = {}
  scoped.forEach(o => { const k = keyFn(o); counts[k] = (counts[k] || 0) + 1 })
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const max  = Math.max(...rows.map(r => r[1]), 1)

  const dimLabel = DIMS.find(d => d.key === dim)?.label || 'Group'
  const exportSummary = () => downloadCsv(`report-${dim}.csv`,
    [{ label: dimLabel, get: r => r[0] }, { label: 'Orders', get: r => r[1] }], rows)
  const btn = { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '8px 12px', borderRadius: 8,
    border: `1px solid ${Q.border}`, background: Q.card, color: Q.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', boxShadow: Q.shadow }

  const repSelect = {
    padding:'8px 10px', borderRadius:8, border:`1px solid ${Q.border}`,
    background:Q.card, color:Q.text, fontSize:13, fontWeight:500, outline:'none', cursor:'pointer',
    boxShadow:Q.shadow,
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold" style={{ color: Q.text }}>Reports</h1>
          <p className="text-sm" style={{ color: Q.muted }}>Order breakdown and monthly volume</p>
        </div>
        <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
          <button onClick={exportSummary} style={btn} title="Export the grouped summary as CSV">
            <Download style={{ width:14, height:14 }} /> Summary CSV
          </button>
          <span style={{ fontSize:13, color:Q.muted }}>Group by</span>
          <select value={dim} onChange={e => setDim(e.target.value)}
            style={{ ...repSelect, fontWeight:600 }}>
            {DIMS.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
      </div>

      {/* Geographic filter bar */}
      <div style={{ display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
        <Filter style={{ width:15, height:15, color:Q.faint }} />
        <select value={region} onChange={e => pickRegion(e.target.value)} style={repSelect} title="Region">
          <option value="all">All regions</option>
          {REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
        <select value={stateF} onChange={e => pickState(e.target.value)} style={repSelect} title="State">
          <option value="all">All states</option>
          {statesAvail.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select value={countyF} onChange={e => setCountyF(e.target.value)} style={repSelect} title="County">
          <option value="all">All counties</option>
          {countiesAvail.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        {geoActive && (
          <button onClick={resetGeo} style={{
            display:'flex', alignItems:'center', gap:5, padding:'7px 12px',
            background:'transparent', border:`1px solid ${Q.border}`, borderRadius:8,
            color:Q.muted, fontSize:13, fontWeight:500, cursor:'pointer',
          }}>
            <X style={{ width:13, height:13 }} /> Clear
          </button>
        )}
        <span style={{ fontSize:13, color:Q.faint, marginLeft:'auto' }}>
          {scoped.length} of {orders.length} orders
        </span>
      </div>

      <QCard className="p-5">
        <h2 className="text-sm font-semibold mb-4" style={{ color: Q.text }}>Monthly Order Volume</h2>
        <ResponsiveContainer width="100%" height={180}>
          <AreaChart data={MONTHLY_STATS}>
            <defs>
              <linearGradient id="rptGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={ROLE_COLOR} stopOpacity={0.22}/>
                <stop offset="95%" stopColor={ROLE_COLOR} stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="month" tick={{ fill:Q.faint, fontSize:11 }} axisLine={false} tickLine={false}/>
            <YAxis tick={{ fill:Q.faint, fontSize:11 }} axisLine={false} tickLine={false}/>
            <Tooltip contentStyle={{ background:'#fff', border:`1px solid ${Q.border}`, borderRadius:8, fontSize:12, boxShadow:Q.shadow }}/>
            <Area type="monotone" dataKey="orders"    stroke={ROLE_COLOR} fill="url(#rptGrad)" strokeWidth={2} name="Orders"/>
            <Area type="monotone" dataKey="delivered" stroke="#16a34a"    fill="none"          strokeWidth={2} strokeDasharray="4 4" name="Delivered"/>
          </AreaChart>
        </ResponsiveContainer>
      </QCard>

      <QCard className="p-5">
        <h2 className="text-sm font-semibold mb-4" style={{ color: Q.text }}>
          Orders {DIMS.find(d => d.key === dim).label}
          {geoActive && <span style={{ fontWeight:400, color:Q.faint }}> · filtered</span>}
        </h2>
        <div className="space-y-2.5">
          {rows.length === 0 && (
            <div style={{ fontSize:13, color:Q.faint, padding:'8px 0' }}>No orders match the current filters.</div>
          )}
          {rows.map(([label, count]) => (
            <div key={label} style={{ display:'flex', alignItems:'center', gap:12 }}>
              <div style={{ width:140, fontSize:13, color:Q.muted, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' }}>{label}</div>
              <div style={{ flex:1, height:22, background:Q.bg, borderRadius:6, overflow:'hidden' }}>
                <motion.div initial={{ width:0 }} animate={{ width:`${(count/max)*100}%` }}
                  transition={{ duration:0.6 }}
                  style={{ height:'100%', background:`${ROLE_COLOR}`, borderRadius:6, opacity:0.85 }} />
              </div>
              <div style={{ width:28, textAlign:'right', fontSize:13, fontWeight:700, color:Q.text }}>{count}</div>
            </div>
          ))}
        </div>
      </QCard>
    </div>
  )
}

// In-portal support inbox: client messages land here; Admin replies from here.
function AdminSupport() {
  const { user } = useAuth()
  const { threadList, sendMessage, awaitingReply } = useSupport()
  const threads = threadList()
  const [activeCode, setActiveCode] = useState(threads[0]?.clientCode || null)
  const [reply, setReply] = useState('')
  const active = threads.find(t => t.clientCode === activeCode) || null

  const send = () => {
    const text = reply.trim()
    if (!text || !active) return
    sendMessage({ clientCode: active.clientCode, clientName: active.clientName, from: 'support', text, author: user?.name || 'Support' })
    setReply('')
  }

  return (
    <div style={{ padding:'4px 2px' }}>
      <h1 style={{ fontSize:22, fontWeight:700, color:Q.text, marginBottom:4 }}>Support Inbox</h1>
      <p style={{ fontSize:13, color:Q.muted, marginBottom:18 }}>Messages clients send from their portal arrive here. Replies appear in their Support tab.</p>
      {threads.length === 0 ? (
        <div style={{ padding:'48px 0', textAlign:'center', color:Q.faint, fontSize:14 }}>
          No support messages yet.
        </div>
      ) : (
        <div style={{ display:'grid', gridTemplateColumns:'minmax(220px, 300px) 1fr', gap:16, alignItems:'start' }}>
          {/* Thread list */}
          <div style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:12, overflow:'hidden' }}>
            {threads.map(t => {
              const last = t.messages[t.messages.length - 1]
              const isActive = t.clientCode === activeCode
              return (
                <button key={t.clientCode} onClick={() => setActiveCode(t.clientCode)}
                  style={{ width:'100%', textAlign:'left', padding:'12px 14px', border:'none', cursor:'pointer',
                    borderBottom:`1px solid ${Q.border}`, background: isActive ? `${ROLE_COLOR}0f` : 'transparent' }}>
                  <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:8 }}>
                    <span style={{ fontSize:13, fontWeight:600, color:Q.text, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                      {displayClient(t, user)}
                    </span>
                    {awaitingReply(t) && <span style={{ width:8, height:8, borderRadius:99, background:'#dc2626', flexShrink:0 }} title="Awaiting reply" />}
                  </div>
                  <div style={{ fontSize:12, color:Q.faint, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', marginTop:2 }}>
                    {last ? `${last.from === 'support' ? 'You: ' : ''}${last.text}` : '—'}
                  </div>
                </button>
              )
            })}
          </div>

          {/* Conversation */}
          <div style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:12, display:'flex', flexDirection:'column', height:520 }}>
            {active ? (
              <>
                <div style={{ padding:'14px 16px', borderBottom:`1px solid ${Q.border}`, fontSize:14, fontWeight:600, color:Q.text }}>
                  {displayClient(active, user)}
                </div>
                <div style={{ flex:1, overflowY:'auto', padding:16, display:'flex', flexDirection:'column', gap:10 }}>
                  {active.messages.map((m, i) => (
                    <div key={m.id || i} style={{ display:'flex', justifyContent: m.from === 'support' ? 'flex-end' : 'flex-start' }}>
                      <div style={{ maxWidth:'75%', padding:'8px 12px', borderRadius:14, fontSize:13,
                        background: m.from === 'support' ? ROLE_COLOR : '#EDF0F5',
                        color: m.from === 'support' ? '#fff' : Q.text,
                        border: m.from === 'support' ? 'none' : `1px solid ${Q.border}` }}>
                        {m.text}
                        {m.time && <div style={{ fontSize:10.5, marginTop:3, color: m.from === 'support' ? 'rgba(255,255,255,0.75)' : Q.faint }}>
                          {m.author ? `${m.author} · ` : ''}{m.time}
                        </div>}
                      </div>
                    </div>
                  ))}
                </div>
                <div style={{ padding:12, borderTop:`1px solid ${Q.border}`, display:'flex', gap:8 }}>
                  <input value={reply} onChange={e => setReply(e.target.value)}
                    placeholder="Type a reply…"
                    style={{ flex:1, padding:'9px 12px', border:`1px solid ${Q.border}`, borderRadius:8, fontSize:13, outline:'none', color:Q.text }} />
                  <button onClick={send} style={{ padding:'9px 14px', background:ROLE_COLOR, border:'none', borderRadius:8, color:'#fff', cursor:'pointer', display:'flex', alignItems:'center', gap:6, fontSize:13, fontWeight:600 }}>
                    <Send style={{ width:15, height:15 }} /> Send
                  </button>
                </div>
              </>
            ) : (
              <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:Q.faint, fontSize:14 }}>
                Select a conversation
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AdminDashboard() {
  const { pendingCount } = useSupport()
  const { orders } = useOrders()
  const roster = useProfiles()
  const pending = pendingCount ? pendingCount() : 0
  // Every nav badge is live. Orders counts what still needs work (closed orders
  // aren't actionable), Users the real roster, Support the awaiting replies.
  const openOrders = orders.filter(o => o.status !== 'delivered' && o.status !== 'cancelled').length
  const badges = { '/admin/orders': openOrders, '/admin/users': roster.length, '/admin/support': pending }
  const navItems = NAV.map(n => (badges[n.path] ? { ...n, badge: badges[n.path] } : n))
  return (
    <Layout navItems={navItems} role="admin" roleColor={ROLE_COLOR} lightTheme>
      <Routes>
        <Route index            element={<AdminHome />} />
        <Route path="orders"     element={<AdminOrders />} />
        <Route path="place-order" element={<AdminPlaceOrder />} />
        <Route path="orders/:id" element={<AdminOrderPage />} />
        {/* Admin can open and fill the commitment itself, not just approve the
            generated PDF. Same screen the typer and the Single Seating desk use. */}
        <Route path="order/:id"  element={<FulfillmentScreen />} />
        <Route path="users"    element={<AdminUsers />} />
        <Route path="billing"  element={<AdminBilling />} />
        <Route path="support"  element={<AdminSupport />} />
        <Route path="map"      element={<AdminMap />} />
        <Route path="reports"  element={<AdminReports />} />
        <Route path="notifications" element={<NotificationSettings accent={ROLE_COLOR} />} />
        <Route path="settings" element={<AdminSettings />} />
      </Routes>
    </Layout>
  )
}
