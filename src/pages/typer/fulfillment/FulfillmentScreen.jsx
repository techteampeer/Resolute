import React, { useState, useEffect, useMemo } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { motion, AnimatePresence } from 'framer-motion'
import {
  ArrowLeft, MoreHorizontal, Check, Circle, AlertTriangle, ChevronDown, Plus, Minus,
  MapPin, Building2, User, MessageSquare, FileText, Sparkles, Send, Cloud, RotateCcw, Download,
} from 'lucide-react'
import { useOrders } from '../../../context/OrderContext'
import { useAuth } from '../../../context/AuthContext'
import { useFulfillmentStore } from '../../../context/FulfillmentContext'
import { displayClient, clientByName } from '../../../data/mockData'
import {
  completeness, titleVestingAuto, fmtDateTime, uid,
} from '../../../data/fulfillment'
import { T, Label, TextInput, TextArea, DateInput, RoundBtn, AccentButton, GhostButton } from './ui'
import DeedTabs from './DeedTabs'
import AttachedDocs from '../../../components/AttachedDocs'
import OrderMessages from '../../../components/OrderMessages'
import { CommitmentDocumentModal } from '../../../components/CommitmentDocument'
import { commitmentPdfBlob, commitmentFileName } from '../../../lib/commitmentPdf'
import { FileDropZone, FileRow, makeFileRef } from './FileDrop'
import RequirementsSection from './RequirementsSection'
import ExceptionsSection from './ExceptionsSection'
import InvoiceBlock from './InvoiceBlock'
import { SearchInformation, AssessmentTax, JudgmentsLiens, TextLineList, DisclaimerBlock } from './ReportSections'
import { isSupabaseConfigured, uploadDocument } from '../../../lib/backend'

const TABS = ['Overview', 'Fulfillment', 'Activity', 'Inbox', 'Files']

export default function FulfillmentScreen() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { user } = useAuth()
  const { orders, updateOrder } = useOrders()
  const { byOrder, ensure, update, save } = useFulfillmentStore()
  const order = orders.find(o => o.id === id)
  const [tab, setTab] = useState('Fulfillment')

  useEffect(() => { if (order) ensure(order) }, [order, ensure])
  const f = order ? byOrder[id] : null

  if (!order) return <div className="p-6 text-sm" style={{ color: T.muted }}>Order not found. <button className="underline" onClick={() => navigate(-1)}>Back to queue</button></div>
  if (!f) return <div className="p-6 text-sm" style={{ color: T.muted }}>Loading…</div>

  const set = (recipe) => update(id, recipe)
  const comp = completeness(f)

  return (
    <div className="-m-4 md:-m-6">
      {/* Order header */}
      <div className="px-5 md:px-7 pt-4 pb-0 border-b" style={{ borderColor: T.borderSoft, background: 'rgba(255,255,255,0.4)' }}>
        <button onClick={() => navigate(-1)}
          className="inline-flex items-center gap-1.5 text-[12px] mb-3 transition-colors" style={{ color: T.faint }}
          onMouseOver={e => e.currentTarget.style.color = T.text} onMouseOut={e => e.currentTarget.style.color = T.faint}>
          <ArrowLeft className="w-3.5 h-3.5" /> Queue
        </button>
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <h1 className="text-[22px] font-bold font-mono tracking-tight" style={{ color: T.text }}>{order.id}</h1>
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em] px-2 py-0.5 rounded-full"
                style={{ color: T.accentBright, background: 'rgba(124,191,78,0.14)', border: `1px solid ${T.borderStrong}` }}>Open</span>
              {order.priority === 'rush' &&
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full" style={{ background: 'rgba(220,80,60,0.18)', color: '#dc2626' }}>RUSH</span>}
            </div>
            <div className="text-[13px] mt-1 flex items-center gap-1.5 flex-wrap" style={{ color: T.faint }}>
              <span style={{ color: T.muted }}>{order.type}</span>
              <span>·</span>
              <span>{displayClient(order.client, user)}</span>
              <span>·</span>
              <button className="transition-colors" style={{ color: T.accentBright }}>Follow-up to #{order.id.replace(/\d+$/, m => String(+m - 1))}</button>
            </div>
          </div>
          <ActionsMenu />
        </div>

        {/* Tabs */}
        <div className="flex flex-nowrap items-center gap-1 mt-4 -mb-px overflow-x-auto">
          {TABS.map(t => {
            const on = t === tab
            return (
              <button key={t} onClick={() => setTab(t)}
                className="px-3 py-2.5 text-[13px] font-medium transition-colors relative flex-shrink-0 whitespace-nowrap"
                style={{ color: on ? T.text : T.faint }}>
                {t}
                {on && <motion.div layoutId="tabunderline" className="absolute left-0 right-0 -bottom-px h-0.5" style={{ background: T.accentBright }} />}
              </button>
            )
          })}
        </div>
      </div>

      {tab === 'Fulfillment'
        ? <FulfillmentBody {...{ order, f, set, comp, save, user, updateOrder, navigate }} />
        : tab === 'Overview'
        ? <OverviewTab order={order} f={f} user={user} />
        : tab === 'Inbox'
        ? <div className="px-5 md:px-7 py-5 max-w-[860px]"><OrderMessages order={order} accent={T.accentBright} /></div>
        : <StubTab name={tab} order={order} user={user} />}
    </div>
  )
}

