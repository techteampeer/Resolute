import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, BellOff, Zap, Sun, Check, AlertTriangle, RotateCcw, Loader2 } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import {
  isSupabaseConfigured, fetchNotificationTypes, fetchNotificationPreferences,
  saveNotificationPreference, clearNotificationPreference,
} from '../lib/backend'

// Per-user notification preferences — one screen, mounted in every staff portal.
//
// notification_types and notification_preferences, and the per-user RLS that
// protects them, have existed since the notification cycle was built, but no
// screen ever read or wrote them: `default_mode` was the only thing that decided
// anyone's mail, and the footer on every message told recipients to change it in
// "Settings → Notifications", a place that did not exist. This is that place.
//
// Clients are deliberately absent. Client contact is portal-only (CLAUDE.md), so
// no client account is ever a notification recipient and there is nothing here
// for them to set.

const MODES = [
  { key: 'immediate', label: 'Immediately', icon: Zap,     hint: 'One email per event, as it happens.' },
  { key: 'digest',    label: 'Daily digest', icon: Sun,    hint: 'Rolled into one email a day.' },
  { key: 'off',       label: 'Off',          icon: BellOff, hint: 'No email. It still appears in the portal.' },
]
const modeLabel = (key) => MODES.find(m => m.key === key)?.label || key

const T = {
  text: '#12284C', muted: '#3D5171', faint: '#5C6E8C', dim: '#9AA8BF',
  border: '#DDE3EC', ground: '#F9FBFD', warnBg: '#fffbeb', warnBd: '#fde68a', warn: '#a16207',
  errBg: 'rgba(220,38,38,0.08)', errBd: 'rgba(220,38,38,0.28)', err: '#dc2626',
  okBg: 'rgba(21,128,61,0.08)', ok: '#15803d',
}

