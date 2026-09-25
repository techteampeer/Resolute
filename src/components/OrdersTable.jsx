import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Search, MoreHorizontal } from 'lucide-react'
import { displayClient } from '../data/mockData'
import { useAuth } from '../context/AuthContext'

const STEP_LABELS = ['Received','Screening','Searching','Examining','Typing','Delivered']
const STEP_KEYS   = ['received','screening','searching','examining','typing','delivered']

function ProgressBar({ status, progress }) {
  const idx = STEP_KEYS.indexOf(status)
  return (
    <div>
      <div className="flex gap-0.5 mb-1">
        {STEP_KEYS.map((s, i) => (
          <div key={s} className="h-1 flex-1 rounded-full transition-all duration-500"
            style={{
              background: i < idx
                ? '#1B34C4'
                : i === idx
                ? '#2441E5'
                : 'rgba(18,40,76,0.10)',
            }} />
        ))}
      </div>
      <div className="flex justify-between">
        <span className="text-xs" style={{ color: '#5C6E8C' }}>
          {STEP_LABELS[idx] || '—'}
        </span>
        <span className="text-xs" style={{ color: '#5C6E8C' }}>{progress}%</span>
      </div>
    </div>
  )
}

const STATUS_STYLES = {
  received:  { bg: 'rgba(18,40,76,0.12)',    text: '#12284C', dot: '#12284C' },
  screening: { bg: 'rgba(27,58,140,0.14)',   text: '#1B3A8C', dot: '#1B3A8C' },
  searching: { bg: 'rgba(36,65,229,0.18)', text: '#2441E5', dot: '#2441E5' },
  examining: { bg: 'rgba(36,65,229,0.14)',   text: '#2441E5', dot: '#2441E5' },
  typing:    { bg: 'rgba(18,104,168,0.14)',  text: '#1268A8', dot: '#1268A8' },
  delivered: { bg: 'rgba(80,180,100,0.18)',  text: '#15803d', dot: '#15803d' },
  onhold:    { bg: 'rgba(220,80,80,0.18)',   text: '#e07878', dot: '#e07878' },
}

export default function OrdersTable({ orders, showAssignees = false, onOrderClick }) {
  const { user } = useAuth()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')

  const filtered = orders.filter(o => {
    const s = search.toLowerCase()
    const matchSearch = !s || o.id.toLowerCase().includes(s) ||
      displayClient(o.client, user, o.clientCode).toLowerCase().includes(s) || o.state.toLowerCase().includes(s)
    const matchFilter = filter === 'all' || o.status === filter
    return matchSearch && matchFilter
  })

  return (
    <div>
      {/* Controls */}
      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: '#5C6E8C' }} />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search orders…" className="input-field pl-9 py-2 text-sm" />
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          {['all','received','screening','searching','examining','typing','delivered'].map(s => (
            <button key={s} onClick={() => setFilter(s)}
              className="px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 capitalize"
              style={{
                background: filter === s ? '#2441E5' : 'rgba(18,40,76,0.05)',
                color:      filter === s ? '#12284C' : '#5C6E8C',
                border:     filter === s ? '1px solid rgba(36,65,229,0.35)' : '1px solid rgba(18,40,76,0.08)',
              }}>
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl" style={{ border: '1px solid rgba(36,65,229,0.10)' }}>
        <table className="w-full min-w-[900px] text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(36,65,229,0.09)' }}>
              {['Order ID','Client','Location','Type','Status','Progress',
                ...(showAssignees ? ['Assigned'] : []), 'Priority',''].map(h => (
                <th key={h} className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider whitespace-nowrap"
                  style={{ color: '#5C6E8C' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((order, i) => {
              const sc = STATUS_STYLES[order.status] || STATUS_STYLES.received
              return (
                <motion.tr key={order.id}
                  initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.03 }}
                  className="cursor-pointer transition-colors"
                  style={{ borderBottom: '1px solid rgba(36,65,229,0.06)' }}
                  onMouseOver={e => e.currentTarget.style.background = 'rgba(18,40,76,0.03)'}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => onOrderClick?.(order)}>
                  <td className="px-4 py-3 font-mono font-semibold whitespace-nowrap" style={{ color: '#2441E5' }}>
                    {order.id}
                  </td>
                  <td className="px-4 py-3 font-medium whitespace-nowrap" style={{ color: '#12284C' }}>
                    {displayClient(order.client, user, order.clientCode)}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'rgba(18,40,76,0.52)' }}>
                    {order.state} · {order.county}
                  </td>
                  <td className="px-4 py-3 whitespace-nowrap" style={{ color: 'rgba(18,40,76,0.52)' }}>
                    {order.type}
                  </td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold"
                      style={{ background: sc.bg, color: sc.text }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: sc.dot }} />
                      {order.status.charAt(0).toUpperCase() + order.status.slice(1)}
                    </span>
                  </td>
                  <td className="px-4 py-3 min-w-[140px]">
                    <ProgressBar status={order.status} progress={order.progress} />
                  </td>
                  {showAssignees && (
                    <td className="px-4 py-3 text-xs whitespace-nowrap" style={{ color: '#5C6E8C' }}>
                      {order.screener}
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <span className="text-xs font-semibold px-2 py-0.5 rounded-md"
                      style={order.priority === 'rush'
                        ? { background: 'rgba(220,80,60,0.18)', color: '#dc2626' }
                        : { background: 'rgba(18,40,76,0.07)', color: '#5C6E8C' }}>
                      {order.priority.toUpperCase()}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <button className="transition-colors" style={{ color: 'rgba(18,40,76,0.18)' }}
                      onMouseOver={e => e.currentTarget.style.color = '#12284C'}
                      onMouseOut={e => e.currentTarget.style.color = 'rgba(18,40,76,0.18)'}
                      onClick={e => e.stopPropagation()}>
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </td>
                </motion.tr>
              )
            })}
          </tbody>
        </table>
        {filtered.length === 0 && (
          <div className="text-center py-12 text-sm" style={{ color: '#5C6E8C' }}>
            No orders found
          </div>
        )}
      </div>
    </div>
  )
}