// ── Fulfillment body: two-column layout ──────────────────────────────────────
function FulfillmentBody({ order, f, set, comp, save, user, updateOrder, navigate }) {
  return (
    <div className="flex gap-6 px-5 md:px-7 py-5">
      <div className="flex-1 min-w-0 max-w-[860px]">
        <CompletenessBar comp={comp} address={f.meta.address} save={save} />
        <ImportControl order={order} set={set} />

        {/* 1 — Search Information */}
        <Section n={1} title="Search Information"
          instruction="Top-of-report metadata: order, product, property, search dates, and record owner.">
          <SearchInformation meta={f.meta} onChange={patch => set(d => ({ ...d, meta: { ...d.meta, ...patch } }))} />
        </Section>

        {/* 2 — Parcel IDs */}
        <Section id="parcels" n={2} title="Parcel IDs" done={comp.items[0].done}
          instruction="Add every parcel covered by this search. At least one is required.">
          <Parcels parcels={f.parcels} set={set} />
        </Section>

        {/* 3 — Search Effective Date */}
        <Section id="effective" n={3} title="Search Effective Date" done={comp.items[1].done}
          instruction="The search is effective through this date and time.">
          {f.searchEffectiveAt ? (
            <div className="flex items-center gap-3">
              <DateInput type="datetime-local" value={f.searchEffectiveAt} onChange={v => set(d => ({ ...d, searchEffectiveAt: v }))} className="max-w-[260px]" />
              <span className="text-[12px] tabular-nums" style={{ color: T.faint }}>{fmtDateTime(f.searchEffectiveAt)}</span>
              <GhostButton onClick={() => set(d => ({ ...d, searchEffectiveAt: '' }))}>Clear</GhostButton>
            </div>
          ) : (
            <EmptyState text="No Search Effective Date Recorded"
              action={<GhostButton icon={Plus} onClick={() => set(d => ({ ...d, searchEffectiveAt: new Date().toISOString().slice(0, 16) }))}>Add Effective Date</GhostButton>} />
          )}
        </Section>

        {/* 4 — Assessment & Tax */}
        <Section n={4} title="Assessment &amp; Tax Information" optional
          instruction="Provided as a courtesy; not proof of payment or status.">
          <AssessmentTax tax={f.tax} onChange={patch => set(d => ({ ...d, tax: { ...d.tax, ...patch } }))} />
        </Section>

        {/* 5 — Deeds */}
        <Section id="deeds" n={5} title="Deeds — Vesting &amp; Chain of Title" done={comp.items[2].done}
          instruction="One tab per deed. The first is the Vesting deed; the rest are the chain of title.">
          <DeedTabs deeds={f.deeds} onChange={deeds => set(d => ({ ...d, deeds }))} />
        </Section>

        {/* 6 — Title Vesting */}
        <Section id="vesting" n={6} title="Title Vesting" done={comp.items[3].done}>
          <TitleVesting f={f} set={set} />
        </Section>

        {/* 7 — Legal Description */}
        <Section id="legal" n={7} title="Legal Description" done={comp.items[4].done}
          instruction="Enter the full legal description. Do not reference an attached document.">
          <TextArea value={f.legalDescription} onChange={v => set(d => ({ ...d, legalDescription: v }))} rows={5}
            placeholder="All that certain piece, parcel or lot of land…" />
        </Section>

        {/* 8 — Estate Type */}
        <Section id="estate" n={8} title="Estate Type" done={comp.items[5].done}>
          <TextInput value={f.estateType} onChange={v => set(d => ({ ...d, estateType: v }))} placeholder="Fee Simple" className="max-w-[320px]" />
        </Section>

        {/* 9 — Judgments / Liens */}
        <Section n={9} title="Judgments / Liens" optional
          instruction="Open judgments and liens disclosed by the search.">
          <JudgmentsLiens items={f.judgments} onChange={judgments => set(d => ({ ...d, judgments }))} />
        </Section>

        {/* 10 — Names Searched */}
        <Section n={10} title="Names Searched" optional
          instruction="Parties searched in the public records.">
          <TextLineList items={f.namesSearched} placeholder="Name searched…" addLabel="Add Name"
            onChange={namesSearched => set(d => ({ ...d, namesSearched }))} />
        </Section>

        {/* 11 — Additional Information */}
        <Section n={11} title="Additional Information" optional>
          <TextLineList items={f.additionalInfo} placeholder="Additional note…" addLabel="Add Note"
            onChange={additionalInfo => set(d => ({ ...d, additionalInfo }))} />
        </Section>

        {/* 12 — Title Search Document */}
        <Section id="searchdoc" n={12} title="Title Search Document" done={comp.items[6].done}>
          <TitleSearchDoc order={order} f={f} set={set} />
        </Section>

        {/* 13 — Supplementary Documents */}
        <Section n={13} title="Supplementary Documents" optional
          instruction="Select any additional documents to send to the customer.">
          <Supplementary order={order} f={f} set={set} />
        </Section>

        {/* 14 — Commitment Requirements */}
        <Section n={14} title="Commitment Requirements" done={comp.items[7].done} id="requirements"
          instruction="Schedule B-I. Edit, reorder, or remove. Mortgage payoffs use the Mortgage Lien drawer.">
          <RequirementsSection
            requirements={f.requirements} noneFlag={f.requirementsNone} county={f.meta.county} hasPayoff={false}
            onChange={requirements => set(d => ({ ...d, requirements }))}
            onToggleNone={v => set(d => ({ ...d, requirementsNone: v }))} />
        </Section>

        {/* 15 — Commitment Exceptions */}
        <Section n={15} title="Commitment Exceptions" optional
          instruction="Schedule B-II. Typed exceptions open structured drawers; custom is free text.">
          <ExceptionsSection
            exceptions={f.exceptions} noneFlag={f.exceptionsNone}
            onChange={exceptions => set(d => ({ ...d, exceptions }))}
            onToggleNone={v => set(d => ({ ...d, exceptionsNone: v }))} />
        </Section>

        {/* 16 — Verify Customer Charges */}
        <Section n={16} title="Verify Customer Charges" optional>
          <InvoiceBlock invoice={f.invoice} onChange={invoice => set(d => ({ ...d, invoice }))} />
        </Section>

        {/* 17 — Disclaimer */}
        <Section n={17} title="Disclaimer" optional>
          <DisclaimerBlock value={f.disclaimer} onChange={v => set(d => ({ ...d, disclaimer: v }))} />
        </Section>

        {/* 18 — Finalize */}
        <Section n={18} title="Finalize Order" done={comp.done === comp.total}>
          <Finalize comp={comp} order={order} f={f} user={user} updateOrder={updateOrder} navigate={navigate} />
        </Section>
      </div>

      <ContextRail order={order} f={f} user={user} />
    </div>
  )
}

