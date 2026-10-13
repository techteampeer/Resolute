import React, { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { FileText, CheckCircle, Upload, AlertTriangle, Landmark, Mail, Clock } from 'lucide-react'
import { useOrders } from '../../context/OrderContext'
import { useAuth } from '../../context/AuthContext'
import { isSupabaseConfigured, uploadDocument, openDocument } from '../../lib/backend'
import {
  REMITTANCE, hasRemittanceDetails, termByKey, getClientTerms, hydrateClientTerms,
  invoiceAmount, invoiceNumber, money, clientCodeOf, paymentOf, payStatusOf,
  PAY_STATUS, isBillable, dueDate, isOverdue, openStatement, buildPayment,
} from '../../lib/billing'

const ROLE_COLOR = '#2441E5'

const Chip = ({ status }) => {
  const s = PAY_STATUS[status] || PAY_STATUS.unpaid
  return <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap"
    style={{ background: `${s.color}1a`, color: s.color }}>{s.label}</span>
}
const OverdueBadge = () => (
  <span className="text-[11px] font-semibold px-2.5 py-1 rounded-full whitespace-nowrap inline-flex items-center gap-1"
    style={{ background: 'rgba(220,38,38,0.12)', color: '#dc2626' }}>
    <AlertTriangle className="w-3 h-3" /> Overdue
  </span>
)

// Remittance instructions — placeholders until real details are configured.
function Remittance({ method }) {
  const box = { background: 'rgba(18,40,76,0.04)', border: '1px solid rgba(18,40,76,0.08)' }
  if (method === 'ACH') {
    return (
      <div className="rounded-xl p-3 text-xs space-y-1" style={box}>
        <div className="flex items-center gap-1.5 font-semibold" style={{ color: '#12284C' }}>
          <Landmark className="w-3.5 h-3.5" style={{ color: ROLE_COLOR }} /> Send ACH to
        </div>
        {hasRemittanceDetails ? (
          <div style={{ color: '#3D5171' }}>
            <div>{REMITTANCE.bankName} · Acct name: {REMITTANCE.accountName}</div>
            <div>Routing: {REMITTANCE.routingNumber} · Account: {REMITTANCE.accountNumber}</div>
          </div>
        ) : (
          <div style={{ color: '#3D5171' }}>Contact <a href={`mailto:${REMITTANCE.billingEmail}`} className="underline" style={{ color: ROLE_COLOR }}>{REMITTANCE.billingEmail}</a> for ACH remittance details.</div>
        )}
        <div style={{ color: '#5C6E8C' }}>Include the invoice / statement number as the transfer reference.</div>
      </div>
    )
  }
  return (
    <div className="rounded-xl p-3 text-xs space-y-1" style={box}>
      <div className="flex items-center gap-1.5 font-semibold" style={{ color: '#12284C' }}>
        <Mail className="w-3.5 h-3.5" style={{ color: ROLE_COLOR }} /> Mail check to
      </div>
      {REMITTANCE.payee && REMITTANCE.checkAddress ? (
        <div style={{ color: '#3D5171' }}>
          <div>Payable to: {REMITTANCE.payee}</div>
          <div>{REMITTANCE.checkAddress}</div>
        </div>
      ) : (
        <div style={{ color: '#3D5171' }}>Contact <a href={`mailto:${REMITTANCE.billingEmail}`} className="underline" style={{ color: ROLE_COLOR }}>{REMITTANCE.billingEmail}</a> for the payee name and mailing address.</div>
      )}
      <div style={{ color: '#5C6E8C' }}>Write the invoice / statement number in the memo. Credit is applied once the check is received and deposited.</div>
    </div>
  )
}

// Pay panel — ACH (trace #) or Check (check # + image upload). onPaid receives
// the built payment object to stamp on the order(s).
function PayPanel({ payLabel, docKeyId, onPaid }) {
  const [method, setMethod] = useState('ACH')
  const [reference, setReference] = useState('')
  const [checkDoc, setCheckDoc] = useState(null)
  const [busy, setBusy] = useState(false)

  const onFile = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    try {
      if (isSupabaseConfigured) {
        const { url, path } = await uploadDocument(docKeyId, file)
        setCheckDoc({ name: file.name, url, path })
      } else {
        setCheckDoc({ name: file.name, url: URL.createObjectURL(file) })
      }
    } catch { setCheckDoc({ name: file.name, url: null }) }
    setBusy(false)
  }

  const submit = () => {
    if (!reference.trim() || busy) return
    onPaid(buildPayment({ method, reference: reference.trim(), checkDoc: method === 'Check' ? checkDoc : null }))
  }

  return (
    <div className="mt-3 space-y-3">
      <div className="grid grid-cols-2 gap-2">
        {['ACH', 'Check'].map(m => (
          <button key={m} onClick={() => setMethod(m)}
            className="py-2 rounded-xl text-sm font-medium border transition-all"
            style={method === m
              ? { background: `${ROLE_COLOR}1e`, border: `1px solid ${ROLE_COLOR}55`, color: '#12284C' }
              : { border: '1px solid rgba(18,40,76,0.08)', color: '#3D5171' }}>
            {m}
          </button>
        ))}
      </div>
      <Remittance method={method} />
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#5C6E8C' }}>
          {method === 'ACH' ? 'ACH trace / confirmation #' : 'Check #'} *
        </label>
        <input value={reference} onChange={e => setReference(e.target.value)}
          placeholder={method === 'ACH' ? 'e.g. 021000021456789' : 'e.g. 1042'}
          className="input-field text-sm" />
      </div>
      {method === 'Check' && (
        <div>
          <label className="block text-[11px] font-semibold uppercase tracking-wider mb-1" style={{ color: '#5C6E8C' }}>
            Check image / PDF <span style={{ textTransform: 'none', opacity: .6 }}>(for reference)</span>
          </label>
          <label className="flex items-center gap-2 px-3 py-2.5 rounded-xl border cursor-pointer text-sm"
            style={{ border: '1px dashed rgba(18,40,76,0.2)', color: checkDoc ? '#15803d' : '#5C6E8C' }}>
            <Upload className="w-4 h-4" />
            {checkDoc ? checkDoc.name : 'Upload a photo or PDF of the check'}
            <input type="file" accept="image/*,.pdf" className="hidden" onChange={onFile} />
          </label>
        </div>
      )}
      <button onClick={submit} disabled={!reference.trim() || busy}
        className="btn-primary w-full text-sm py-2.5" style={{ opacity: (!reference.trim() || busy) ? 0.5 : 1 }}>
        {busy ? 'Uploading…' : `Mark ${payLabel} as Paid via ${method}`}
      </button>
      <p className="text-[11px]" style={{ color: '#5C6E8C' }}>
        This records your payment for reconciliation — funds move via your bank{method === 'Check' ? ' / the mailed check' : ''}.
        The invoice shows as Paid once Resolute confirms the deposit.
      </p>
    </div>
  )
}