export default function NotificationSettings({ accent = '#2441E5' }) {
  const { user } = useAuth()
  const [types, setTypes] = useState(null)          // null = still loading
  const [prefs, setPrefs] = useState({})            // { [typeKey]: mode } — only explicit choices
  const [busy, setBusy]   = useState(null)          // type key currently being written
  const [saved, setSaved] = useState(null)          // type key that just landed
  const [error, setError] = useState(null)          // { key, message }
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    if (!isSupabaseConfigured) {
      // Mock mode has no rows to read. Show the catalogue the app ships with so
      // the screen is still explorable, and say plainly that nothing persists.
      setTypes(MOCK_TYPES)
      return
    }
    let live = true
    Promise.all([fetchNotificationTypes(), fetchNotificationPreferences(user?.id)])
      .then(([t, p]) => {
        if (!live) return
        if (!t) { setLoadError('Could not load the notification catalogue.'); setTypes([]); return }
        setTypes(t)
        setPrefs(Object.fromEntries((p || []).map(r => [r.type_key, r.mode])))
      })
      .catch(e => { if (live) { setLoadError(e.message); setTypes([]) } })
    return () => { live = false }
  }, [user?.id])

  // Only the kinds of mail that can actually reach this person. default_roles
  // carries that (see 20260909010000_notification_audience_roles.sql), so the
  // routing rules stay in the database rather than being restated here.
  const mine = useMemo(
    () => (types || []).filter(t => (t.default_roles || []).includes(user?.role)),
    [types, user?.role])

  const effective = useCallback(
    (t) => prefs[t.key] || t.default_mode, [prefs])
  const isExplicit = (t) => Object.prototype.hasOwnProperty.call(prefs, t.key)

  const choose = async (t, mode) => {
    if (busy) return
    const previous = { ...prefs }
    setError(null)
    setPrefs(p => ({ ...p, [t.key]: mode }))          // optimistic
    if (!isSupabaseConfigured) return                  // mock mode: local only
    setBusy(t.key)
    const res = await saveNotificationPreference(user?.id, t.key, mode)
    setBusy(null)
    if (res.ok) { setSaved(t.key); setTimeout(() => setSaved(s => (s === t.key ? null : s)), 1800); return }
    // A refused write must not leave the new choice on screen looking accepted.
    setPrefs(previous)
    setError({ key: t.key, message: res.error })
  }

  const reset = async (t) => {
    if (busy) return
    const previous = { ...prefs }
    setError(null)
    setPrefs(p => { const n = { ...p }; delete n[t.key]; return n })
    if (!isSupabaseConfigured) return
    setBusy(t.key)
    const res = await clearNotificationPreference(user?.id, t.key)
    setBusy(null)
    if (res.ok) { setSaved(t.key); setTimeout(() => setSaved(s => (s === t.key ? null : s)), 1800); return }
    setPrefs(previous)
    setError({ key: t.key, message: res.error })
  }

  const counts = useMemo(() => {
    const c = { immediate: 0, digest: 0, off: 0 }
    mine.forEach(t => { c[effective(t)] = (c[effective(t)] || 0) + 1 })
    return c
  }, [mine, effective])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold" style={{ color: T.text }}>Notifications</h1>
        <p className="text-sm" style={{ color: T.muted }}>
          Choose how you hear about each kind of update. Everything still appears in the portal —
          this only controls email.
        </p>
      </div>

      {!isSupabaseConfigured && (
        <Notice tone="warn" icon={AlertTriangle}>
          Demo mode — there is no database connected, so these choices are not saved.
        </Notice>
      )}
      {loadError && <Notice tone="err" icon={AlertTriangle}>{loadError}</Notice>}

      {types === null ? (
        <div className="glass-card p-6 flex items-center gap-2 text-sm" style={{ color: T.faint }}>
          <Loader2 className="w-4 h-4 animate-spin" /> Loading your preferences…
        </div>
      ) : !user?.role || user.role === 'client' ? (
        <div className="glass-card p-6 text-sm" style={{ color: T.faint }}>
          Notifications are for Resolute staff. Everything about your orders reaches you in the portal.
        </div>
      ) : !mine.length ? (
        <div className="glass-card p-6 text-sm" style={{ color: T.faint }}>
          No notification types are routed to the {user.role} desk.
        </div>
      ) : (
        <>
          <div className="glass-card p-4 flex items-center gap-5 flex-wrap">
            <div className="flex items-center gap-2">
              <Bell className="w-4 h-4" style={{ color: accent }} />
              <span className="text-[13px] font-semibold" style={{ color: T.text }}>
                {mine.length} kind{mine.length === 1 ? '' : 's'} of update
                {mine.length === 1 ? ' reaches ' : ' reach '}the {user.role} desk
              </span>
            </div>
            <div className="flex items-center gap-4 text-[12px]" style={{ color: T.faint }}>
              {MODES.map(m => (
                <span key={m.key} className="flex items-center gap-1.5">
                  <m.icon className="w-3.5 h-3.5" /> {counts[m.key] || 0} {m.label.toLowerCase()}
                </span>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            {mine.map(t => {
              const current = effective(t)
              const rowError = error && error.key === t.key ? error.message : null
              return (
                <div key={t.key} className="glass-card p-4">
                  <div className="flex items-start justify-between gap-4 flex-wrap">
                    <div className="min-w-0" style={{ flex: '1 1 320px' }}>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-[14px]" style={{ color: T.text }}>{t.label}</span>
                        {!isExplicit(t) && (
                          <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded"
                            style={{ background: T.ground, border: `1px solid ${T.border}`, color: T.dim }}>
                            default
                          </span>
                        )}
                        {saved === t.key && (
                          <span className="text-[11px] font-semibold flex items-center gap-1" style={{ color: T.ok }}>
                            <Check className="w-3.5 h-3.5" /> Saved
                          </span>
                        )}
                        {busy === t.key && <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: T.dim }} />}
                      </div>
                      {t.description && (
                        <div className="text-[12.5px] mt-1 leading-snug" style={{ color: T.faint }}>{t.description}</div>
                      )}
                      <div className="text-[11.5px] mt-1.5" style={{ color: T.dim }}>
                        {isExplicit(t)
                          ? <>Your choice: {modeLabel(current)}. Resolute's default is {modeLabel(t.default_mode).toLowerCase()}.</>
                          : <>Following Resolute's default: {modeLabel(current).toLowerCase()}.</>}
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="flex" style={{ border: `1px solid ${T.border}`, borderRadius: 9, overflow: 'hidden' }}>
                        {MODES.map(m => {
                          const on = current === m.key
                          return (
                            <button key={m.key} onClick={() => choose(t, m.key)} disabled={!!busy} title={m.hint}
                              className="flex items-center gap-1.5 px-3 py-2 text-[12.5px] font-semibold transition-colors"
                              style={{
                                background: on ? `${accent}14` : '#ffffff',
                                color: on ? accent : T.faint,
                                borderLeft: m.key === MODES[0].key ? 'none' : `1px solid ${T.border}`,
                                cursor: busy ? 'not-allowed' : 'pointer',
                              }}>
                              <m.icon className="w-3.5 h-3.5" /> {m.label}
                            </button>
                          )
                        })}
                      </div>
                      <button onClick={() => reset(t)} disabled={!!busy || !isExplicit(t)}
                        title={isExplicit(t) ? "Follow Resolute's default again" : 'Already following the default'}
                        className="flex items-center gap-1.5 px-2.5 py-2 text-[12px] font-semibold"
                        style={{
                          background: 'none', border: 'none', color: isExplicit(t) ? T.faint : T.border,
                          cursor: (!busy && isExplicit(t)) ? 'pointer' : 'default',
                        }}>
                        <RotateCcw className="w-3.5 h-3.5" /> Default
                      </button>
                    </div>
                  </div>

                  {rowError && (
                    <div className="mt-3 rounded-lg px-3 py-2 text-[12px] font-medium flex items-start gap-2"
                      style={{ background: T.errBg, border: `1px solid ${T.errBd}`, color: T.err }}>
                      <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>Not saved — {rowError}. Your previous choice is still in force.</span>
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          <div className="text-[11.5px]" style={{ color: T.dim }}>
            The daily digest is sent once a day and groups everything by order, so turning a busy
            update to digest rather than off keeps it without filling your inbox.
          </div>
        </>
      )}
    </div>
  )
}

const Notice = ({ tone, icon: Icon, children }) => {
  const c = tone === 'err'
    ? { bg: T.errBg, bd: T.errBd, fg: T.err }
    : { bg: T.warnBg, bd: T.warnBd, fg: T.warn }
  return (
    <div className="rounded-xl px-4 py-3 text-[13px] font-medium flex items-start gap-2"
      style={{ background: c.bg, border: `1px solid ${c.bd}`, color: c.fg }}>
      <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" /> <span>{children}</span>
    </div>
  )
}

// The catalogue as the migrations seed it, for demo mode only. Kept beside the
// screen rather than in mockData because nothing else has any use for it.
const MOCK_TYPES = [
  { key: 'order.new', label: 'New order placed', sort_order: 10, default_mode: 'immediate', default_roles: ['admin'],
    description: 'A client submitted a new order. It is parked with Admin for confirmation.' },
  { key: 'order.assigned', label: 'Work assigned to you', sort_order: 15, default_mode: 'immediate',
    default_roles: ['screener', 'examiner', 'typer', 'delivery', 'user'],
    description: 'Admin assigned an order to your desk. Routed to the role that received it, not to Admin.' },
  { key: 'order.progress', label: 'Stage completed', sort_order: 20, default_mode: 'digest', default_roles: ['admin'],
    description: 'A production role finished its stage and handed the order on.' },
  { key: 'order.awaiting_admin', label: 'Awaiting Admin approval', sort_order: 30, default_mode: 'immediate', default_roles: ['admin'],
    description: 'An order returned to Admin and cannot advance until someone assigns it.' },
  { key: 'order.delivered', label: 'Order delivered', sort_order: 40, default_mode: 'immediate', default_roles: ['admin'],
    description: 'The completed package reached the client and the invoice was released.' },
  { key: 'order.cancel_requested', label: 'Cancellation requested', sort_order: 50, default_mode: 'immediate', default_roles: ['admin'],
    description: 'A client asked to cancel an order that is already in production.' },
  { key: 'message.client', label: 'Client message', sort_order: 60, default_mode: 'immediate', default_roles: ['admin'],
    description: 'A client wrote in the portal. Only Admins can reply.' },
]
