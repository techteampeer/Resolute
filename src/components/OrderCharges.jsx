import React, { useState } from 'react'
import { Plus, Check, X, Clock } from 'lucide-react'
import { useOrders } from '../context/OrderContext'
import { money, buildCharge, chargesOf, approvedChargesTotal, isAmountInRange, formatDate } from '../lib/billing'

// One additional-fee ledger shared by every view of an order:
//   mode 'staff'  — Admin / Typer. Sees every charge + its status; with
//                   canRaise, a form to raise a new fee (which bills nothing
//                   until the client approves).
//   mode 'client' — the owning client. Approves or declines pending charges;
//                   an approval authorizes billing but is NOT a payment.
// Nothing here confirms a deposit — the Vivek-only payment path is untouched.

const uid = () => `chg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

const STATUS_META = {
  pending:  { label: 'Awaiting client', color: '#b45309', bg: '#fef3c7' },
  approved: { label: 'Approved',        color: '#15803d', bg: '#dcfce7' },
  declined: { label: 'Declined',        color: '#b91c1c', bg: '#fee2e2' },
}

export default function OrderCharges({ order, user, mode = 'staff', canRaise = false, accent = '#2441E5' }) {
  const { raiseCharge, resolveCharge } = useOrders()
  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('')

  const charges = chargesOf(order)
  const approved = approvedChargesTotal(order)
  const amtOk = isAmountInRange(amount) && Number(amount) > 0
  const canSubmit = label.trim().length > 0 && amtOk

  const submit = () => {
    if (!canSubmit) return
    raiseCharge(order, buildCharge({ id: uid(), label, amount, userName: user?.name || 'Staff', role: user?.role || 'admin' }))
    setLabel(''); setAmount('')
  }

  // A client sees nothing until a fee exists; staff always see the panel so they
  // can raise one.
  if (mode === 'client' && !charges.length) return null

  return (
    <div className="rounded-xl p-4" style={{ background: '#F9FBFD', border: '1px solid #DDE3EC' }}>
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: '#3D5171' }}>Additional fees</div>
        {approved > 0 && (
          <div className="text-[11px]" style={{ color: '#15803d' }}>
            <span className="font-semibold">{money(approved)}</span> approved · added to invoice
          </div>
        )}
      </div>

      {charges.length > 0 ? (
        <div className="space-y-1.5">
          {charges.map(c => {
            const m = STATUS_META[c.status] || STATUS_META.pending
            return (
              <div key={c.id} className="flex items-center gap-2.5 px-3 py-2 rounded-lg" style={{ background: '#fff', border: '1px solid #DDE3EC' }}>
                <div className="flex-1 min-w-0">
                  <div className="text-[13px] font-medium truncate" style={{ color: '#12284C' }}>{c.label}</div>
                  <div className="text-[10.5px]" style={{ color: '#5C6E8C' }}>
                    {mode === 'staff' && c.raisedBy ? `Raised by ${c.raisedBy}` : 'Added by Resolute'}
                    {c.resolvedAt ? ` · ${c.status === 'approved' ? 'approved' : 'declined'} ${formatDate(c.resolvedAt)}` : ''}
                  </div>
                </div>
                <div className="text-[13px] font-semibold tabular-nums" style={{ color: '#12284C' }}>{money(c.amount)}</div>
                {mode === 'client' && c.status === 'pending' ? (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => resolveCharge(order, c.id, 'approved')}
                      className="inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1.5 rounded-lg"
                      style={{ background: '#dcfce7', color: '#15803d' }}><Check className="w-3.5 h-3.5" /> Approve</button>
                    <button onClick={() => resolveCharge(order, c.id, 'declined')}
                      className="inline-flex items-center gap-1 text-[12px] font-semibold px-2.5 py-1.5 rounded-lg"
                      style={{ background: '#fee2e2', color: '#b91c1c' }}><X className="w-3.5 h-3.5" /> Decline</button>
                  </div>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-2 py-1 rounded-full"
                    style={{ background: m.bg, color: m.color }}>
                    {c.status === 'pending' && <Clock className="w-2.5 h-2.5" />}{m.label}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="text-[12px]" style={{ color: '#5C6E8C' }}>No additional fees on this order.</p>
      )}

      {mode === 'client' && (
        <p className="text-[11px] mt-2.5 leading-snug" style={{ color: '#5C6E8C' }}>
          Approving a fee authorizes us to bill it — it is added to this order's invoice. It is not a payment, and declining does not hold up your order.
        </p>
      )}

      {mode === 'staff' && canRaise && (
        <div className="mt-3 pt-3" style={{ borderTop: '1px solid #DDE3EC' }}>
          <div className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-1.5" style={{ color: '#5C6E8C' }}>Raise a fee for client approval</div>
          <div className="flex items-stretch gap-2 flex-wrap">
            <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Reason (e.g. additional county)"
              className="flex-1 min-w-[180px] text-[13px] px-2.5 py-2 rounded-lg" style={{ background: '#fff', border: '1px solid #DDE3EC', color: '#12284C' }} />
            <div className="flex items-center rounded-lg" style={{ background: '#fff', border: '1px solid #DDE3EC' }}>
              <span className="pl-2.5 text-[13px]" style={{ color: '#5C6E8C' }}>$</span>
              <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="0.00"
                className="w-[92px] text-[13px] px-1.5 py-2 bg-transparent outline-none tabular-nums" style={{ color: '#12284C' }} />
            </div>
            <button onClick={submit} disabled={!canSubmit}
              className="inline-flex items-center gap-1 text-[13px] font-semibold px-3 py-2 rounded-lg text-white"
              style={{ background: accent, opacity: canSubmit ? 1 : 0.5, cursor: canSubmit ? 'pointer' : 'not-allowed' }}>
              <Plus className="w-4 h-4" /> Request
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
