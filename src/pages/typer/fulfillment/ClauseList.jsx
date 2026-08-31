import React, { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, ChevronUp, ChevronDown, Trash2, Pencil, RotateCcw, SlidersHorizontal, Check } from 'lucide-react'
import { TextArea, T } from './ui'

// Numbered, editable, reorderable list shared by Requirements & Exceptions.
// Structured rows (mortgage, survey, …) show a generated clause + "Edit values"
// that opens a drawer; an override escape-hatch turns them into free text.
export default function ClauseList({
  items, onChange, resolveText,
  noneFlag, onToggleNone, noneLabel,
  addOptions, addLabel, onOpenDrawer,
}) {
  const [menu, setMenu] = useState(false)

  const setItem = (id, patch) => onChange(items.map(it => it.id === id ? { ...it, ...patch } : it))
  const remove  = (id) => onChange(items.filter(it => it.id !== id))
  const move = (i, dir) => {
    const j = i + dir
    if (j < 0 || j >= items.length) return
    const next = items.slice(); [next[i], next[j]] = [next[j], next[i]]; onChange(next)
  }
  const add = (opt) => {
    const item = opt.make()
    onChange([...items, item])
    setMenu(false)
    if (opt.drawer) setTimeout(() => onOpenDrawer(item), 40)
  }

  return (
    <div>
      <div className="space-y-2">
        <AnimatePresence initial={false}>
          {items.map((it, i) => {
            const structured = it.kind !== 'text'
            const editing = !structured || it.overridden
            const text = resolveText(it)
            return (
              <motion.div key={it.id}
                initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.18 }}
                className="flex gap-2.5 rounded-lg p-2.5 group"
                style={{ background: T.card, border: `1px solid ${T.border}` }}>
                {/* number + reorder */}
                <div className="flex flex-col items-center gap-1 pt-0.5 flex-shrink-0">
                  <span className="text-[12px] font-semibold tabular-nums w-5 text-center" style={{ color: T.accentBright }}>{i + 1}</span>
                  <div className="flex flex-col opacity-0 group-hover:opacity-100 transition-opacity">
                    <ReorderBtn icon={ChevronUp} onClick={() => move(i, -1)} disabled={i === 0} title="Move up" />
                    <ReorderBtn icon={ChevronDown} onClick={() => move(i, 1)} disabled={i === items.length - 1} title="Move down" />
                  </div>
                </div>

                {/* body */}
                <div className="flex-1 min-w-0">
                  {editing ? (
                    <TextArea
                      value={it.overridden ? it.overrideText : it.text}
                      onChange={v => setItem(it.id, it.overridden ? { overrideText: v } : { text: v })}
                      rows={2} />
                  ) : (
                    <div className="text-[13px] leading-relaxed whitespace-pre-wrap tabular-nums px-0.5 py-1" style={{ color: T.muted }}>{text}</div>
                  )}

                  {/* chips / actions */}
                  <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                    {structured && !it.overridden && (
                      <>
                        <Chip>Structured</Chip>
                        <RowAct icon={SlidersHorizontal} onClick={() => onOpenDrawer(it)}>Edit values</RowAct>
                        <RowAct icon={Pencil} onClick={() => setItem(it.id, { overridden: true, overrideText: text })}>Override</RowAct>
                      </>
                    )}
                    {structured && it.overridden && (
                      <>
                        <Chip warn>Edited — overrides structured</Chip>
                        <RowAct icon={RotateCcw} onClick={() => setItem(it.id, { overridden: false })}>Reset to structured</RowAct>
                      </>
                    )}
                  </div>
                </div>

                {/* remove */}
                <ReorderBtn icon={Trash2} danger onClick={() => remove(it.id)} title="Remove" className="opacity-0 group-hover:opacity-100" />
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>

      {/* footer controls */}
      <div className="flex items-center gap-2 mt-3">
        <div className="relative">
          <button onClick={() => setMenu(m => !m)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors"
            style={{ color: T.muted, border: `1px solid ${T.border}` }}
            onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
            onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
            <Plus className="w-3.5 h-3.5" /> {addLabel}
          </button>
          <AnimatePresence>
            {menu && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setMenu(false)} />
                <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }}
                  className="absolute left-0 top-full mt-1.5 z-20 w-56 p-1 rounded-lg shadow-xl"
                  style={{ background: '#ffffff', border: `1px solid ${T.border}` }}>
                  {addOptions.map(opt => (
                    <button key={opt.label} onClick={() => add(opt)}
                      className="w-full text-left px-2.5 py-2 rounded-md text-[12.5px] transition-colors"
                      style={{ color: T.muted }}
                      onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
                      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}>
                      <div className="font-medium">{opt.label}</div>
                      {opt.hint && <div className="text-[11px]" style={{ color: T.dim }}>{opt.hint}</div>}
                    </button>
                  ))}
                </motion.div>
              </>
            )}
          </AnimatePresence>
        </div>

        <button onClick={() => onToggleNone(!noneFlag)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors"
          style={{
            color: noneFlag ? T.accentBright : T.faint,
            border: `1px solid ${noneFlag ? T.borderStrong : T.border}`,
            background: noneFlag ? 'rgba(36,65,229,0.10)' : 'transparent',
          }}>
          <Check className="w-3.5 h-3.5" /> {noneLabel}
        </button>
      </div>
    </div>
  )
}

function ReorderBtn({ icon: Icon, onClick, disabled, danger, title, className = '' }) {
  return (
    <button onClick={onClick} disabled={disabled} title={title}
      className={`w-5 h-5 rounded flex items-center justify-center transition-colors flex-shrink-0 ${className}`}
      style={{ color: disabled ? T.dim : danger ? '#dc2626' : T.faint, cursor: disabled ? 'default' : 'pointer', opacity: disabled ? 0.4 : 1 }}
      onMouseOver={e => { if (!disabled) e.currentTarget.style.background = danger ? 'rgba(217,138,122,0.12)' : T.rowHover }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}>
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}

function RowAct({ icon: Icon, onClick, children }) {
  return (
    <button onClick={onClick}
      className="inline-flex items-center gap-1 text-[11px] font-medium transition-colors"
      style={{ color: T.faint }}
      onMouseOver={e => { e.currentTarget.style.color = T.accentBright }}
      onMouseOut={e => { e.currentTarget.style.color = T.faint }}>
      <Icon className="w-3 h-3" /> {children}
    </button>
  )
}

function Chip({ children, warn }) {
  return (
    <span className="text-[10px] font-semibold uppercase tracking-[0.1em] px-1.5 py-0.5 rounded"
      style={{ color: warn ? T.warn : T.accentBright, background: warn ? 'rgba(196,164,78,0.12)' : 'rgba(36,65,229,0.10)' }}>
      {children}
    </span>
  )
}
