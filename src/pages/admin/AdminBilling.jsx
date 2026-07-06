import React, { useMemo, useState } from 'react'
import { DollarSign, CheckCircle, XCircle, AlertTriangle, FileText, Lock } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { CLIENTS } from '../../data/mockData'
import {
  TERMS, termByKey, getClientTerms, setClientTerms, canConfirmPayments,
  invoiceAmount, invoiceNumber, money, clientCodeOf, paymentOf, payStatusOf,
  PAY_STATUS, isBillable, dueDate, isOverdue, openStatement,
  confirmPayment, bouncePayment,
} from '../../lib/billing'

const Q = {
  card: '#ffffff', border: '#e2e8f0', text: '#1e293b', muted: '#64748b',
  faint: '#94a3b8', shadow: '0 1px 3px rgba(0,0,0,0.08), 0 1px 2px rgba(0,0,0,0.04)',
}
const ACCENT = '#3d7020'

const Chip = ({ status }) => {
  const s = PAY_STATUS[status] || PAY_STATUS.unpaid
  return <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
    style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
}

export default function AdminBilling() {
  const { orders, updateOrder } = useOrders()
  const { user } = useAuth()
  const vivek = canConfirmPayments(user)
  const [filter, setFilter] = useState('all')
  const [, bump] = useState(0) // re-render after a terms change

  const billable = useMemo(() => orders.filter(isBillable), [orders])
  const byClient = useMemo(() => {
    const m = new Map()
    for (const o of billable) {
      const code = clientCodeOf(o) || '—'
      if (!m.has(code)) m.set(code, [])
      m.get(code).push(o)
    }
    return m
  }, [billable])

  const setPay = (o, p) => updateOrder({ ...o, workflow: { ...o.workflow, payment: p } })
  const confirmOne = (o) => setPay(o, confirmPayment(paymentOf(o), user?.name))
  const bounceOne = (o) => setPay(o, bouncePayment(paymentOf(o), user?.name))
  // Confirming a statement payment settles every order paid under that statementId.
  const confirmStatement = (stmtId) => billable
    .filter(o => paymentOf(o)?.statementId === stmtId && payStatusOf(o) === 'marked')
    .forEach(confirmOne)

  const matches = (o) => {
    if (filter === 'all') return true
    if (filter === 'overdue') return isOverdue(o, getClientTerms(clientCodeOf(o)))
    return payStatusOf(o) === filter
  }

  const totals = {
    outstanding: billable.filter(o => payStatusOf(o) !== 'confirmed').reduce((a, o) => a + invoiceAmount(o), 0),
    marked: billable.filter(o => payStatusOf(o) === 'marked').reduce((a, o) => a + invoiceAmount(o), 0),
    collected: billable.filter(o => payStatusOf(o) === 'confirmed').reduce((a, o) => a + invoiceAmount(o), 0),
    overdue: billable.filter(o => isOverdue(o, getClientTerms(clientCodeOf(o)))).reduce((a, o) => a + invoiceAmount(o), 0),
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold" style={{ color: Q.text }}>Billing</h1>
          <p className="text-sm" style={{ color: Q.muted }}>ACH & Check reconciliation · invoices issue after delivery</p>
        </div>
        {!vivek && (
          <span className="text-xs px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
            style={{ background: 'rgba(30,41,59,0.05)', color: Q.muted, border: `1px solid ${Q.border}` }}>
            <Lock className="w-3.5 h-3.5" /> Payment confirmation is restricted to Vivek (super admin)
          </span>
        )}
      </div>

      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Outstanding', value: totals.outstanding, color: '#b45309' },
          { label: 'Marked Paid (to confirm)', value: totals.marked, color: '#2563eb' },
          { label: 'Collected', value: totals.collected, color: '#15803d' },
          { label: 'Overdue', value: totals.overdue, color: '#dc2626' },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
            <div className="text-xl font-bold tabular-nums" style={{ color: k.color }}>{money(k.value)}</div>
            <div className="text-xs mt-0.5" style={{ color: Q.muted }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Status filter */}
      <div className="flex items-center gap-2 flex-wrap">
        {[['all', 'All'], ['unpaid', 'Unpaid'], ['marked', 'Marked Paid'], ['confirmed', 'Paid'], ['bounced', 'Bounced'], ['overdue', 'Overdue']].map(([k, l]) => (
          <button key={k} onClick={() => setFilter(k)}
            className="px-3 py-1.5 rounded-lg text-xs font-medium border transition-all"
            style={filter === k
              ? { background: `${ACCENT}14`, border: `1px solid ${ACCENT}55`, color: Q.text }
              : { border: `1px solid ${Q.border}`, color: Q.muted, background: Q.card }}>
            {l}
          </button>
        ))}
      </div>

      {/* Per-client sections */}
      {[...byClient.entries()].map(([code, list]) => {
        const client = CLIENTS.find(c => c.code === code)
        const termKey = getClientTerms(code)
        const stmt = openStatement(orders, code, termKey)
        const rows = list.filter(matches)
        if (!rows.length && filter !== 'all') return null
        return (
          <div key={code} className="rounded-xl overflow-hidden" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
            {/* Client header + terms editor */}
            <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3" style={{ borderBottom: `1px solid ${Q.border}` }}>
              <div>
                <div className="font-semibold text-sm" style={{ color: Q.text }}>{client?.name || code}</div>
                <div className="text-xs" style={{ color: Q.faint }}>{code} · {termByKey(termKey).desc}</div>
              </div>
              <label className="flex items-center gap-2 text-xs" style={{ color: Q.muted }}>
                Payment terms
                <select value={termKey} onChange={e => { setClientTerms(code, e.target.value); bump(n => n + 1) }}
                  className="text-xs rounded-lg px-2 py-1.5"
                  style={{ border: `1px solid ${Q.border}`, background: Q.card, color: Q.text }}>
                  {TERMS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
                </select>
              </label>
            </div>

            {/* Open statement banner (termed clients) */}
            {stmt && (
              <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-2.5"
                style={{ background: `${ACCENT}0d`, borderBottom: `1px solid ${Q.border}` }}>
                <div className="text-xs flex items-center gap-2 flex-wrap" style={{ color: Q.muted }}>
                  <FileText className="w-3.5 h-3.5" style={{ color: ACCENT }} />
                  <span className="font-semibold" style={{ color: Q.text }}>{stmt.id}</span>
                  <span>{stmt.items.length} invoices · due {stmt.due}</span>
                  {stmt.overdue && <span className="inline-flex items-center gap-1 font-semibold" style={{ color: '#dc2626' }}><AlertTriangle className="w-3 h-3" />Overdue</span>}
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-sm font-bold tabular-nums" style={{ color: Q.text }}>{money(stmt.total)}</span>
                  {vivek && stmt.items.some(o => payStatusOf(o) === 'marked' && paymentOf(o)?.statementId === stmt.id) && (
                    <button onClick={() => confirmStatement(stmt.id)}
                      className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                      style={{ background: ACCENT, color: '#f5f7f2' }}>
                      Confirm Statement Received
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Invoice rows */}
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[760px]">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${Q.border}` }}>
                    {['Invoice', 'Order', 'Delivered', 'Due', 'Method / Ref', 'Amount', 'Status', vivek ? 'Actions' : ''].map((h, i) => (
                      <th key={i} className="text-left text-[10px] font-semibold uppercase tracking-wider px-4 py-2.5" style={{ color: Q.faint }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(o => {
                    const p = paymentOf(o)
                    const status = payStatusOf(o)
                    const overdue = isOverdue(o, termKey)
                    return (
                      <tr key={o.id} style={{ borderBottom: `1px solid ${Q.border}` }}>
                        <td className="px-4 py-3 font-medium whitespace-nowrap" style={{ color: Q.text }}>{invoiceNumber(o)}</td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: Q.muted }}>{o.id} · {o.type}</td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: Q.muted }}>{o.completed || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: overdue ? '#dc2626' : Q.muted }}>
                          {dueDate(o, termKey) || '—'}{overdue && ' ⚠'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: Q.muted }}>
                          {p ? (
                            <>
                              {p.method} · <span className="font-mono">{p.reference || '—'}</span>
                              {p.checkDoc?.url && <> · <a href={p.checkDoc.url} target="_blank" rel="noreferrer" className="underline" style={{ color: ACCENT }}>check</a></>}
                              {p.statementId && <div style={{ color: Q.faint }}>{p.statementId}</div>}
                            </>
                          ) : '—'}
                        </td>
                        <td className="px-4 py-3 font-semibold tabular-nums whitespace-nowrap" style={{ color: Q.text }}>{money(invoiceAmount(o))}</td>
                        <td className="px-4 py-3"><Chip status={status} /></td>
                        {vivek && (
                          <td className="px-4 py-3 whitespace-nowrap">
                            {status === 'marked' && (
                              <span className="inline-flex gap-1.5">
                                <button onClick={() => confirmOne(o)} title="Confirm deposit received"
                                  className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg"
                                  style={{ background: 'rgba(21,128,61,0.12)', color: '#15803d' }}>
                                  <CheckCircle className="w-3.5 h-3.5" /> Confirm
                                </button>
                                <button onClick={() => bounceOne(o)} title="Payment failed / bounced"
                                  className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg"
                                  style={{ background: 'rgba(220,38,38,0.10)', color: '#dc2626' }}>
                                  <XCircle className="w-3.5 h-3.5" /> Bounce
                                </button>
                              </span>
                            )}
                            {status === 'confirmed' && <span className="text-xs" style={{ color: Q.faint }}>by {p?.confirmedBy} · {p?.confirmedAt}</span>}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                  {!rows.length && (
                    <tr><td colSpan={8} className="px-4 py-6 text-center text-xs" style={{ color: Q.faint }}>No invoices match this filter.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {billable.length === 0 && (
        <div className="rounded-xl p-10 text-center" style={{ background: Q.card, border: `1px solid ${Q.border}` }}>
          <DollarSign className="w-8 h-8 mx-auto mb-2" style={{ color: Q.faint }} />
          <div className="text-sm" style={{ color: Q.muted }}>No delivered orders to bill yet.</div>
        </div>
      )}
    </div>
  )
}
