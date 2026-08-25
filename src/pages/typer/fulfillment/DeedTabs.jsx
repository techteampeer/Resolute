import React, { useState } from 'react'
import { motion } from 'framer-motion'
import { Plus, X } from 'lucide-react'
import { Label, TextInput, TextArea, DateInput, T } from './ui'
import { makeDeed, deedLabel, recInfo } from '../../../data/fulfillment'

// Deeds as tabbed, add/remove records (hard requirement §2.4 item 3).
// Tab 0 is always "Vesting"; switching tabs preserves all entry.
export default function DeedTabs({ deeds, onChange }) {
  const [active, setActive] = useState(0)
  const safeActive = Math.min(active, deeds.length - 1)
  const deed = deeds[safeActive]

  const setField = (k, v) => onChange(deeds.map((d, i) => i === safeActive ? { ...d, [k]: v } : d))
  const addDeed = () => { onChange([...deeds, makeDeed()]); setActive(deeds.length) }
  const removeDeed = (i) => {
    if (deeds.length === 1) return
    onChange(deeds.filter((_, idx) => idx !== i))
    setActive(a => (a >= i && a > 0 ? a - 1 : a))
  }

  return (
    <div>
      {/* Tab strip */}
      <div className="flex items-center gap-1 mb-3 flex-wrap">
        {deeds.map((d, i) => {
          const on = i === safeActive
          return (
            <div key={d.id} className="relative group">
              <button onClick={() => setActive(i)}
                className="flex items-center gap-2 pl-3 pr-2 py-1.5 rounded-md text-[12px] font-medium transition-colors tabular-nums"
                style={{
                  color: on ? T.text : T.faint,
                  background: on ? 'rgba(36,65,229,0.12)' : 'transparent',
                  border: `1px solid ${on ? T.borderStrong : T.border}`,
                }}>
                {deedLabel(i)}
                {deeds.length > 1 && (
                  <span onClick={e => { e.stopPropagation(); removeDeed(i) }} role="button" tabIndex={0}
                    onKeyDown={e => { if (e.key === 'Enter') { e.stopPropagation(); removeDeed(i) } }}
                    className="w-4 h-4 rounded flex items-center justify-center transition-colors"
                    style={{ color: T.dim }}
                    onMouseOver={e => { e.currentTarget.style.color = '#dc2626' }}
                    onMouseOut={e => { e.currentTarget.style.color = T.dim }}>
                    <X className="w-3 h-3" />
                  </span>
                )}
              </button>
            </div>
          )
        })}
        <button onClick={addDeed} title="Add deed"
          className="flex items-center gap-1 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors"
          style={{ color: T.muted, border: `1px dashed ${T.border}` }}
          onMouseOver={e => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.color = T.text }}
          onMouseOut={e => { e.currentTarget.style.borderColor = T.border; e.currentTarget.style.color = T.muted }}>
          <Plus className="w-3.5 h-3.5" /> Deed
        </button>
      </div>

      {/* Active deed fields */}
      <motion.div key={deed.id} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.15 }}
        className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>Deed Type</Label><TextInput value={deed.deedType} onChange={v => setField('deedType', v)} placeholder="e.g. Warranty Deed" /></div>
          <div><Label>Consideration</Label><TextInput value={deed.consideration} onChange={v => setField('consideration', v)} placeholder="$0.00" numeric /></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>Grantor</Label><TextArea value={deed.grantor} onChange={v => setField('grantor', v)} rows={2} placeholder="Grantor name(s)" /></div>
          <div><Label>Grantee</Label><TextArea value={deed.grantee} onChange={v => setField('grantee', v)} rows={2} placeholder="Grantee name(s) … their heirs and assigns" /></div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>Date of Deed</Label><DateInput value={deed.dateOfDeed} onChange={v => setField('dateOfDeed', v)} /></div>
          <div><Label>Recorded Date</Label><DateInput value={deed.recordedDate} onChange={v => setField('recordedDate', v)} /></div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div><Label>Book</Label><TextInput value={deed.book} onChange={v => setField('book', v)} numeric /></div>
          <div><Label>Page</Label><TextInput value={deed.page} onChange={v => setField('page', v)} numeric /></div>
          <div><Label>Instrument #</Label><TextInput value={deed.instrument} onChange={v => setField('instrument', v)} numeric /></div>
        </div>
        {recInfo(deed) && (
          <div className="text-[11px] tabular-nums" style={{ color: T.faint }}>
            <span className="uppercase tracking-[0.1em]" style={{ color: T.dim }}>Rec Info · </span>{recInfo(deed)}
          </div>
        )}

        <div className="flex items-center gap-3 py-0.5">
          <div className="h-px flex-1" style={{ background: T.borderSoft }} />
          <span className="text-[10px] uppercase tracking-[0.14em]" style={{ color: T.dim }}>or — registered land</span>
          <div className="h-px flex-1" style={{ background: T.borderSoft }} />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><Label>Cert. of Title #</Label><TextInput value={deed.certOfTitle} onChange={v => setField('certOfTitle', v)} numeric /></div>
          <div><Label>Document #</Label><TextInput value={deed.documentNo} onChange={v => setField('documentNo', v)} numeric /></div>
        </div>
        <div><Label>Comments</Label><TextArea value={deed.comments} onChange={v => setField('comments', v)} rows={2} placeholder="Notes on this deed…" /></div>
      </motion.div>
    </div>
  )
}
