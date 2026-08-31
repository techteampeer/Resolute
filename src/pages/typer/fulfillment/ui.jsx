// Shared primitives for the Typer fulfillment screen.
// Dense, dark-olive, olive-green accent. Tabular numerals for data fields.
import React, { useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Plus, Minus, X, GripVertical, ChevronUp, ChevronDown } from 'lucide-react'

export const T = {
  text:        '#12284C',
  muted:       '#3D5171',
  faint:       '#5C6E8C',
  dim:         '#5C6E8C',
  accent:      '#1B34C4',
  accentDeep:  '#2441E5',
  accentBright:'#2441E5',
  warn:        '#a16207',
  border:      'rgba(36,65,229,0.14)',
  borderSoft:  'rgba(36,65,229,0.09)',
  borderStrong:'rgba(36,65,229,0.42)',
  field:       'rgba(18,40,76,0.045)',
  fieldFocus:  'rgba(18,40,76,0.08)',
  card:        'rgba(18,40,76,0.035)',
  rowHover:    'rgba(18,40,76,0.05)',
  drawerBg:    '#ffffff',
  drawerField: 'rgba(18,40,76,0.06)',
}

// ── Label ────────────────────────────────────────────────────────────────
export function Label({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between mb-1.5">
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em]" style={{ color: T.faint }}>
        {children}
      </span>
      {hint && <span className="text-[10px]" style={{ color: T.dim }}>{hint}</span>}
    </div>
  )
}

// ── Inputs ─────────────────────────────────────────────────────────────────
const baseInput = {
  width: '100%', background: T.field, border: `1px solid ${T.border}`,
  color: T.text, borderRadius: 8, outline: 'none',
}
const focusOn  = (e) => { e.currentTarget.style.borderColor = T.borderStrong; e.currentTarget.style.background = T.fieldFocus }
const focusOff = (e) => { e.currentTarget.style.borderColor = T.border;       e.currentTarget.style.background = T.field }

export function TextInput({ value, onChange, placeholder, numeric, mono, className = '', ...rest }) {
  return (
    <input
      value={value ?? ''}
      onChange={e => onChange?.(e.target.value)}
      placeholder={placeholder}
      onFocus={focusOn} onBlur={focusOff}
      className={`px-2.5 py-1.5 text-[13px] transition-colors ${numeric || mono ? 'tabular-nums' : ''} ${className}`}
      style={{ ...baseInput }}
      {...rest}
    />
  )
}

export function TextArea({ value, onChange, placeholder, rows = 3, className = '', ...rest }) {
  const ref = useRef(null)
  const grow = useCallback(() => {
    const el = ref.current; if (!el) return
    el.style.height = 'auto'; el.style.height = Math.max(el.scrollHeight, 38) + 'px'
  }, [])
  useEffect(grow, [value, grow])
  return (
    <textarea
      ref={ref}
      value={value ?? ''}
      onChange={e => { onChange?.(e.target.value); grow() }}
      placeholder={placeholder}
      rows={rows}
      onFocus={focusOn} onBlur={focusOff}
      className={`px-2.5 py-2 text-[13px] leading-relaxed resize-none transition-colors ${className}`}
      style={{ ...baseInput }}
      {...rest}
    />
  )
}

export function DateInput({ value, onChange, type = 'date', className = '', ...rest }) {
  return (
    <input
      type={type}
      value={value ?? ''}
      onChange={e => onChange?.(e.target.value)}
      onFocus={focusOn} onBlur={focusOff}
      className={`px-2.5 py-1.5 text-[13px] tabular-nums transition-colors ${className}`}
      style={{ ...baseInput, colorScheme: 'light' }}
      {...rest}
    />
  )
}

// Currency input — formats nothing live, stores raw number string.
export function MoneyInput({ value, onChange, ...rest }) {
  return (
    <div className="relative">
      <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[13px] pointer-events-none" style={{ color: T.faint }}>$</span>
      <input
        value={value ?? ''}
        onChange={e => onChange?.(e.target.value.replace(/[^0-9.]/g, ''))}
        inputMode="decimal"
        onFocus={focusOn} onBlur={focusOff}
        className="w-full pl-6 pr-2.5 py-1.5 text-[13px] tabular-nums transition-colors"
        style={{ ...baseInput }}
        {...rest}
      />
    </div>
  )
}

