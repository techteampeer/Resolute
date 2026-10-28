import React, { useState, useMemo, useEffect } from 'react'
import { Search } from 'lucide-react'
import { ORDER_TABS, tabOf, tabCounts, DATE_RANGES, withinRange, sortByAccessor } from '../lib/ordersView'
import { density } from '../lib/ui'

// Qualia-style orders list, shared so every portal filters and reads the same:
// search + "Ordered within" date range + the six filter tabs + a column-driven
// table + client-side pagination. The caller supplies the columns (so each portal
// shows its own set and renders its own status badge) and an optional `search`
// haystack builder; the tab model and date range come from lib/ordersView, so
// admin and client classify every order identically.
//
// Props:
//   orders      the already-scoped list (admin: all; client: their own)
//   columns     [{ header, render(order), align?, nowrap? }]
//   search      (order) => string haystack; omit to hide the search box
//   onRowClick  (order) => void
//   accent      active-tab / focus colour
//   emptyText   shown when nothing matches
//   pageSize    rows per page (default 12)
const Q = {
  card:'#fff', border:'#E6EBF2', text:'#12284C', muted:'#5C6E8C', faint:'#9AA8BF',
  bg:'#F4F7FB', rowHover:'#F9FBFD', shadow:'0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
}

export default function OrdersTableView({ orders, columns, search, onRowClick, accent = '#2441E5', emptyText = 'No orders found', pageSize = 12 }) {
  const [q, setQ] = useState('')
  const [tab, setTab] = useState('all')
  const [dateRange, setDateRange] = useState('all')
  const [page, setPage] = useState(1)
  // Column sort: the active column's header + direction (asc | desc | null).
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState(null)
  const CELL_PAD = `${density.rowPadY}px ${density.rowPadX}px`

  const counts = useMemo(() => tabCounts(orders), [orders])
  const tabs = ORDER_TABS.map(t => ({ ...t, count: counts[t.key] }))

  const query = q.trim().toLowerCase()
  const filtered = useMemo(() => orders.filter(o =>
    (tab === 'all' || tabOf(o) === tab)
    && withinRange(o, dateRange)
    && (!query || !search || search(o).toLowerCase().includes(query))
  ), [orders, tab, dateRange, query, search])

  // A column is sortable when it supplies a sortValue accessor. Clicking its
  // header cycles ascending → descending → off.
  const activeCol = columns.find(c => c.header === sortKey && c.sortValue)
  const sorted = useMemo(
    () => (activeCol ? sortByAccessor(filtered, activeCol.sortValue, sortDir) : filtered),
    [filtered, activeCol, sortDir])
  const onSort = (col) => {
    if (!col.sortValue) return
    if (sortKey !== col.header) { setSortKey(col.header); setSortDir('asc'); return }
    if (sortDir === 'asc') { setSortDir('desc'); return }
    setSortKey(null); setSortDir(null)           // was descending → clear the sort
  }

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const safePage = Math.min(page, totalPages)
  const paged = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)
  useEffect(() => { setPage(1) }, [tab, q, dateRange, sortKey, sortDir])

  const CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='M6 9l6 6 6-6'/></svg>\")"
  const selectStyle = {
    appearance:'none', WebkitAppearance:'none', MozAppearance:'none',
    height:38, padding:'0 30px 0 12px', borderRadius:8, border:`1px solid ${Q.border}`,
    background:`${Q.card} ${CHEVRON} no-repeat right 10px center`, backgroundSize:'12px',
    color:Q.text, fontSize:13, fontWeight:500, outline:'none', cursor:'pointer',
  }

  return (
    <div className="space-y-4">
      {/* Toolbar: search + Ordered within */}
      <div style={{ display:'flex', alignItems:'center', gap:12, flexWrap:'wrap' }}>
        {search && (
          <div style={{ position:'relative', flex:'1 1 260px', minWidth:220 }}>
            <Search style={{ position:'absolute', left:12, top:'50%', transform:'translateY(-50%)', width:15, height:15, color:Q.faint }} />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Search order #, product, property…"
              style={{ width:'100%', height:38, paddingLeft:34, paddingRight:12, background:Q.card,
                border:`1px solid ${Q.border}`, borderRadius:8, color:Q.text, fontSize:13, outline:'none' }}
              onFocus={e => e.target.style.borderColor = accent}
              onBlur={e => e.target.style.borderColor = Q.border} />
          </div>
        )}
        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:13, color:Q.muted, whiteSpace:'nowrap' }}>Ordered within</span>
          <select value={dateRange} onChange={e => setDateRange(e.target.value)} style={selectStyle} title="Ordered within">
            {DATE_RANGES.map(d => <option key={d.key} value={d.key}>{d.label}</option>)}
          </select>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="overflow-x-auto" style={{ display:'flex', gap:0, borderBottom:`1px solid ${Q.border}` }}>
        {tabs.map(t => (
          <button key={t.key} onClick={() => setTab(t.key)} className="shrink-0 whitespace-nowrap"
            style={{ display:'flex', alignItems:'center', gap:6, padding:'10px 16px', fontSize:13, fontWeight:500,
              color: tab === t.key ? accent : Q.muted, marginBottom:-1, background:'transparent',
              border:'none', borderBottomWidth:2, borderBottomStyle:'solid',
              borderBottomColor: tab === t.key ? accent : 'transparent', cursor:'pointer', transition:'color 0.15s' }}>
            {t.label}
            <span style={{ padding:'1px 7px', borderRadius:99, fontSize:11, fontWeight:700,
              background: tab === t.key ? `${accent}18` : Q.bg, color: tab === t.key ? accent : Q.faint }}>
              {t.count}
            </span>
          </button>
        ))}
      </div>

      {/* Table */}
      <div style={{ background:Q.card, border:`1px solid ${Q.border}`, borderRadius:10, boxShadow:Q.shadow, overflow:'hidden' }}>
        <div style={{ overflowX:'auto' }}>
          <table style={{ width:'100%', borderCollapse:'collapse', fontSize:density.bodySize, lineHeight:density.lineHeight, minWidth:820 }}>
            <thead>
              <tr style={{ background:'#F9FBFD', borderBottom:`1px solid ${Q.border}` }}>
                {columns.map(c => {
                  const sortable = !!c.sortValue
                  const active = sortable && activeCol?.header === c.header
                  const caret = active ? (sortDir === 'asc' ? '▲' : '▼') : (sortable ? '↕' : '')
                  return (
                    <th key={c.header} onClick={sortable ? () => onSort(c) : undefined}
                      title={sortable ? `Sort by ${c.header}` : undefined}
                      style={{ padding:CELL_PAD, textAlign:c.align || 'left', fontSize:density.headSize,
                        fontWeight:600, textTransform:'uppercase', letterSpacing:'0.05em',
                        color: active ? accent : Q.faint, whiteSpace:'nowrap',
                        cursor: sortable ? 'pointer' : 'default', userSelect:'none' }}>
                      {c.header}
                      {sortable && <span style={{ marginLeft:5, fontSize:9, color: active ? accent : Q.faint, opacity: active ? 1 : 0.5 }}>{caret}</span>}
                    </th>
                  )
                })}
              </tr>
            </thead>
            <tbody>
              {paged.map(o => (
                <tr key={o.id}
                  style={{ borderBottom:`1px solid ${Q.border}`, cursor: onRowClick ? 'pointer' : 'default' }}
                  onMouseOver={e => e.currentTarget.style.background = Q.rowHover}
                  onMouseOut={e => e.currentTarget.style.background = 'transparent'}
                  onClick={() => onRowClick?.(o)}>
                  {columns.map(c => (
                    <td key={c.header} style={{ padding:CELL_PAD, textAlign:c.align || 'left',
                      color:Q.muted, ...(c.nowrap === false ? {} : { whiteSpace:'nowrap' }) }}>
                      {c.render(o)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div style={{ padding:'44px 16px', textAlign:'center', color:Q.faint, fontSize:13 }}>{emptyText}</div>
        )}
        {filtered.length > 0 && (
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'10px 16px', borderTop:`1px solid ${Q.border}`, background:'#F9FBFD' }}>
            <span style={{ fontSize:12, color:Q.muted }}>
              Showing <strong style={{ color:Q.text }}>{(safePage - 1) * pageSize + 1}–{Math.min(safePage * pageSize, filtered.length)}</strong> of <strong style={{ color:Q.text }}>{filtered.length}</strong> orders
            </span>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <button onClick={() => setPage(p => Math.max(1, p - 1))} disabled={safePage <= 1}
                style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600, border:`1px solid ${Q.border}`,
                  background:Q.card, color: safePage <= 1 ? Q.faint : Q.text, cursor: safePage <= 1 ? 'not-allowed' : 'pointer' }}>
                Prev
              </button>
              <span style={{ fontSize:12, color:Q.muted }}>Page {safePage} / {totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages, p + 1))} disabled={safePage >= totalPages}
                style={{ padding:'5px 12px', borderRadius:7, fontSize:12, fontWeight:600, border:`1px solid ${Q.border}`,
                  background:Q.card, color: safePage >= totalPages ? Q.faint : Q.text, cursor: safePage >= totalPages ? 'not-allowed' : 'pointer' }}>
                Next
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
