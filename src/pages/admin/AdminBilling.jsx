import React, { useMemo, useState } from 'react'
import { DollarSign, CheckCircle, XCircle, AlertTriangle, FileText, Lock, Landmark, Plus, RefreshCw } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { CLIENTS, VENDORS } from '../../data/mockData'
import {
  TERMS, termByKey, getClientTerms, setClientTerms, canConfirmPayments,
  invoiceAmount, invoiceNumber, money, clientCodeOf, paymentOf, payStatusOf,
  PAY_STATUS, isBillable, dueDate, isOverdue, openStatement,
  confirmPayment, bouncePayment,
} from '../../lib/billing'
import {
  PAYOUT_CYCLES, cycleByKey, getVendorCycle, setVendorCycle,
  isAbsAssigned, payoutOf, needsFee, payoutDue, isPayoutOverdue,
  buildPayout, payPayout,
  readSubscriptions, writeSubscriptions, subscriptionNextDue, isSubscriptionDue, paySubscription,
} from '../../lib/payouts'

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
  const superAdmin = !!user?.superAdmin
  const [view, setView] = useState('invoices')   // 'invoices' (money in) | 'payouts' (money out)
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
          <p className="text-sm" style={{ color: Q.muted }}>
            {view === 'invoices'
              ? 'ACH & Check reconciliation · invoices issue after delivery'
              : 'Abstractor fees & subscriptions · paid from the Chase account'}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {superAdmin && (
            <div className="flex rounded-lg overflow-hidden" style={{ border: `1px solid ${Q.border}` }}>
              {[['invoices', 'Client Invoices'], ['payouts', 'Vendor Payouts']].map(([k, l]) => (
                <button key={k} onClick={() => setView(k)}
                  className="px-3 py-1.5 text-xs font-semibold transition-all"
                  style={view === k
                    ? { background: `${ACCENT}14`, color: ACCENT }
                    : { background: Q.card, color: Q.muted }}>
                  {l}
                </button>
              ))}
            </div>
          )}
          {!vivek && (
            <span className="text-xs px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
              style={{ background: 'rgba(30,41,59,0.05)', color: Q.muted, border: `1px solid ${Q.border}` }}>
              <Lock className="w-3.5 h-3.5" /> Payments are executed by Vivek (billing super admin)
            </span>
          )}
        </div>
      </div>

      {view === 'payouts' && superAdmin ? (
        <VendorPayouts orders={orders} updateOrder={updateOrder} user={user} vivek={vivek} />
      ) : (
      <>
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
      </>
      )}
    </div>
  )
}

