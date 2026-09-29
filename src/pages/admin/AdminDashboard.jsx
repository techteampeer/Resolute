import React, { useState, useEffect, useMemo } from 'react'
import { Routes, Route, useNavigate, useParams } from 'react-router-dom'
import { motion } from 'framer-motion'
import Layout from '../../components/Layout'
import USAMap from '../../components/USAMap'
import AssignModal from '../../components/AssignModal'
import { useClients, clientNameOf } from '../../lib/useClients'
import NotificationSettings from '../../components/NotificationSettings'
import {
  LayoutDashboard, ClipboardList, Users, BarChart3, Settings, MapPin,
  Package, CheckCircle, Clock, Search, Plus, Filter, Eye, DollarSign,
  ChevronDown, ChevronUp, FileText, ArrowUpRight, X, Lock, ShieldCheck, UserPlus, Download,
  MessageSquare, Send, StickyNote, Bell,
} from 'lucide-react'
import AdminBilling from './AdminBilling'
import { downloadCsv } from '../../lib/exportCsv'
import { openDocument } from '../../lib/backend'
import { supabase, isSupabaseConfigured } from '../../lib/supabase'
import { useProfiles, namesForRole } from '../../lib/useProfiles'
import { PRODUCT_PRICE } from '../../data/products'
import { money } from '../../lib/billing'
import { ROLE_COLOR, density } from '../../lib/ui'
import FulfillmentScreen from '../typer/fulfillment/FulfillmentScreen'
import AttachedDocs from '../../components/AttachedDocs'
import { orderSubtitle } from '../../components/OrderDetailLayout'
import OrderThread from '../../components/OrderThread'
import {
  USERS, MONTHLY_STATS, PAYMENT_METHODS,
  STAGE_KEYS, STAGE_LABELS, displayClient, clientByName, clientCode, stateCode,
  REGIONS, regionOf, nextRoleFor, statusForRole,
} from '../../data/mockData'
import { useAuth } from '../../context/AuthContext'
import { useOrders } from '../../context/OrderContext'
import { useSupport } from '../../context/SupportContext'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'

// Staff names per pipeline role, from the real profiles table (see useProfiles).
// This was built from mockData's USERS fixture, which offers six people who have
// no profiles row and no login, so an order could be assigned to someone who does
// not exist.
// Post-D3 (ADR 0001) the stage login roles are retired: every production staffer
// is a single `user`, so each pipeline stage draws its people from the one
// production pool. The keys stay per-stage — they name who worked each stage on
// the order (order.screener / .examiner / …) — but they all resolve to `user`s.
const teamFrom = (profiles) => {
  const pool = namesForRole(profiles, 'user')
  return { screener: pool, examiner: pool, typer: pool, delivery: pool }
}

const ROLE_HOVER  = '#1B34C4'