// ── Completeness bar ─────────────────────────────────────────────────────────
function CompletenessBar({ comp, address, save }) {
  const [open, setOpen] = useState(false)
  const missing = comp.items.filter(i => !i.done)
  const pct = Math.round((comp.done / comp.total) * 100)
  return (
    <div className="sticky top-0 z-30 -mx-1 mb-5 rounded-xl px-4 py-3 backdrop-blur"
      style={{ background: 'rgba(255,255,255,0.95)', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(16,24,40,0.06)' }}>
      <div className="flex items-center gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold tabular-nums" style={{ color: T.text }}>{comp.done} of {comp.total}</span>
            <span className="text-[13px]" style={{ color: T.faint }}>sections complete for</span>
            <span className="text-[13px] font-medium truncate" style={{ color: T.muted }}>{address}</span>
          </div>
          <div className="mt-1.5 h-1 rounded-full overflow-hidden" style={{ background: 'rgba(30,41,59,0.08)' }}>
            <motion.div className="h-full rounded-full" style={{ background: T.accentBright }} animate={{ width: `${pct}%` }} transition={{ type: 'spring', stiffness: 200, damping: 28 }} />
          </div>
        </div>
        <SaveIndicator save={save} />
        <div className="relative">
          <button onClick={() => setOpen(o => !o)} disabled={!missing.length}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors whitespace-nowrap"
            style={{ color: missing.length ? T.warn : T.accentBright, border: `1px solid ${missing.length ? 'rgba(196,164,78,0.3)' : T.borderStrong}` }}>
            {missing.length ? <><AlertTriangle className="w-3.5 h-3.5" /> What's Missing?</> : <><Check className="w-3.5 h-3.5" /> All complete</>}
          </button>
          <AnimatePresence>
            {open && missing.length > 0 && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className="absolute right-0 top-full mt-1.5 z-20 w-64 p-1.5 rounded-lg shadow-xl"
                  style={{ background: '#ffffff', border: `1px solid ${T.border}` }}>
                  <div className="text-[10px] font-semibold uppercase tracking-[0.12em] px-2 py-1" style={{ color: T.dim }}>{missing.length} incomplete</div>
                  {missing.map(m => (
                    <button key={m.key}
                      onClick={() => { document.getElementById(m.key)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); setOpen(false) }}
                      className="w-full flex items-center gap-2 text-left px-2 py-1.5 rounded-md text-[12.5px] transition-colors"
                      style={{ color: T.muted }}
                      onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
                      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
                      <Circle className="w-3 h-3" style={{ color: T.warn }} /> {m.label}
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}

function SaveIndicator({ save }) {
  return (
    <div className="flex items-center gap-1.5 text-[11px] tabular-nums" style={{ color: save === 'saving' ? T.warn : T.dim }}>
      <AnimatePresence mode="wait">
        {save === 'saving'
          ? <motion.span key="s" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5"><Cloud className="w-3.5 h-3.5 animate-pulse" /> Saving…</motion.span>
          : save === 'saved'
          ? <motion.span key="d" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-1.5"><Check className="w-3.5 h-3.5" style={{ color: T.accentBright }} /> Saved</motion.span>
          : <span />}
      </AnimatePresence>
    </div>
  )
}

// ── Import data control ──────────────────────────────────────────────────────
function ImportControl({ order, set }) {
  const { orders } = useOrders()
  const { byOrder, ensure } = useFulfillmentStore()
  const [pick, setPick] = useState('')
  const others = orders.filter(o => o.id !== order.id)

  const load = () => {
    const src = byOrder[pick]
    if (!src) return
    // Copy structured fields; leave files & meta intact.
    set(d => ({
      ...d,
      meta: { ...d.meta, recordOwner: src.meta.recordOwner, productType: src.meta.productType, searchDate: src.meta.searchDate },
      parcels: src.parcels.map(p => ({ ...p, id: uid() })),
      deeds: src.deeds.map(x => ({ ...x, id: uid() })),
      titleVesting: { ...src.titleVesting },
      legalDescription: src.legalDescription,
      estateType: src.estateType,
      tax: { ...src.tax },
      judgments: (src.judgments || []).map(x => ({ ...x, id: uid() })),
      namesSearched: (src.namesSearched || []).map(x => ({ ...x, id: uid() })),
      additionalInfo: (src.additionalInfo || []).map(x => ({ ...x, id: uid() })),
      requirements: src.requirements.map(x => ({ ...x, id: uid() })),
      exceptions: src.exceptions.map(x => ({ ...x, id: uid() })),
    }))
  }

  return (
    <div className="flex flex-wrap items-center gap-2 mb-6 rounded-lg px-3 py-2.5" style={{ background: T.card, border: `1px dashed ${T.border}` }}>
      <Download className="w-4 h-4 flex-shrink-0" style={{ color: T.faint }} />
      <span className="text-[12px] flex-shrink-0" style={{ color: T.faint }}>Import data from an existing order</span>
      <div className="relative flex-1 max-w-[260px]">
        <select value={pick} onChange={e => { setPick(e.target.value); const o = others.find(x => x.id === e.target.value); if (o) ensure(o) }}
          className="w-full appearance-none px-2.5 py-1.5 pr-8 text-[12.5px] rounded-md outline-none"
          style={{ background: T.field, border: `1px solid ${T.border}`, color: T.text, colorScheme: 'light' }}>
          <option value="">Select an order…</option>
          {others.map(o => <option key={o.id} value={o.id}>{o.id} · {o.type}</option>)}
        </select>
        <ChevronDown className="w-3.5 h-3.5 absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: T.faint }} />
      </div>
      <GhostButton onClick={load} className={!pick ? 'opacity-40 pointer-events-none' : ''}>Load Data</GhostButton>
    </div>
  )
}

// ── Section wrapper ──────────────────────────────────────────────────────────
function Section({ n, id, title, instruction, done, optional, children }) {
  return (
    <section id={id} className="mb-6 scroll-mt-24">
      <div className="flex items-center gap-2.5 mb-2.5">
        <StatusMark done={done} optional={optional} />
        <span className="text-[11px] font-semibold tabular-nums" style={{ color: T.dim }}>{String(n).padStart(2, '0')}</span>
        <h2 className="text-[15px] font-semibold" style={{ color: T.text }}>{title}</h2>
        {optional && <span className="text-[10px] uppercase tracking-[0.12em] px-1.5 py-0.5 rounded" style={{ color: T.dim, background: 'rgba(30,41,59,0.04)' }}>Optional</span>}
      </div>
      {instruction && <p className="text-[12px] mb-3 -mt-1 ml-[26px]" style={{ color: T.faint }}>{instruction}</p>}
      <div className="ml-[26px] rounded-xl p-4" style={{ background: 'rgba(30,41,59,0.02)', border: `1px solid ${T.borderSoft}` }}>
        {children}
      </div>
    </section>
  )
}

function StatusMark({ done, optional }) {
  if (optional && done === undefined)
    return <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center flex-shrink-0" style={{ border: `1.5px dashed ${T.dim}` }} />
  return done
    ? <span className="w-[18px] h-[18px] rounded-full flex items-center justify-center flex-shrink-0" style={{ background: T.accentDeep }}><Check className="w-3 h-3" style={{ color: T.text }} strokeWidth={3} /></span>
    : <span className="w-[18px] h-[18px] rounded-full flex-shrink-0" style={{ border: `2px solid ${T.warn}`, opacity: 0.7 }} />
}

function EmptyState({ text, action }) {
  return (
    <div className="flex flex-col items-center justify-center py-5 gap-2.5">
      <span className="text-[12.5px] italic" style={{ color: T.dim }}>{text}</span>
      {action}
    </div>
  )
}

// ── Section 1: Parcels ───────────────────────────────────────────────────────
function Parcels({ parcels, set }) {
  const add = () => set(d => ({ ...d, parcels: [...d.parcels, { id: uid(), value: '' }] }))
  const rm  = (pid) => set(d => ({ ...d, parcels: d.parcels.length > 1 ? d.parcels.filter(p => p.id !== pid) : d.parcels }))
  const upd = (pid, v) => set(d => ({ ...d, parcels: d.parcels.map(p => p.id === pid ? { ...p, value: v } : p) }))
  return (
    <div className="space-y-2">
      {parcels.map((p, i) => (
        <div key={p.id} className="flex items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-[0.1em] w-20 flex-shrink-0" style={{ color: T.faint }}>Parcel ID #{i + 1}</span>
          <TextInput value={p.value} onChange={v => upd(p.id, v)} placeholder="e.g. 0123-45-67-890" numeric />
          <RoundBtn icon={() => <span className="text-[15px] leading-none">−</span>} danger title="Remove parcel" onClick={() => rm(p.id)} />
        </div>
      ))}
      <GhostButton icon={Plus} onClick={add}>Add Parcel</GhostButton>
    </div>
  )
}

// ── Section 4: Title Vesting (auto from Vesting deed, overridable) ────────────
function TitleVesting({ f, set }) {
  const auto = useMemo(() => titleVestingAuto(f.deeds[0], f.meta.county), [f.deeds, f.meta.county])
  const isAuto = f.titleVesting.isAuto
  const value = isAuto ? auto : f.titleVesting.text
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.1em] flex items-center gap-1.5" style={{ color: isAuto ? T.accentBright : T.warn }}>
          <Sparkles className="w-3 h-3" /> {isAuto ? 'Auto-filled from Vesting deed' : 'Edited'}
        </span>
        {!isAuto && (
          <button onClick={() => set(d => ({ ...d, titleVesting: { ...d.titleVesting, isAuto: true } }))}
            className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors" style={{ color: T.faint }}
            onMouseOver={e => e.currentTarget.style.color = T.accentBright} onMouseOut={e => e.currentTarget.style.color = T.faint}>
            <RotateCcw className="w-3 h-3" /> Reset to auto
          </button>
        )}
      </div>
      <TextArea value={value} rows={3}
        onChange={v => set(d => ({ ...d, titleVesting: { isAuto: false, text: v, autoText: auto } }))}
        placeholder="Owner, heirs and assigns forever by deed dated…" />
    </div>
  )
}

// ── Section 7: Title Search Document (single) ────────────────────────────────
function useUploadSim(set) {
  // Returns a starter that simulates upload progress for a given file ref + patcher.
  return (refId, patch) => {
    let p = 0
    const tick = setInterval(() => {
      p = Math.min(100, p + 14 + Math.random() * 16)
      const done = p >= 100
      set(d => patch(d, refId, Math.round(p), done ? 'done' : 'uploading'))
      if (done) clearInterval(tick)
    }, 170)
  }
}

function TitleSearchDoc({ order, f, set }) {
  const sim = useUploadSim(set)
  const onFiles = async (files) => {
    const ref = makeFileRef(files[0])
    set(d => ({ ...d, titleSearchDoc: ref }))
    const patch = (extra) => set(d => ({ ...d, titleSearchDoc: d.titleSearchDoc?.id === ref.id ? { ...d.titleSearchDoc, ...extra } : d.titleSearchDoc }))
    if (isSupabaseConfigured) {
      try { const { url, path } = await uploadDocument(order.id, files[0]); patch({ progress: 100, status: 'done', url, path }) }
      catch { patch({ status: 'error' }) }
    } else {
      sim(ref.id, (d, rid, prog, status) => ({ ...d, titleSearchDoc: d.titleSearchDoc?.id === rid ? { ...d.titleSearchDoc, progress: prog, status } : d.titleSearchDoc }))
    }
  }
  const doc = f.titleSearchDoc
  return doc ? (
    <FileRow file={doc}
      onRemove={() => set(d => ({ ...d, titleSearchDoc: null }))}
      onReplace={() => set(d => ({ ...d, titleSearchDoc: null }))} />
  ) : (
    <div>
      <div className="text-[12.5px] italic mb-2.5" style={{ color: T.dim }}>No Title Search Document has been added.</div>
      <FileDropZone onFiles={onFiles} />
    </div>
  )
}

// ── Section 8: Supplementary documents (multi) ───────────────────────────────
function Supplementary({ order, f, set }) {
  const sim = useUploadSim(set)
  const patchFile = (rid, extra) => set(d => ({ ...d, supplementaryDocs: d.supplementaryDocs.map(x => x.file.id === rid ? { ...x, file: { ...x.file, ...extra } } : x) }))
  const onFiles = (files) => {
    const refs = files.map(makeFileRef)
    set(d => ({ ...d, supplementaryDocs: [...d.supplementaryDocs, ...refs.map(r => ({ file: r, sendToCustomer: true }))] }))
    refs.forEach((ref, i) => {
      if (isSupabaseConfigured) {
        uploadDocument(order.id, files[i])
          .then(({ url, path }) => patchFile(ref.id, { progress: 100, status: 'done', url, path }))
          .catch(() => patchFile(ref.id, { status: 'error' }))
      } else {
        sim(ref.id, (d, rid, prog, status) => ({ ...d, supplementaryDocs: d.supplementaryDocs.map(x => x.file.id === rid ? { ...x, file: { ...x.file, progress: prog, status } } : x) }))
      }
    })
  }
  const docs = f.supplementaryDocs
  const allOn = docs.length > 0 && docs.every(d => d.sendToCustomer)
  const toggleAll = () => set(d => ({ ...d, supplementaryDocs: d.supplementaryDocs.map(x => ({ ...x, sendToCustomer: !allOn })) }))
  const toggle = (rid, v) => set(d => ({ ...d, supplementaryDocs: d.supplementaryDocs.map(x => x.file.id === rid ? { ...x, sendToCustomer: v } : x) }))
  const remove = (rid) => set(d => ({ ...d, supplementaryDocs: d.supplementaryDocs.filter(x => x.file.id !== rid) }))

  return (
    <div className="space-y-3">
      {docs.length > 0 && (
        <>
          <label className="flex items-center gap-2 text-[12px] cursor-pointer w-fit" style={{ color: T.faint }}>
            <input type="checkbox" checked={allOn} onChange={toggleAll} className="w-3.5 h-3.5 rounded" style={{ accentColor: T.accent }} />
            Select All — send to customer
          </label>
          <div className="space-y-2">
            {docs.map(d => (
              <FileRow key={d.file.id} file={d.file} checkbox checked={d.sendToCustomer}
                onCheck={v => toggle(d.file.id, v)} onRemove={() => remove(d.file.id)} />
            ))}
          </div>
        </>
      )}
      <FileDropZone onFiles={onFiles} multiple compact />
    </div>
  )
}

// ── Section 12: Finalize ─────────────────────────────────────────────────────
function Finalize({ comp, order, f, user, updateOrder, navigate }) {
  const { returnToAdmin } = useOrders()
  const [showDoc, setShowDoc] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const missing = comp.items.filter(i => !i.done)
  const ready = missing.length === 0
  // Every stage parks with Admin for approval before the next one (CLAUDE.md);
  // typing is no exception, from either the typer portal or the Single Seating
  // desk — so this path never calls completeStep.
  const submit = async () => {
    if (!ready || submitting) return
    setSubmitting(true)
    // Stamp the final invoice total on the order — this becomes the payable
    // amount on the client Billing page (replaces the estimate).
    const lineTotal = (li) => (Number(li.costPerUnit) || 0) * (Number(li.units) || 0)
    const invoiceAmount =
      (f.invoice?.services || []).reduce((a, li) => a + lineTotal(li), 0) +
      (f.invoice?.additionalCosts || []).reduce((a, li) => a + (li.discount ? -1 : 1) * lineTotal(li), 0)
    const invoicedAt = new Date().toISOString().slice(0, 10)
    // Generate the commitment document and attach it to the order so it flows
    // to Admin and Delivery under Files, like every other stage's document.
    try {
      // BUG_011: this file is what the client downloads, so it must be a PDF.
      const blob = await commitmentPdfBlob(order, f)
      const file = new File([blob], commitmentFileName(order), { type: 'application/pdf' })
      let ref
      if (isSupabaseConfigured) {
        const { url, path } = await uploadDocument(order.id, file)
        ref = { id: uid(), name: file.name, type: 'pdf', url, path }
      } else {
        ref = { id: uid(), name: file.name, type: 'pdf', url: URL.createObjectURL(file) }
      }
      updateOrder({ ...order, workflow: { ...order.workflow, commitmentDoc: ref, invoiceAmount, invoicedAt } })
    } catch (e) {
      // Doc attach is best-effort — still stamp the invoice total.
      updateOrder({ ...order, workflow: { ...order.workflow, invoiceAmount, invoicedAt } })
    }
    returnToAdmin(order.id, 'typer', user?.name, 'Commitment typed, generated & verified')
    navigate(-1)
  }
  return (
    <div>
      {showDoc && <CommitmentDocumentModal order={order} onClose={() => setShowDoc(false)} />}
      <p className="text-[12.5px] mb-3" style={{ color: T.faint }}>
        {singleSeating
          ? 'When you submit, the order is sent to Admin for approval before delivery.'
          : 'When you submit, the order is sent to the customer for review.'}
      </p>
      {!ready && (
        <div className="rounded-lg px-3 py-2.5 mb-3 flex items-start gap-2" style={{ background: 'rgba(196,164,78,0.08)', border: '1px solid rgba(196,164,78,0.25)' }}>
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" style={{ color: T.warn }} />
          <div className="text-[12.5px]" style={{ color: T.muted }}>
            Complete {missing.length} more section{missing.length > 1 ? 's' : ''} before submitting: <span style={{ color: T.warn }}>{missing.map(m => m.label).join(', ')}</span>.
          </div>
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <GhostButton icon={FileText} onClick={() => setShowDoc(true)}>Generate Commitment Document</GhostButton>
        <AccentButton icon={Send} disabled={!ready || submitting} onClick={submit}>{submitting ? 'Generating…' : singleSeating ? 'Submit for Admin Approval' : 'Submit to Customer Review'}</AccentButton>
      </div>
    </div>
  )
}

// ── Right context rail ───────────────────────────────────────────────────────
function ContextRail({ order, f, user }) {
  const client = clientByName(order.client)
  const showName = user?.superAdmin
  return (
    <aside className="hidden xl:block w-[300px] flex-shrink-0">
      <div className="sticky top-5 space-y-4">
        <AttachedDocs workflow={order.workflow} />
        <RailCard icon={MapPin} title="Full Address">
          <div className="text-[13px] font-medium leading-snug" style={{ color: T.text }}>{f.meta.address}</div>
          <div className="text-[12px] mt-0.5" style={{ color: T.faint }}>{order.county} County, {order.state}</div>
          <Divider />
          <KV k="Purpose" v={f.meta.purpose} />
          <KV k="Buyer" v={f.meta.buyer} />
          <KV k="Seller" v={f.meta.seller} />
          <KV k="Parcel ID" v={f.parcels.find(p => p.value)?.value || '—'} mono />
          <KV k="Underwriter" v={f.meta.underwriter} />
        </RailCard>

        <RailCard icon={Building2} title="Customer">
          <div className="text-[13px] font-medium" style={{ color: T.text }}>{displayClient(order.client, user)}</div>
          {showName && client && <>
            <div className="text-[12px] mt-0.5" style={{ color: T.faint }}>{client.contact}</div>
            <div className="text-[12px] tabular-nums" style={{ color: T.faint }}>{client.phone}</div>
            <div className="text-[12px]" style={{ color: T.faint }}>{client.email}</div>
          </>}
          <button className="mt-3 w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-lg text-[12.5px] font-medium transition-colors"
            style={{ color: T.muted, border: `1px solid ${T.border}` }}
            onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
            <MessageSquare className="w-3.5 h-3.5" /> Send Message
          </button>
        </RailCard>

        <RailCard icon={FileText} title="Service">
          <div className="text-[13px] font-medium" style={{ color: T.text }}>{order.type}</div>
          <p className="text-[12px] mt-1 leading-relaxed" style={{ color: T.faint }}>
            Full title examination with a two-owner search update, commitment requirements, and exceptions prepared for the proposed insured.
          </p>
        </RailCard>
      </div>
    </aside>
  )
}

const RailCard = ({ icon: Icon, title, children }) => (
  <div className="rounded-xl p-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
    <div className="flex items-center gap-2 mb-2.5">
      <Icon className="w-3.5 h-3.5" style={{ color: T.accentBright }} />
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: T.faint }}>{title}</span>
    </div>
    {children}
  </div>
)
const KV = ({ k, v, mono }) => (
  <div className="flex items-baseline justify-between gap-3 py-1">
    <span className="text-[11px] uppercase tracking-[0.08em] flex-shrink-0" style={{ color: T.dim }}>{k}</span>
    <span className={`text-[12.5px] text-right ${mono ? 'tabular-nums font-mono' : ''}`} style={{ color: T.muted }}>{v}</span>
  </div>
)
const Divider = () => <div className="h-px my-2.5" style={{ background: T.borderSoft }} />

// ── Actions menu ─────────────────────────────────────────────────────────────
function ActionsMenu() {
  const [open, setOpen] = useState(false)
  const items = ['Print Commitment', 'Duplicate Order', 'Request Clarification', 'Put On Hold']
  return (
    <div className="relative flex-shrink-0">
      <button onClick={() => setOpen(o => !o)}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-[13px] font-medium transition-colors"
        style={{ color: T.muted, border: `1px solid ${T.border}` }}
        onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
        onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
        Actions <ChevronDown className="w-3.5 h-3.5" />
      </button>
      <AnimatePresence>
        {open && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
            <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
              className="absolute right-0 top-full mt-1.5 z-20 w-52 p-1 rounded-lg shadow-xl"
              style={{ background: '#ffffff', border: `1px solid ${T.border}` }}>
              {items.map(it => (
                <button key={it} onClick={() => setOpen(false)}
                  className="w-full text-left px-2.5 py-2 rounded-md text-[12.5px] transition-colors" style={{ color: T.muted }}
                  onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
                  onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
                  {it}
                </button>
              ))}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  )
}

// ── Overview tab — read-only summary of what the client submitted ────────────
function OverviewTab({ order, f, user }) {
  const m = f.meta || {}
  const intake = order.workflow?.intake || {}
  const Card = ({ title, children }) => (
    <div className="rounded-xl p-4 mb-4" style={{ background: T.card, border: `1px solid ${T.border}` }}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-2.5" style={{ color: T.faint }}>{title}</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1.5">{children}</div>
    </div>
  )
  const Row = ({ k, v, mono }) => (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b" style={{ borderColor: T.borderSoft }}>
      <span className="text-[11px] uppercase tracking-[0.06em] flex-shrink-0" style={{ color: T.dim }}>{k}</span>
      <span className={`text-[12.5px] text-right ${mono ? 'font-mono tabular-nums' : ''}`} style={{ color: v ? T.text : T.dim }}>{v || '—'}</span>
    </div>
  )
  return (
    <div className="px-5 md:px-7 py-5 max-w-[860px]">
      <div className="flex items-center gap-2 mb-4">
        <span className="text-[13px] font-semibold" style={{ color: T.text }}>Order details submitted by the client</span>
        {intake.source === 'email' && <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded" style={{ background: 'rgba(37,99,235,0.10)', color: '#2563eb' }}>via email</span>}
      </div>

      <Card title="Order">
        <Row k="Order No." v={order.id} mono />
        <Row k="Product / Type" v={m.productType || order.type} />
        <Row k="Customer" v={displayClient(order.client, user)} />
        <Row k="Priority" v={(order.priority || '').toUpperCase()} />
        <Row k="Status" v={order.status} />
        <Row k="ETA" v={order.eta} mono />
      </Card>

      <Card title="Property">
        <Row k="Address" v={intake.propertyAddress || m.address} />
        <Row k="State / County" v={`${m.county || order.county || ''}, ${m.state || order.state || ''}`} />
        <Row k="Parcel / APN" v={intake.parcelNumberAPN || m.parcelId} mono />
        <Row k="Purpose" v={m.purpose} />
      </Card>

      <Card title="Parties">
        <Row k="Buyer" v={m.buyer} />
        <Row k="Borrower" v={intake.borrowerName} />
        <Row k="Seller" v={m.seller} />
        <Row k="Underwriter" v={m.underwriter} />
      </Card>

      {(intake.subject || intake.from || intake.specialInstructions) && (
        <Card title="Client Message">
          <Row k="From" v={intake.from} />
          <Row k="Subject" v={intake.subject} />
          <div className="col-span-1 sm:col-span-2 pt-1">
            <span className="text-[11px] uppercase tracking-[0.06em]" style={{ color: T.dim }}>Special instructions</span>
            <p className="text-[12.5px] mt-1 leading-relaxed" style={{ color: T.muted }}>{intake.specialInstructions || '—'}</p>
          </div>
        </Card>
      )}

      <AttachedDocs workflow={order.workflow} />
    </div>
  )
}

// ── Non-Fulfillment tab stubs ────────────────────────────────────────────────
function StubTab({ name }) {
  return (
    <div className="px-5 md:px-7 py-10">
      <div className="rounded-xl p-8 text-center" style={{ background: T.card, border: `1px solid ${T.borderSoft}` }}>
        <div className="text-[14px] font-medium" style={{ color: T.muted }}>{name}</div>
        <div className="text-[12.5px] mt-1" style={{ color: T.dim }}>This tab is out of scope for the Typer build. The Fulfillment tab holds the active work.</div>
      </div>
    </div>
  )
}