function InvoiceRow({ order, termKey, onPaid, demo }) {
  const [open, setOpen] = useState(false)
  const status = payStatusOf(order)
  const p = paymentOf(order)
  const overdue = isOverdue(order, termKey)
  return (
    <div className="glass-card p-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 flex-shrink-0" style={{ color: ROLE_COLOR }} />
            <span className="font-semibold text-sm" style={{ color: '#12284C' }}>{invoiceNumber(order)}</span>
            <Chip status={status} />
            {overdue && <OverdueBadge />}
          </div>
          <div className="text-xs mt-1" style={{ color: '#5C6E8C' }}>
            {order.type} · {order.id} · delivered {order.completed || '—'} · due {dueDate(order, termKey) || '—'}
          </div>
          {p && status !== 'unpaid' && (
            <div className="text-xs mt-1" style={{ color: '#5C6E8C' }}>
              {p.method} ref <span className="font-mono">{p.reference}</span>
              {(p.checkDoc?.url || p.checkDoc?.path) && <> · <button onClick={() => openDocument(p.checkDoc)} className="underline" style={{ color: ROLE_COLOR, background:'none', border:'none', padding:0, font:'inherit', cursor:'pointer' }}>check image</button></>}
              {status === 'marked' && ' · awaiting deposit confirmation'}
              {status === 'confirmed' && ` · confirmed ${p.confirmedAt}`}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold tabular-nums" style={{ color: '#12284C' }}>{money(invoiceAmount(order))}</span>
          {!demo && (status === 'unpaid' || status === 'bounced') && (
            <button onClick={() => setOpen(!open)} className="btn-secondary text-xs px-3 py-2">{open ? 'Close' : 'Pay'}</button>
          )}
        </div>
      </div>
      {!demo && open && (status === 'unpaid' || status === 'bounced') && (
        <PayPanel payLabel={invoiceNumber(order)} docKeyId={order.id}
          onPaid={(pay) => { onPaid(order, pay); setOpen(false) }} />
      )}
    </div>
  )
}

export default function ClientBilling({ myOrders }) {
  const { markPayment } = useOrders()
  const { user } = useAuth()
  const isDemo = !!user?.demo
  const [, bump] = useState(0)
  // Pull durable terms into the local cache so due dates match Admin's view.
  useEffect(() => { hydrateClientTerms().then(ok => ok && bump(n => n + 1)) }, [])
  const billable = myOrders.filter(isBillable)
  const clientCode = billable.map(clientCodeOf).find(Boolean) || clientCodeOf(myOrders[0] || {}) || 'CL01'
  const termKey = getClientTerms(clientCode)
  const term = termByKey(termKey)
  const stmt = openStatement(myOrders, clientCode, termKey)
  const [payStmt, setPayStmt] = useState(false)

  // Client marks paid via markPayment (RPC-backed under Supabase; clients have
  // no direct UPDATE on orders). Mock mode falls back to a local update inside
  // markPayment as well.
  const payOne = (order, pay) => markPayment(order, pay)
  const payStatement = (pay) => {
    stmt.items.forEach(o => markPayment(o, { ...pay, statementId: stmt.id }))
    setPayStmt(false)
  }

  const unconfirmed = billable.filter(o => payStatusOf(o) !== 'confirmed')
  const paid = billable.filter(o => payStatusOf(o) === 'confirmed')

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h1 className="text-2xl font-bold" style={{ color: '#12284C' }}>Billing</h1>
        <span className="text-xs font-semibold px-3 py-1.5 rounded-full inline-flex items-center gap-1.5"
          style={{ background: `${ROLE_COLOR}16`, color: ROLE_COLOR, border: `1px solid ${ROLE_COLOR}2e` }}>
          <Clock className="w-3.5 h-3.5" /> Terms: {term.label}
        </span>
      </div>

      {isDemo && (
        <div className="text-xs px-4 py-2.5 rounded-xl" style={{ background:'rgba(36,65,229,0.08)', border:'1px solid rgba(36,65,229,0.22)', color:'#2441E5' }}>
          Payments are disabled in the demo — the invoices below are sample data.
        </div>
      )}

      {/* Consolidated statement (termed clients) */}
      {stmt && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
          className="glass-card p-5" style={{ border: `1px solid ${ROLE_COLOR}40` }}>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-semibold text-sm" style={{ color: '#12284C' }}>Statement · {stmt.id}</span>
                {stmt.overdue && <OverdueBadge />}
              </div>
              <div className="text-xs mt-1" style={{ color: '#5C6E8C' }}>
                {stmt.items.length} invoice{stmt.items.length > 1 ? 's' : ''} · {term.label} terms · due {stmt.due}
              </div>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xl font-bold tabular-nums" style={{ color: '#12284C' }}>{money(stmt.total)}</span>
              {!isDemo && (
                <button onClick={() => setPayStmt(!payStmt)} className="btn-primary text-xs px-4 py-2">
                  {payStmt ? 'Close' : 'Pay Statement'}
                </button>
              )}
            </div>
          </div>
          <div className="mt-3 space-y-1">
            {stmt.items.map(o => (
              <div key={o.id} className="flex items-center justify-between text-xs" style={{ color: '#3D5171' }}>
                <span>{invoiceNumber(o)} · {o.type}</span>
                <span className="flex items-center gap-2"><Chip status={payStatusOf(o)} /><span className="tabular-nums font-medium">{money(invoiceAmount(o))}</span></span>
              </div>
            ))}
          </div>
          {payStmt && <PayPanel payLabel={stmt.id} docKeyId={stmt.id} onPaid={payStatement} />}
        </motion.div>
      )}

      {/* Per-order invoices (always listed; pay buttons hidden when a statement covers them) */}
      <div className="space-y-3">
        <h2 className="font-semibold text-sm" style={{ color: '#12284C' }}>Open Invoices</h2>
        {unconfirmed.length === 0 && (
          <div className="glass-card p-6 text-center text-sm" style={{ color: '#5C6E8C' }}>
            <CheckCircle className="w-6 h-6 mx-auto mb-2" style={{ color: '#15803d' }} />
            No outstanding invoices — you're all settled.
          </div>
        )}
        {unconfirmed.map(o => stmt
          ? ( // covered by the statement — informational row only
            <div key={o.id} className="glass-card p-4 flex items-center justify-between gap-3 flex-wrap">
              <div className="text-sm" style={{ color: '#3D5171' }}>
                <span className="font-semibold" style={{ color: '#12284C' }}>{invoiceNumber(o)}</span> · {o.type} · included in {stmt.id}
              </div>
              <span className="tabular-nums font-bold text-sm" style={{ color: '#12284C' }}>{money(invoiceAmount(o))}</span>
            </div>
          )
          : <InvoiceRow key={o.id} order={o} termKey={termKey} onPaid={payOne} demo={isDemo} />
        )}
      </div>

      {/* Payment history */}
      {paid.length > 0 && (
        <div className="space-y-3">
          <h2 className="font-semibold text-sm" style={{ color: '#12284C' }}>Payment History</h2>
          {paid.map(o => {
            const p = paymentOf(o)
            return (
              <div key={o.id} className="glass-card p-4 flex items-center justify-between gap-3 flex-wrap">
                <div className="text-xs" style={{ color: '#5C6E8C' }}>
                  <span className="font-semibold text-sm" style={{ color: '#12284C' }}>{invoiceNumber(o)}</span>
                  <span> · {p?.method} ref </span><span className="font-mono">{p?.reference}</span>
                  <span> · confirmed {p?.confirmedAt} by {p?.confirmedBy}</span>
                </div>
                <span className="flex items-center gap-2">
                  <Chip status="confirmed" />
                  <span className="tabular-nums font-bold text-sm" style={{ color: '#12284C' }}>{money(invoiceAmount(o))}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