const NAV = [
  { path: '/admin',          label: 'Dashboard',    icon: LayoutDashboard },
  { path: '/admin/orders',   label: 'Orders',       icon: ClipboardList },
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

const STATUS_MAP = {
  received:  { label:'Received',  color:'#12284C', bg:'#EDF0F5' },
  screening: { label:'Screening', color:'#1B3A8C', bg:'#EAEEF8' },
  searching: { label:'Searching', color:'#2441E5', bg:'#EEF1FE' },
  examining: { label:'Examining', color:'#2441E5', bg:'#EEF1FE' },
  typing:    { label:'Typing',    color:'#1268A8', bg:'#E8F4FB' },
  delivery:  { label:'Out for Delivery', color:'#0E7C90', bg:'#E4F7FB' },
  delivered: { label:'Delivered', color:'#15803d', bg:'#f0fdf4' },
  cancelled: { label:'Cancelled', color:'#dc2626', bg:'#fef2f2' },
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
  { key:'examiner', label:'Examiner' },
  { key:'typer',    label:'Typer' },
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
  const [form, setForm] = useState({
    screener: order.screener, examiner: order.examiner, typer: order.typer,
    delivery: order.delivery, payment: order.payment, status: order.status,
    assignedTo: order.assignedTo || '',
  })
  // Status is derived from the owning role; changing the owner therefore moves
  // the status with it, so the two can't silently drift. Status stays editable
  // afterwards for a deliberate correction.
  const STAGES = ['screener', 'examiner', 'typer', 'delivery']
  const TEAM = teamFrom(useProfiles())
  const set = (k, v) => setForm(f => {
    if (k !== 'assignedTo') return { ...f, [k]: v }
    const derived = statusForRole(STAGES.includes(v) ? v : nextRoleFor(order))
    return { ...f, assignedTo: v, status: v ? derived : f.status }
  })
  const save = () => {
    const completed = form.status === 'delivered'
      ? (order.completed || order.eta)
      : null
    const assignedTo = form.assignedTo || null
    // Mirror assignOrder: routing to the production (`user`) desk claims the
    // order end-to-end. Post-D3 that is the only production owner; Admin and
    // Unassigned leave the workflow untouched.
    const workflow = assignedTo === 'user'
      ? { ...order.workflow, singleSeating: true }
      : order.workflow
    // Keep the per-person owner (A1/A2) consistent with the queue: an order that
    // leaves the `user` pool has no owner. Assigning a specific person is done in
    // the Assign modal (a picker); this editor only clears a stale owner.
    const assignedUserId = assignedTo === 'user' ? (order.assignedUserId ?? null) : null
    onSave({ ...order, ...form, assignedTo, assignedUserId, workflow, completed })
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
  const toggleHold = () => {
    const on = !onHold
    const reason = on ? (window.prompt('Reason for holding this order (optional):', '') ?? null) : null
    updateOrder({ ...order, workflow: { ...order.workflow, onHold: on, holdReason: on ? (reason || null) : null } })
    notify(on ? `Your order was placed on hold${reason ? `: ${reason}` : ''}.` : 'Your order has resumed.')
    // Neither hold nor resume was recorded in the audit trail, so an order could
    // sit paused for days with nothing in its history explaining why.
    logAction({
      orderId: order.id, actor: user?.name || 'Admin',
      action: on
        ? `${user?.name || 'Admin'} put ${order.id} on hold${reason ? ` — ${reason}` : ''}`
        : `${user?.name || 'Admin'} resumed ${order.id}`,
    })
    onClose()
  }
  const requestClarification = () => {
    const note = window.prompt('What clarification do you need from the client?', '')
    if (note == null) return
    updateOrder({ ...order, clarification: 'pending' })
    notify(`Clarification needed: ${note}`)
    logAction({
      orderId: order.id, actor: user?.name || 'Admin',
      action: `${user?.name || 'Admin'} requested clarification from the client on ${order.id}${note ? ` — ${note}` : ''}`,
    })
    onClose()
  }
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
                  <Detail label="Property" value={intake.propertyAddress} wide />
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
                {intake.specialInstructions && (
                  <div style={{ marginTop:10 }}>
                    <div style={{ fontSize:11, color:Q.faint, marginBottom:2 }}>Special instructions</div>
                    <div style={{ fontSize:13, color:Q.text, whiteSpace:'pre-wrap' }}>{intake.specialInstructions}</div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Assignment — drives the Assigned/Unassigned state */}
          <div style={{ padding:'16px 22px 0' }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
              <Field label="Assigned To (current owner)">
                <select style={selectStyle} value={form.assignedTo} onChange={e => set('assignedTo', e.target.value)}>
                  <option value="">Unassigned</option>
                  <option value="admin">Admin (awaiting approval)</option>
                  <option value="user">Production Desk</option>
                </select>
              </Field>
              <Field label="Status">
                <select style={selectStyle} value={form.status} onChange={e => set('status', e.target.value)}>
                  {STAGE_KEYS.map((k, i) => <option key={k} value={k}>{STAGE_LABELS[i]}</option>)}
                </select>
              </Field>
            </div>
          </div>

          <div style={{ padding:'14px 22px', display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
            <Field label="Screener">
              <select style={selectStyle} value={form.screener} onChange={e => set('screener', e.target.value)}>
                {TEAM.screener.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Examiner">
              <select style={selectStyle} value={form.examiner} onChange={e => set('examiner', e.target.value)}>
                {TEAM.examiner.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Typer">
              <select style={selectStyle} value={form.typer} onChange={e => set('typer', e.target.value)}>
                {TEAM.typer.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Delivery">
              <select style={selectStyle} value={form.delivery} onChange={e => set('delivery', e.target.value)}>
                {TEAM.delivery.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </Field>
            <Field label="Mode of Payment">
              <select style={selectStyle} value={form.payment} onChange={e => set('payment', e.target.value)}>
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
              {!confirmed && (
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

// Most recent non-null per-stage completion date, for the Completed column.
const lastCompleted = (o) => {
  const dates = Object.values(o.completedDates || {}).filter(Boolean)
  return dates.length ? dates.sort().slice(-1)[0] : null
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
function NewOrderModal({ onClose }) {
  const { createOrder } = useOrders()
  // Every client in the registry, not the seven in the fixture — Admin could not
  // place an order for a newly onboarded client, including the pilot.
  const clients = useClients()
  // Keyed on the client CODE, not the name. The name is PII a plain admin may
  // not read (20260909120000), so an option labelled by name would be blank for
  // them — and the old code derived client_code by looking the NAME up in
  // mockData, which returned nothing for any client added since, saving the
  // order with no client link at all.
  const [f, setF] = useState({ clientCode: '', state: '', county: '', type: 'Full Search', priority: 'normal', eta: '' })
  const [busy, setBusy] = useState(false)
  const set = (k, v) => setF(p => ({ ...p, [k]: v }))
  const ready = f.clientCode && f.state && f.county
  const submit = async () => {
    if (!ready || busy) return
    setBusy(true)
    try {
      await createOrder({
        client: clientNameOf(clients, f.clientCode) || f.clientCode,
        clientCode: f.clientCode,
        state: f.state.toUpperCase(), county: f.county, type: f.type,
        priority: f.priority, eta: f.eta || '',
        intake: { source: 'admin', propertyAddress: '', orderType: f.type },
      })
      onClose()
    } finally { setBusy(false) }
  }
  const field = { width:'100%', padding:'8px 11px', borderRadius:8, border:`1px solid ${Q.border}`,
    background:Q.card, color:Q.text, fontSize:13, outline:'none' }
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background:'rgba(12,29,56,0.45)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()}
        style={{ background:Q.card, borderRadius:12, width:'100%', maxWidth:460, padding:'20px 22px' }}>
        <div style={{ fontSize:17, fontWeight:700, color:Q.text, marginBottom:4 }}>New Order</div>
        <div style={{ fontSize:12.5, color:Q.muted, marginBottom:16 }}>
          Placed on behalf of a client. It parks in your queue for routing.
        </div>
        <div style={{ display:'grid', gap:10 }}>
          <div>
            <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>CLIENT</div>
            <select value={f.clientCode} onChange={e => set('clientCode', e.target.value)} style={field}>
              <option value="">{clients.length ? 'Select a client…' : 'Loading clients…'}</option>
              {clients.map(c => (
                <option key={c.code} value={c.code}>{c.name ? `${c.code} · ${c.name}` : c.code}</option>
              ))}
            </select>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>STATE</div>
              <input value={f.state} onChange={e => set('state', e.target.value)} placeholder="FL" maxLength={2} style={field} />
            </div>
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>COUNTY</div>
              <input value={f.county} onChange={e => set('county', e.target.value)} placeholder="Miami-Dade" style={field} />
            </div>
          </div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>SEARCH TYPE</div>
              <select value={f.type} onChange={e => set('type', e.target.value)} style={field}>
                {['Full Search','Current Owner','Two-Owner','Lien Search','Tax Certificate','HOA Estoppel']
                  .map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>PRIORITY</div>
              <select value={f.priority} onChange={e => set('priority', e.target.value)} style={field}>
                <option value="normal">Normal</option><option value="rush">Rush</option>
              </select>
            </div>
          </div>
          <div>
            <div style={{ fontSize:11, fontWeight:600, color:Q.muted, marginBottom:4 }}>ETA <span style={{ fontWeight:400 }}>(optional)</span></div>
            <input type="date" value={f.eta} onChange={e => set('eta', e.target.value)} style={field} />
          </div>
        </div>
        <div style={{ display:'flex', gap:8, marginTop:18 }}>
          <button onClick={submit} disabled={!ready || busy}
            style={{ flex:1, padding:'9px 14px', borderRadius:8, border:'none', fontSize:13, fontWeight:600,
              background: ready && !busy ? ROLE_COLOR : Q.border, color: ready && !busy ? '#fff' : Q.faint,
              cursor: ready && !busy ? 'pointer' : 'not-allowed' }}>
            {busy ? 'Creating…' : 'Create Order'}
          </button>
          <button onClick={onClose}
            style={{ padding:'9px 16px', borderRadius:8, border:`1px solid ${Q.border}`, background:Q.bg,
              color:Q.muted, fontSize:13, fontWeight:600, cursor:'pointer' }}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// A small pill for a workload status (busiest / available).
const wlChip = (fg, bg) => ({
  fontSize: 9.5, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase',
  color: fg, background: bg, padding: '2px 6px', borderRadius: 5,
})
const wlInitials = (n = '') =>
  n.trim().split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('') || '?'

// A5 — Team Workload. Visualizes each production user's live active-order count
// so Admin can spot who's overloaded vs idle and rebalance: expand a person to
// see their orders and Reassign one (reuses the AssignModal person picker, which
// on an already-owned order routes through reassign()).
function TeamWorkload() {
  const { orders } = useOrders()
  const { user } = useAuth()
  const profiles = useProfiles()
  const [assigning, setAssigning] = useState(null)
  const [openId, setOpenId] = useState(null)

  const isClosed = (o) => o.status === 'delivered' || o.status === 'cancelled'
  const team = profiles
    .filter(p => p.role === 'user' && (p.status || 'active') === 'active')
    .map(p => ({ ...p, active: orders.filter(o => o.assignedUserId === p.id && !isClosed(o)) }))
    .sort((a, b) => b.active.length - a.active.length)   // busiest first
  const maxLoad = Math.max(1, ...team.map(t => t.active.length))
  const busiest = team.length ? team[0].active.length : 0

  return (
    <QCard className="p-5">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-sm font-semibold" style={{ color: Q.text }}>Team Workload</h2>
        <span style={{ fontSize: 11, color: Q.faint }}>active orders per person · click to reassign and balance</span>
      </div>
      <div className="mt-3" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {team.length === 0 && <p style={{ fontSize: 13, color: Q.muted }}>Loading the team…</p>}
        {team.map(p => {
          const load = p.active.length
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
      {assigning && <AssignModal order={assigning} user={user} onClose={() => setAssigning(null)} />}
    </QCard>
  )
}

function OrdersPipeline({ pageSize = 6, scrollable = false }) {
  const { user } = useAuth()
  const { orders } = useOrders()
  const navigate = useNavigate()
  const [assigning, setAssigning] = useState(null)  // focused assign modal
  const [search, setSearch]     = useState('')
  const [activeTab, setActiveTab] = useState('all')   // lifecycle tab
  const [newOrder, setNewOrder]   = useState(false)
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

  // Lifecycle status (Qualia-style) derived from our pipeline + routing state.
  const lifecycleOf = (o) => {
    if (o.status === 'cancelled') return 'cancelled'
    if (o.status === 'delivered') return 'complete'
    // Parked with Admin (between stages, or never routed) — Admin's own queue.
    if (o.assignedTo === 'admin' || o.assignedTo == null) return 'awaiting'
    return 'open'
  }
  const tabs = [
    { key: 'all',       label: 'All' },
    { key: 'awaiting',  label: 'Awaiting Approval' },
    { key: 'open',      label: 'In Progress' },
    { key: 'complete',  label: 'Complete' },
    { key: 'cancelled', label: 'Cancelled' },
  ].map(t => ({ ...t, count: t.key === 'all' ? orders.length : orders.filter(o => lifecycleOf(o) === t.key).length }))

  const DATE_RANGES = [
    { key: '30',  label: 'Last 30 Days' },
    { key: '90',  label: 'Last 3 Months' },
    { key: '365', label: 'Last 12 Months' },
    { key: 'all', label: 'All Time' },
  ]
  const cutoff = dateRange === 'all' ? null
    : new Date(Date.now() - Number(dateRange) * 24 * 60 * 60 * 1000)

  const filtered = orders.filter(o => {
    const q = search.toLowerCase()
    // Include the client's own file number: it is the reference they quote on
    // the phone and in email subjects, so it has to be searchable here.
    const matchSearch = !q || displayClient(o, user).toLowerCase().includes(q)
      || o.id.toLowerCase().includes(q)
      || (o.clientFileNo || '').toLowerCase().includes(q)
    const matchTab    = activeTab === 'all' || lifecycleOf(o) === activeTab
    const matchRegion = region === 'all'  || regionOf(o.state) === region
    const matchState  = stateF === 'all'  || stateCode(o.state) === stateCode(stateF)
    const matchCounty = countyF === 'all' || o.county === countyF
    const matchRush   = !rushOnly || o.priority === 'rush'
    const matchDate   = !cutoff || new Date(o.created) >= cutoff
    return matchSearch && matchTab && matchRegion && matchState && matchCounty && matchRush && matchDate
  })

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage   = Math.min(page, totalPages)
  const paged      = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE)
  // Reset to first page whenever the filter set changes.
  useEffect(() => { setPage(1) }, [activeTab, search, region, stateF, countyF, dateRange, rushOnly])

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
      {assigning && <AssignModal order={assigning} user={user} onClose={() => setAssigning(null)} />}
      {newOrder && <NewOrderModal onClose={() => setNewOrder(false)} />}
      {/* Toolbar — row 1: search · date range · new order */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative" style={{ flex:'1 1 260px', minWidth: 240 }}>
          <Search style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', width:15, height:15, color:Q.faint }} />
          <input
            value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by client or file #..."
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
        <button onClick={() => setNewOrder(true)}
          style={{ ...ctlBtn, background:ROLE_COLOR, border:'none', color:'#fff' }}
          onMouseOver={e => e.currentTarget.style.background = ROLE_HOVER}
          onMouseOut={e => e.currentTarget.style.background = ROLE_COLOR}>
          <Plus style={{ width:15, height:15 }} /> New Order
        </button>
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
        <table style={{ width:'100%', borderCollapse:'collapse', fontSize:density.bodySize, lineHeight:density.lineHeight, minWidth:920 }}>
          <thead>
            <tr style={{ background:'#F9FBFD', borderBottom:`1px solid ${Q.border}` }}>
              {['Order','Client File #','Client','Location','Type','Status','Payment','Assignee','Completed','ETA / Done',''].map(h => (
                <th key={h} style={{
                  padding:CELL_PAD, textAlign:'left', fontSize:density.headSize,
                  fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em',
                  color:Q.faint, whiteSpace:'nowrap',
                  ...(scrollable ? { position:'sticky', top:0, background:'#F9FBFD', zIndex:1 } : {}),
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((o, i) => {
              const s = awaitingApproval(o)
                ? { label: 'Awaiting Approval', bg: '#fffbeb', color: '#b45309' }
                : (STATUS_MAP[o.status] || STATUS_MAP.received)
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
                  <td style={{ padding:CELL_PAD, fontFamily:'monospace', fontSize:11.5, color:Q.muted, whiteSpace:'nowrap' }}>{o.clientFileNo || '—'}</td>
                  <td style={{ padding:CELL_PAD, fontWeight:500, color:Q.text, whiteSpace:'nowrap' }}>{displayClient(o, user)}</td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, whiteSpace:'nowrap' }}>{o.county}, {o.state}</td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, whiteSpace:'nowrap', fontSize:12 }}>{o.type}</td>
                  <td style={{ padding:CELL_PAD, whiteSpace:'nowrap' }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                      <span style={{
                        padding:'3px 10px', borderRadius:99, fontSize:12, fontWeight:600,
                        background:s.bg, color:s.color,
                      }}>{s.label}</span>
                      {r.kind === 'new' && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#EEF1FE', color:'#2441E5', border:'1px solid #C6CFFA' }}>New</span>
                      )}
                      {r.kind === 'ready' && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#fffbeb', color:'#d97706', border:'1px solid #fde68a' }}>
                          Ready · {cap(r.next)} next
                        </span>
                      )}
                      {r.kind === 'inprogress' && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#f0fdf4', color:'#16a34a', border:'1px solid #bbf7d0' }}>Assigned</span>
                      )}
                      {!o.workflow?.confirmed && o.status === 'received' && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#EEF1FE', color:'#2441E5', border:'1px solid #C6CFFA' }}>Awaiting confirm</span>
                      )}
                      {o.workflow?.onHold && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#fffbeb', color:'#a16207', border:'1px solid #fde68a' }}>On Hold</span>
                      )}
                      {o.clarification === 'pending' && (
                        <span style={{ padding:'3px 9px', borderRadius:99, fontSize:11, fontWeight:700,
                          background:'#fef2f2', color:'#dc2626', border:'1px solid #fecaca' }}>Clarification</span>
                      )}
                    </div>
                  </td>
                  <td style={{ padding:CELL_PAD, color:Q.muted, fontSize:12, whiteSpace:'nowrap' }}>{o.payment}</td>
                  <td style={{ padding:CELL_PAD, fontSize:12, whiteSpace:'nowrap',
                    color: o.assignedTo ? Q.text : Q.faint, textTransform:'capitalize' }}>
                    {o.assignedTo
                      ? `${o.assignedTo === 'user' ? 'production' : o.assignedTo}${o[o.assignedTo] ? ` · ${o[o.assignedTo]}` : ''}`
                      : '—'}
                  </td>
                  <td style={{ padding:CELL_PAD, fontSize:12, whiteSpace:'nowrap',
                    color: lastCompleted(o) ? '#16a34a' : Q.faint }}>
                    {lastCompleted(o) || '—'}
                  </td>
                  <td style={{ padding:CELL_PAD, fontSize:12, whiteSpace:'nowrap',
                    color: o.completed ? '#16a34a' : Q.faint }}>
                    {o.completed ? `Done ${o.completed}` : o.eta}
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
                          <UserPlus style={{ width:13, height:13 }} />
                          {r.kind === 'inprogress' ? 'Reassign'
                            : r.kind === 'ready' ? `Approve & Assign ${cap(r.next)}`
                            : `Assign ${cap(r.next)}`}
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
                  <p style={{ fontSize:12, lineHeight:'1.5', color:Q.muted }}>{a.action}</p>
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

async function usersApi(method, body) {
  const { data: { session } = {} } = await supabase.auth.getSession()
  const res = await fetch('/api/admin/users', {
    method,
    headers: { 'content-type': 'application/json', ...(session ? { authorization: `Bearer ${session.access_token}` } : {}) },
    body: method === 'POST' ? JSON.stringify(body) : undefined,
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(j.error || `Request failed (HTTP ${res.status})`)
  return j
}

function UserFormModal({ initial, onClose, onSave, busy }) {
  const isEdit = !!initial?.id
  const [f, setF] = useState({ name: initial?.name || '', email: initial?.email || '', role: initial?.role || 'client', clientCode: initial?.clientCode || '' })
  const set = (k, v) => setF(s => ({ ...s, [k]: v }))
  const inputStyle = { width: '100%', padding: '9px 12px', border: `1px solid ${Q.border}`, borderRadius: 8, fontSize: 13, outline: 'none', color: Q.text, background: '#fff' }
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, background: 'rgba(12,29,56,0.45)' }} onClick={onClose}>
      <div onClick={e => e.stopPropagation()} style={{ background: Q.card, borderRadius: 12, width: '100%', maxWidth: 420, padding: 22 }}>
        <div style={{ fontSize: 16, fontWeight: 700, color: Q.text, marginBottom: 14 }}>{isEdit ? 'Edit user' : 'Invite / add user'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: Q.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Name</label>
            <input value={f.name} onChange={e => set('name', e.target.value)} style={inputStyle} placeholder="Full name" />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: Q.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Email</label>
            <input value={f.email} onChange={e => set('email', e.target.value)} disabled={isEdit} style={{ ...inputStyle, opacity: isEdit ? 0.6 : 1 }} placeholder="user@company.com" />
          </div>
          <div>
            <label style={{ fontSize: 11, fontWeight: 600, color: Q.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Role</label>
            <select value={f.role} onChange={e => set('role', e.target.value)} style={inputStyle}>
              {USER_ROLES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          {f.role === 'client' && (
            <div>
              <label style={{ fontSize: 11, fontWeight: 600, color: Q.faint, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Client code</label>
              <input value={f.clientCode} onChange={e => set('clientCode', e.target.value.toUpperCase())} style={inputStyle} placeholder="e.g. CL08" />
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
          <button disabled={busy || !f.email || !f.role} onClick={() => onSave(f)}
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

  const run = async (fn) => { setErr(''); setBusy(true); try { await fn(); load() } catch (e) { setErr(e.message) } finally { setBusy(false) } }
  const toggleActive = (u) => run(() => usersApi('POST', { action: 'setActive', id: u.id, active: !u.active }))
  const remove = (u) => { if (window.confirm(`Remove ${u.name || u.email}? This permanently deletes their account.`)) run(() => usersApi('POST', { action: 'remove', id: u.id })) }
  const reset = (u) => run(async () => { const j = await usersApi('POST', { action: 'resetPassword', email: u.email }); setNotice(`Password reset link for ${u.email}:\n\n${j.link || '(recovery email sent)'}`) })
  const save = (form) => run(async () => {
    if (form.id) await usersApi('POST', { action: 'update', id: form.id, name: form.name, role: form.role, clientCode: form.clientCode })
    else { const j = await usersApi('POST', { action: 'create', email: form.email, name: form.name, role: form.role, clientCode: form.clientCode }); setNotice(`User created. Temporary password for ${form.email}:\n\n${j.tempPassword}\n\nShare it securely; they can change it via a password reset.`) }
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
                        <span style={{ fontWeight: 500, color: Q.text }}>{u.name || '—'}{u.superAdmin && <span style={{ marginLeft: 6, fontSize: 10, fontWeight: 700, color: '#b45309' }}>SUPER</span>}</span>
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
                          {btn('Edit', () => setEditing({ id: u.id, name: u.name, email: u.email, role: u.role, clientCode: u.clientCode }), 'accent')}
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

      {editing && <UserFormModal initial={editing} busy={busy} onClose={() => setEditing(null)} onSave={save} />}
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
        <Route path="settings" element={
          <div style={{ padding:48, textAlign:'center', color:Q.faint, fontSize:14 }}>
            Nothing here yet. Email notification preferences live under <b>Notifications</b>.
          </div>
        } />
      </Routes>
    </Layout>
  )
}
