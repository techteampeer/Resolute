import React from 'react'
import { Lock, Trash2, Plus, Tag } from 'lucide-react'
import { TextInput, MoneyInput, T } from './ui'
import { fmtMoney, uid } from '../../../data/fulfillment'

const lineTotal = (li) => (Number(li.costPerUnit) || 0) * (Number(li.units) || 0)
const sum = (rows) => rows.reduce((a, li) => a + lineTotal(li), 0)

// Common additional-charge labels offered as a quick-pick. The Type field stays
// free text — this datalist just saves typing for the usual charges.
const CHARGE_TYPES = ['Copy Costs', 'Recording Fee', 'Municipal Search', 'Rush Fee', 'Courier', 'Certification', 'Other']

// Hoisted to module scope ON PURPOSE. When this lived inside InvoiceBlock, every
// keystroke bubbled an onChange that re-rendered InvoiceBlock, which created a
// NEW Row function identity each time — so React unmounted/remounted the row's
// <input> and the caret (and focus) were lost, forcing a click per character.
// At module scope its identity is stable, so the inputs keep focus while typing.
function Row({ li, sectionKey, locked, setRow, rmRow }) {
  return (
    <div className="grid grid-cols-[1fr_120px_72px_110px_28px] gap-2 items-center min-w-[560px]">
      <div className="relative">
        <TextInput value={li.type} onChange={v => setRow(sectionKey, li.id, { type: v })} disabled={locked}
          list={locked ? undefined : 'charge-types'} className={locked ? 'opacity-70' : ''} />
        {locked && <Lock className="w-3 h-3 absolute right-2.5 top-1/2 -translate-y-1/2" style={{ color: T.dim }} />}
      </div>
      <MoneyInput value={li.costPerUnit} onChange={v => setRow(sectionKey, li.id, { costPerUnit: v })} disabled={locked} />
      <TextInput value={li.units} onChange={v => setRow(sectionKey, li.id, { units: v.replace(/[^0-9]/g, '') })} numeric disabled={locked} />
      <div className="text-[13px] font-semibold tabular-nums text-right pr-1" style={{ color: li.discount ? T.warn : T.text }}>
        {li.discount ? '−' : ''}{fmtMoney(lineTotal(li))}
      </div>
      {!locked
        ? <button onClick={() => rmRow(sectionKey, li.id)} title="Remove"
            className="w-6 h-6 rounded-md flex items-center justify-center transition-colors" style={{ color: '#dc2626' }}
            onMouseOver={e => e.currentTarget.style.background = 'rgba(217,138,122,0.12)'}
            onMouseOut={e => e.currentTarget.style.background = 'transparent'}>
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        : <span />}
    </div>
  )
}

function HeaderRow() {
  return (
    <div className="grid grid-cols-[1fr_120px_72px_110px_28px] gap-2 px-0.5 min-w-[560px]">
      {['Type', 'Cost / Unit', 'Units', 'Total', ''].map((h, i) => (
        <div key={i} className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${i === 3 ? 'text-right pr-1' : ''}`} style={{ color: T.dim }}>{h}</div>
      ))}
    </div>
  )
}

// Verify Customer Charges — Final Invoice (§2.4 item 11).
export default function InvoiceBlock({ invoice, onChange }) {
  const set = (patch) => onChange({ ...invoice, ...patch })
  const setRow = (key, id, patch) =>
    set({ [key]: invoice[key].map(li => li.id === id ? { ...li, ...patch } : li) })
  const rmRow = (key, id) => set({ [key]: invoice[key].filter(li => li.id !== id) })

  const addCost = () => set({ additionalCosts: [...invoice.additionalCosts, { id: uid(), type: 'Copy Costs', costPerUnit: '', units: 1 }] })
  const addDiscount = () => set({ additionalCosts: [...invoice.additionalCosts, { id: uid(), type: 'Discount', costPerUnit: '', units: 1, discount: true }] })

  const servicesTotal = sum(invoice.services)
  const addlTotal = invoice.additionalCosts.reduce((a, li) => a + (li.discount ? -1 : 1) * lineTotal(li), 0)
  const final = servicesTotal + addlTotal
  const cancelCharge = invoice.chargeOnCancel ? invoice.additionalCosts.reduce((a, li) => a + (li.discount ? 0 : lineTotal(li)), 0) : 0

  return (
    <div className="rounded-lg p-3.5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <datalist id="charge-types">{CHARGE_TYPES.map(t => <option key={t} value={t} />)}</datalist>
      <div className="overflow-x-auto">
        <div className="text-[11px] font-semibold uppercase tracking-[0.12em] mb-2" style={{ color: T.faint }}>Services</div>
        <HeaderRow />
        <div className="space-y-1.5 mt-1.5">{invoice.services.map(li => <Row key={li.id} li={li} sectionKey="services" locked={li.locked} setRow={setRow} rmRow={rmRow} />)}</div>

        {invoice.additionalCosts.length > 0 && (
          <>
            <div className="text-[11px] font-semibold uppercase tracking-[0.12em] mt-4 mb-1.5" style={{ color: T.faint }}>Additional Costs</div>
            <div className="space-y-1.5">{invoice.additionalCosts.map(li => <Row key={li.id} li={li} sectionKey="additionalCosts" setRow={setRow} rmRow={rmRow} />)}</div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2 mt-3">
        <FooterBtn icon={Plus} onClick={addCost}>Add Cost</FooterBtn>
        <FooterBtn icon={Tag} onClick={addDiscount}>Add Discount</FooterBtn>
      </div>

      <div className="h-px my-3.5" style={{ background: T.borderSoft }} />

      <label className="flex items-start gap-2.5 cursor-pointer">
        <input type="checkbox" checked={invoice.chargeOnCancel} onChange={e => set({ chargeOnCancel: e.target.checked })}
          className="w-4 h-4 rounded mt-0.5 flex-shrink-0" style={{ accentColor: T.accent }} />
        <div>
          <div className="text-[13px]" style={{ color: T.muted }}>Charge additional costs regardless of cancellation</div>
          <div className="text-[12px] tabular-nums mt-0.5" style={{ color: invoice.chargeOnCancel ? T.warn : T.dim }}>
            Customer will be charged {fmtMoney(cancelCharge)} if cancelled.
          </div>
        </div>
      </label>

      <div className="text-[11px] mt-3" style={{ color: T.dim }}>Do not add sales tax — it is applied automatically at delivery.</div>

      <div className="flex items-center justify-between mt-3 pt-3 border-t" style={{ borderColor: T.borderSoft }}>
        <span className="text-[11px] font-semibold uppercase tracking-[0.12em]" style={{ color: T.faint }}>Final Billable Amount</span>
        <span className="text-[20px] font-bold tabular-nums" style={{ color: T.text }}>{fmtMoney(final)}</span>
      </div>
    </div>
  )
}

function FooterBtn({ icon: Icon, onClick, children }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors"
      style={{ color: T.muted, border: `1px solid ${T.border}` }}
      onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
      <Icon className="w-3.5 h-3.5" /> {children}
    </button>
  )
}
