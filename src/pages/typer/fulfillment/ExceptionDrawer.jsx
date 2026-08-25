import React, { useState, useEffect } from 'react'
import { Plus } from 'lucide-react'
import { Drawer, Label, TextInput, TextArea, DateInput, GhostButton, AccentButton, RoundBtn, ClausePreview, T } from './ui'
import { surveyClause, platmapsClause, easementClause, exceptionText, uid } from '../../../data/fulfillment'

const Pair = ({ children }) => <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">{children}</div>

const META = {
  survey:   { title: 'Survey / Encroachment', sub: 'ENCX01 — Facts Disclosed by Survey' },
  platmaps: { title: 'Plat Maps',             sub: 'PLATX01 — Recorded Plat References' },
  easement: { title: 'Easement',              sub: 'ESMTX01 — Recorded Easement' },
}

// Structured drawer for typed Commitment Exceptions (§2.4 item 10 / §2.5).
export default function ExceptionDrawer({ open, onClose, exception, onSave }) {
  const [draft, setDraft] = useState(exception)
  useEffect(() => { if (open) setDraft(exception) }, [open, exception])
  if (!draft) return null

  const set = (k, val) => setDraft(d => ({ ...d, [k]: val }))
  const save = () => { onSave(draft); onClose() }
  const meta = META[draft.kind] || { title: 'Exception', sub: '' }

  const preview =
    draft.kind === 'survey'   ? surveyClause(draft)
  : draft.kind === 'platmaps' ? platmapsClause(draft.maps)
  : draft.kind === 'easement' ? easementClause(draft)
  : exceptionText(draft)

  // Plat-map sub-records.
  const maps = draft.maps || []
  const addMap = () => set('maps', [...maps, { id: uid(), date: '', book: '', page: '' }])
  const setMap = (id, k, v) => set('maps', maps.map(m => m.id === id ? { ...m, [k]: v } : m))
  const rmMap  = (id) => set('maps', maps.filter(m => m.id !== id))

  return (
    <Drawer open={open} onClose={onClose} title={meta.title} subtitle={meta.sub}
      footer={
        <div className="flex items-center justify-end gap-2">
          <GhostButton onClick={onClose}>Cancel</GhostButton>
          <AccentButton onClick={save}>Save to Exception</AccentButton>
        </div>
      }>
      <div className="space-y-4">
        {draft.kind === 'survey' && (
          <>
            <Pair>
              <div><Label>Survey Date</Label><DateInput value={draft.surveyDate} onChange={v => set('surveyDate', v)} /></div>
              <div><Label>Surveyor</Label><TextInput value={draft.surveyor} onChange={v => set('surveyor', v)} placeholder="Surveyor / firm" /></div>
            </Pair>
            <div>
              <Label>Encroachment Description</Label>
              <TextArea value={draft.encroachmentDescription} onChange={v => set('encroachmentDescription', v)} rows={4}
                placeholder="Describe the encroachment or fact disclosed by the survey…" />
            </div>
          </>
        )}

        {draft.kind === 'easement' && (
          <>
            <div><Label>Recorded Date</Label><DateInput value={draft.recordedDate} onChange={v => set('recordedDate', v)} /></div>
            <Pair>
              <div><Label>Book</Label><TextInput value={draft.book} onChange={v => set('book', v)} numeric /></div>
              <div><Label>Page</Label><TextInput value={draft.page} onChange={v => set('page', v)} numeric /></div>
            </Pair>
          </>
        )}

        {draft.kind === 'platmaps' && (
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: T.faint }}>Plat Maps</span>
              <RoundBtn icon={Plus} title="Add plat map" onClick={addMap} />
            </div>
            {maps.length === 0 ? (
              <div className="text-[12px] italic px-2.5 py-2 rounded-md" style={{ color: T.dim, background: 'rgba(18,40,76,0.025)' }}>No plat maps added.</div>
            ) : (
              <div className="space-y-2.5">
                {maps.map((m, i) => (
                  <div key={m.id} className="rounded-lg p-2.5" style={{ background: T.card, border: `1px solid ${T.border}` }}>
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-[10px] font-mono font-semibold" style={{ color: T.accentBright }}>MAP {i + 1}</span>
                      <RoundBtn icon={() => <span className="text-[15px] leading-none">−</span>} danger title="Remove" onClick={() => rmMap(m.id)} />
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                      <div><Label>Date</Label><DateInput value={m.date} onChange={v => setMap(m.id, 'date', v)} /></div>
                      <div><Label>Book</Label><TextInput value={m.book} onChange={v => setMap(m.id, 'book', v)} numeric /></div>
                      <div><Label>Page</Label><TextInput value={m.page} onChange={v => setMap(m.id, 'page', v)} numeric /></div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        <div className="h-px" style={{ background: T.borderSoft }} />
        <ClausePreview text={preview} label="Generated exception" />
      </div>
    </Drawer>
  )
}