// ── Vendor Payouts (money out) ────────────────────────────────────────────────
// Orders the screener routed to ABS or Both owe the abstractor a fee. Super
// admins enter vendor + fee; only Vivek marks payouts (and subscriptions) paid.
function VendorPayouts({ orders, updateOrder, user, vivek }) {
  const [, bump] = useState(0) // re-render after cycle change
  const [subs, setSubs] = useState(readSubscriptions)

  const eligible = useMemo(() => orders.filter(isAbsAssigned), [orders])
  const pending  = eligible.filter(needsFee)
  const accrued  = eligible.filter(o => payoutOf(o)?.status === 'accrued')
  const paid     = eligible.filter(o => payoutOf(o)?.status === 'paid')

  const setFee = (o, vendor, amount) =>
    updateOrder({ ...o, workflow: { ...o.workflow, abstractorFee: buildPayout({ vendor, amount, userName: user?.name }) } })
  const markPaid = (o) =>
    updateOrder({ ...o, workflow: { ...o.workflow, abstractorFee: payPayout(payoutOf(o), user?.name) } })
  const paySub = (s) => setSubs(writeSubscriptions(subs.map(x => x.id === s.id ? paySubscription(x, user?.name) : x)))

  const sum = (list) => list.reduce((a, o) => a + (payoutOf(o)?.amount || 0), 0)
  const overdueTotal = sum(accrued.filter(isPayoutOverdue))
  const subsDue = subs.filter(isSubscriptionDue)

  return (
    <>
      {/* KPI strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Accrued (to pay)', value: money(sum(accrued)), color: '#b45309' },
          { label: 'Overdue', value: money(overdueTotal), color: '#dc2626' },
          { label: 'Paid out', value: money(sum(paid)), color: '#15803d' },
          { label: 'Awaiting fee entry', value: pending.length, color: '#2563eb' },
        ].map(k => (
          <div key={k.label} className="rounded-xl p-4" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
            <div className="text-xl font-bold tabular-nums" style={{ color: k.color }}>{k.value}</div>
            <div className="text-xs mt-0.5" style={{ color: Q.muted }}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Fee entry queue — ABS/Both orders with no vendor fee yet */}
      {pending.length > 0 && (
        <div className="rounded-xl overflow-hidden" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
          <div className="px-4 py-3" style={{ borderBottom: `1px solid ${Q.border}` }}>
            <div className="font-semibold text-sm" style={{ color: Q.text }}>Awaiting Fee Entry</div>
            <div className="text-xs" style={{ color: Q.faint }}>Searches routed to abstractors — pick the vendor and enter the agreed fee</div>
          </div>
          {pending.map(o => <FeeEntryRow key={o.id} order={o} onSave={setFee} />)}
        </div>
      )}

      {/* Per-vendor payables */}
      {VENDORS.map(v => {
        const rows = eligible.filter(o => payoutOf(o)?.vendor === v.code)
        if (!rows.length) return null
        const cycleKey = getVendorCycle(v.code)
        const open = rows.filter(o => payoutOf(o).status === 'accrued')
        return (
          <div key={v.code} className="rounded-xl overflow-hidden" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
            <div className="flex items-center justify-between gap-3 flex-wrap px-4 py-3" style={{ borderBottom: `1px solid ${Q.border}` }}>
              <div>
                <div className="font-semibold text-sm flex items-center gap-2" style={{ color: Q.text }}>
                  <Landmark className="w-4 h-4" style={{ color: ACCENT }} /> {v.name}
                </div>
                <div className="text-xs" style={{ color: Q.faint }}>{v.code} · {v.coverage} · {cycleByKey(cycleKey).desc}</div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <label className="flex items-center gap-2 text-xs" style={{ color: Q.muted }}>
                  Payout cycle
                  <select value={cycleKey} onChange={e => { setVendorCycle(v.code, e.target.value); bump(n => n + 1) }}
                    className="text-xs rounded-lg px-2 py-1.5"
                    style={{ border: `1px solid ${Q.border}`, background: Q.card, color: Q.text }}>
                    {PAYOUT_CYCLES.map(c => <option key={c.key} value={c.key}>{c.label}</option>)}
                  </select>
                </label>
                {vivek && open.length > 0 && (
                  <button onClick={() => open.forEach(markPaid)}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg"
                    style={{ background: ACCENT, color: '#f5f7f2' }}>
                    Mark {open.length} Paid · {money(sum(open))}
                  </button>
                )}
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm min-w-[680px]">
                <thead>
                  <tr style={{ borderBottom: `1px solid ${Q.border}` }}>
                    {['Order', 'Routed', 'Screened', 'Due', 'Fee', 'Status', vivek ? 'Actions' : ''].map((h, i) => (
                      <th key={i} className="text-left text-[10px] font-semibold uppercase tracking-wider px-4 py-2.5" style={{ color: Q.faint }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(o => {
                    const p = payoutOf(o)
                    const overdue = isPayoutOverdue(o)
                    return (
                      <tr key={o.id} style={{ borderBottom: `1px solid ${Q.border}` }}>
                        <td className="px-4 py-3 whitespace-nowrap font-medium" style={{ color: Q.text }}>{o.id} · {o.type}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: Q.muted }}>
                          {o.workflow?.searchAssignment === 'both' ? 'Both (vendor share)' : 'ABS (Abstract)'}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: Q.muted }}>{o.completedDates?.screener || '—'}</td>
                        <td className="px-4 py-3 whitespace-nowrap" style={{ color: overdue ? '#dc2626' : Q.muted }}>
                          {payoutDue(o) || '—'}{overdue && ' ⚠'}
                        </td>
                        <td className="px-4 py-3 font-semibold tabular-nums whitespace-nowrap" style={{ color: Q.text }}>{money(p.amount)}</td>
                        <td className="px-4 py-3">
                          <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
                            style={p.status === 'paid'
                              ? { background: 'rgba(21,128,61,0.10)', color: '#15803d' }
                              : { background: 'rgba(180,83,9,0.10)', color: '#b45309' }}>
                            {p.status === 'paid' ? 'Paid' : 'Accrued'}
                          </span>
                        </td>
                        {vivek && (
                          <td className="px-4 py-3 whitespace-nowrap">
                            {p.status === 'accrued' ? (
                              <button onClick={() => markPaid(o)}
                                className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg"
                                style={{ background: 'rgba(21,128,61,0.12)', color: '#15803d' }}>
                                <CheckCircle className="w-3.5 h-3.5" /> Mark Paid
                              </button>
                            ) : (
                              <span className="text-xs" style={{ color: Q.faint }}>by {p.paidBy} · {p.paidAt}</span>
                            )}
                          </td>
                        )}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}

      {/* Recurring subscriptions */}
      <div className="rounded-xl overflow-hidden" style={{ background: Q.card, border: `1px solid ${Q.border}`, boxShadow: Q.shadow }}>
        <div className="px-4 py-3 flex items-center justify-between" style={{ borderBottom: `1px solid ${Q.border}` }}>
          <div>
            <div className="font-semibold text-sm flex items-center gap-2" style={{ color: Q.text }}>
              <RefreshCw className="w-4 h-4" style={{ color: ACCENT }} /> Subscriptions
            </div>
            <div className="text-xs" style={{ color: Q.faint }}>Title plants & services · {subsDue.length ? `${subsDue.length} due` : 'all current'}</div>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[560px]">
            <thead>
              <tr style={{ borderBottom: `1px solid ${Q.border}` }}>
                {['Service', 'Cycle', 'Next Due', 'Amount', 'Last Paid', vivek ? 'Actions' : ''].map((h, i) => (
                  <th key={i} className="text-left text-[10px] font-semibold uppercase tracking-wider px-4 py-2.5" style={{ color: Q.faint }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {subs.map(s => {
                const due = isSubscriptionDue(s)
                return (
                  <tr key={s.id} style={{ borderBottom: `1px solid ${Q.border}` }}>
                    <td className="px-4 py-3 whitespace-nowrap font-medium" style={{ color: Q.text }}>{s.name}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: Q.muted }}>{cycleByKey(s.cycle).label}</td>
                    <td className="px-4 py-3 whitespace-nowrap" style={{ color: due ? '#dc2626' : Q.muted }}>{subscriptionNextDue(s)}{due && ' ⚠'}</td>
                    <td className="px-4 py-3 font-semibold tabular-nums whitespace-nowrap" style={{ color: Q.text }}>{money(s.amount)}</td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs" style={{ color: Q.faint }}>
                      {s.lastPaidAt ? `${s.lastPaidAt}${s.paidBy ? ` · ${s.paidBy}` : ''}` : 'Never'}
                    </td>
                    {vivek && (
                      <td className="px-4 py-3 whitespace-nowrap">
                        {due && (
                          <button onClick={() => paySub(s)}
                            className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1.5 rounded-lg"
                            style={{ background: 'rgba(21,128,61,0.12)', color: '#15803d' }}>
                            <CheckCircle className="w-3.5 h-3.5" /> Mark Paid
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {eligible.length === 0 && (
        <div className="rounded-xl p-10 text-center" style={{ background: Q.card, border: `1px solid ${Q.border}` }}>
          <Landmark className="w-8 h-8 mx-auto mb-2" style={{ color: Q.faint }} />
          <div className="text-sm" style={{ color: Q.muted }}>No searches routed to abstractors yet. Payables appear when a screener assigns ABS or Both.</div>
        </div>
      )}
    </>
  )
}

// One pending ABS order: vendor select + fee input → accrues the payable.
function FeeEntryRow({ order, onSave }) {
  const [vendor, setVendor] = useState('')
  const [amount, setAmount] = useState('')
  const ready = vendor && Number(amount) > 0
  return (
    <div className="flex items-center gap-3 flex-wrap px-4 py-3" style={{ borderBottom: `1px solid ${Q.border}` }}>
      <div className="flex-1 min-w-[180px]">
        <span className="font-medium text-sm" style={{ color: Q.text }}>{order.id}</span>
        <span className="text-xs ml-2" style={{ color: Q.muted }}>
          {order.type} · {order.county}, {order.state} · {order.workflow?.searchAssignment === 'both' ? 'Both' : 'ABS'}
        </span>
      </div>
      <select value={vendor} onChange={e => setVendor(e.target.value)}
        className="text-xs rounded-lg px-2 py-1.5"
        style={{ border: `1px solid ${Q.border}`, background: Q.card, color: Q.text }}>
        <option value="">Select vendor…</option>
        {VENDORS.map(v => <option key={v.code} value={v.code}>{v.name}</option>)}
      </select>
      <input type="number" min="0" step="5" value={amount} onChange={e => setAmount(e.target.value)}
        placeholder="Fee $" className="text-xs rounded-lg px-2 py-1.5 w-24"
        style={{ border: `1px solid ${Q.border}`, background: Q.card, color: Q.text }} />
      <button disabled={!ready} onClick={() => onSave(order, vendor, amount)}
        className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg"
        style={{ background: ready ? ACCENT : Q.border, color: '#f5f7f2', cursor: ready ? 'pointer' : 'not-allowed' }}>
        <Plus className="w-3.5 h-3.5" /> Accrue
      </button>
    </div>
  )
}
