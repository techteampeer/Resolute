import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { ChevronRight } from 'lucide-react'
import { displayClient } from '../data/mockData'

// Subtitle from whatever the order actually has. Email-ingested orders often
// arrive without county/state, and naively interpolating them renders a stray
// "Full Search · ," — so drop the empty parts instead.
export const orderSubtitle = (order) => {
  const place = [order.county && `${order.county} County`, order.state].filter(Boolean).join(', ')
  return [order.type, place, order.eta && `ETA ${order.eta}`].filter(Boolean).join(' · ')
}

// Shared full-page order detail shell for every portal.
//
// Replaces the old per-portal modal popups: clicking an order navigates to a
// real route, so the view is linkable, back-button friendly, and has room to
// breathe. Each portal supplies its own tabs — `tabs` is
// [{ key, label, icon, badge?, render: () => JSX }] — and the role accent
// colour; everything else (back nav, header, tab strip) is common.
export default function OrderDetailLayout({
  order, user, accent, backTo, backLabel = 'Back', tabs, initialTab, statusPill, headline,
}) {
  const navigate = useNavigate()
  const [tab, setTab] = useState(initialTab || tabs[0]?.key)
  const active = tabs.find(t => t.key === tab) || tabs[0]

  return (
    <div className="max-w-4xl mx-auto space-y-5">
      {/* Back */}
      <button onClick={() => navigate(backTo)}
        className="flex items-center gap-1.5 text-sm"
        style={{ color: '#5C6E8C', background: 'none', border: 'none', padding: 0, cursor: 'pointer' }}>
        <ChevronRight className="w-4 h-4" style={{ transform: 'rotate(180deg)' }} /> {backLabel}
      </button>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="font-mono font-semibold text-sm" style={{ color: accent }}>{order.id}</div>
          <div className="font-bold text-xl truncate" style={{ color: '#12284C' }}>
            {headline || displayClient(order.client, user)}
          </div>
          <div className="text-xs" style={{ color: '#5C6E8C' }}>{orderSubtitle(order)}</div>
        </div>
        <div className="flex items-center gap-2">
          {order.priority === 'rush' && (
            <span className="text-[11px] font-bold px-2.5 py-1 rounded-full"
              style={{ background: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>RUSH</span>
          )}
          {statusPill}
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex items-center gap-1 border-b overflow-x-auto" style={{ borderColor: 'rgba(18,40,76,0.10)' }}>
        {tabs.map(t => {
          const on = t.key === tab
          return (
            <button key={t.key} onClick={() => setTab(t.key)}
              className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold transition-colors shrink-0 whitespace-nowrap"
              style={{ color: on ? accent : '#5C6E8C', borderBottom: `2px solid ${on ? accent : 'transparent'}`,
                marginBottom: -1, background: 'none', cursor: 'pointer' }}>
              {t.icon && <t.icon className="w-4 h-4" />} {t.label}
              {t.badge ? (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full"
                  style={{ background: `${accent}1a`, color: accent }}>{t.badge}</span>
              ) : null}
            </button>
          )
        })}
      </div>

      {/* Body */}
      <motion.div key={tab} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.16 }}>
        {active?.render()}
      </motion.div>
    </div>
  )
}

// Small shared pieces so the per-portal pages stay declarative.
export const DetailGrid = ({ items }) => (
  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
    {items.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
      <div key={k} className="glass p-3 rounded-xl">
        <div className="text-xs mb-1" style={{ color: '#5C6E8C' }}>{k}</div>
        <div className="font-medium text-sm" style={{ color: '#12284C' }}>{v}</div>
      </div>
    ))}
  </div>
)

export const Panel = ({ title, hint, children }) => (
  <div className="glass-card p-4 space-y-3">
    {title && (
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: '#5C6E8C' }}>{title}</div>
        {hint && <div className="text-[11px] mt-0.5" style={{ color: '#9AA8BF' }}>{hint}</div>}
      </div>
    )}
    {children}
  </div>
)

// The order's own slice of the activity feed, rendered the same way everywhere.
export const ActivityTab = ({ order, activityLog = [], accent }) => {
  const entries = activityLog.filter(a =>
    a.orderId === order.id || (String(a.action || '').match(/RTS-\d+/)?.[0] === order.id))
  if (!entries.length) return <div className="text-sm" style={{ color: '#9AA8BF' }}>No activity recorded on this order yet.</div>
  return (
    <div className="space-y-2">
      {entries.map((a, i) => (
        <div key={a.id || i} className="flex gap-3 p-3 rounded-xl"
          style={{ background: 'rgba(18,40,76,0.03)', border: '1px solid rgba(18,40,76,0.06)' }}>
          <div className="w-1.5 rounded-full shrink-0" style={{ background: accent, opacity: 0.5 }} />
          <div className="min-w-0">
            <div className="text-[13px]" style={{ color: '#12284C' }}>{a.action}</div>
            <div className="text-[11px]" style={{ color: '#9AA8BF' }}>{a.time || a.at || ''}{a.actor ? ` · ${a.actor}` : ''}</div>
          </div>
        </div>
      ))}
    </div>
  )
}