// ── Buttons ────────────────────────────────────────────────────────────────
export function GhostButton({ children, onClick, icon: Icon, className = '', ...rest }) {
  return (
    <button onClick={onClick}
      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-[12px] font-medium transition-colors ${className}`}
      style={{ color: T.muted, border: `1px solid ${T.border}`, background: 'transparent' }}
      onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.muted }}
      {...rest}>
      {Icon && <Icon className="w-3.5 h-3.5" />} {children}
    </button>
  )
}

export function AccentButton({ children, onClick, icon: Icon, disabled, className = '', ...rest }) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 px-3.5 py-2 rounded-lg text-[13px] font-semibold transition-all ${className}`}
      style={{ background: disabled ? 'rgba(36,65,229,0.35)' : T.accentDeep, color: disabled ? T.faint : '#FFFFFF', cursor: disabled ? 'not-allowed' : 'pointer' }}
      onMouseOver={e => { if (!disabled) e.currentTarget.style.background = T.accent }}
      onMouseOut={e => { if (!disabled) e.currentTarget.style.background = T.accentDeep }}
      {...rest}>
      {Icon && <Icon className="w-4 h-4" />} {children}
    </button>
  )
}

// Round +/− repeater control.
export function RoundBtn({ icon: Icon = Plus, onClick, title, danger, ...rest }) {
  return (
    <button onClick={onClick} title={title}
      className="w-6 h-6 rounded-md flex items-center justify-center transition-colors flex-shrink-0"
      style={{ border: `1px solid ${T.border}`, color: danger ? '#dc2626' : T.muted, background: 'transparent' }}
      onMouseOver={e => { e.currentTarget.style.background = danger ? 'rgba(217,138,122,0.12)' : T.rowHover }}
      onMouseOut={e => { e.currentTarget.style.background = 'transparent' }}
      {...rest}>
      <Icon className="w-3.5 h-3.5" />
    </button>
  )
}
export { Plus, Minus, X, GripVertical, ChevronUp, ChevronDown }

// ── Drawer primitive ─────────────────────────────────────────────────────────
// Right slide-over, deeper-than-form surface, focus-trapped, ESC to close.
export function Drawer({ open, onClose, title, subtitle, children, footer, width = 480 }) {
  const panelRef = useRef(null)
  const lastFocus = useRef(null)

  useEffect(() => {
    if (!open) return
    lastFocus.current = document.activeElement
    const panel = panelRef.current
    const focusables = () => panel.querySelectorAll(
      'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
    )
    // Focus first field after the close button.
    const t = setTimeout(() => { const f = focusables(); (f[1] || f[0])?.focus() }, 60)

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
      if (e.key === 'Tab') {
        const f = focusables(); if (!f.length) return
        const first = f[0], last = f[f.length - 1]
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus() }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus() }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); lastFocus.current?.focus?.() }
  }, [open, onClose])

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label={title}>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="absolute inset-0" style={{ background: 'rgba(0,0,0,0.55)' }}
            onClick={onClose} />
          <motion.div
            ref={panelRef}
            initial={{ x: width + 40 }} animate={{ x: 0 }} exit={{ x: width + 40 }}
            transition={{ type: 'spring', damping: 32, stiffness: 320 }}
            className="absolute top-0 right-0 h-full flex flex-col"
            style={{ width, maxWidth: '94vw', background: T.drawerBg, borderLeft: `1px solid ${T.border}`, boxShadow: '-24px 0 60px rgba(0,0,0,0.5)' }}>
            <div className="flex items-start justify-between px-5 py-4 border-b flex-shrink-0" style={{ borderColor: T.borderSoft }}>
              <div className="min-w-0">
                {subtitle && <div className="text-[10px] font-mono font-semibold uppercase tracking-[0.14em] mb-1" style={{ color: T.accentBright }}>{subtitle}</div>}
                <div className="text-[15px] font-semibold leading-tight" style={{ color: T.text }}>{title}</div>
              </div>
              <button onClick={onClose} aria-label="Close drawer"
                className="w-7 h-7 rounded-md flex items-center justify-center transition-colors flex-shrink-0"
                style={{ color: T.faint }}
                onMouseOver={e => { e.currentTarget.style.background = T.rowHover; e.currentTarget.style.color = T.text }}
                onMouseOut={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = T.faint }}>
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
            {footer && <div className="flex-shrink-0 border-t px-5 py-3" style={{ borderColor: T.borderSoft }}>{footer}</div>}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  )
}

// Live clause preview block (shared by drawers).
export function ClausePreview({ text, label = 'Generated clause' }) {
  return (
    <div className="rounded-lg p-3" style={{ background: 'rgba(36,65,229,0.06)', border: `1px solid ${T.borderSoft}` }}>
      <div className="text-[10px] font-semibold uppercase tracking-[0.12em] mb-1.5 flex items-center gap-1.5" style={{ color: T.accentBright }}>
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: T.accentBright }} /> {label}
      </div>
      <p className="text-[12.5px] leading-relaxed whitespace-pre-wrap tabular-nums" style={{ color: T.muted }}>{text}</p>
    </div>
  )
}
