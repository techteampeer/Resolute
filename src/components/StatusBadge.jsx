import React from 'react'
import { statusMeta, AWAITING_META, HOLD_META, CLARIFY_META } from '../lib/orderStatus'

// ONE badge per order — the current pipeline stage, colour-coded. `onHold` and
// `clarification` are MODIFIERS (a tinted ring + a short suffix on the same pill),
// never a second pill. `awaiting` shows the admin "parked for routing" state in
// place of the raw stage. Routing noise (New / Ready / Assigned / Awaiting-confirm)
// is deliberately NOT rendered here — the Assignee column already says who holds it.
export default function StatusBadge({ status, awaiting = false, onHold = false, clarification = false, size = 'md' }) {
  const base = awaiting ? AWAITING_META : statusMeta(status)
  const mod = onHold ? HOLD_META : clarification ? CLARIFY_META : null
  const pad = size === 'sm' ? '2px 8px' : '3px 10px'
  const fs = size === 'sm' ? 11 : 12
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap',
      padding: pad, borderRadius: 99, fontSize: fs, fontWeight: 600,
      background: mod ? mod.bg : base.bg,
      color: mod ? mod.color : base.color,
      border: `1px solid ${mod ? mod.ring : 'transparent'}`,
    }}>
      <span style={{ width: 6, height: 6, borderRadius: 99, flexShrink: 0,
        background: mod ? mod.color : base.color }} />
      {base.label}{mod ? ` · ${mod.label}` : ''}
    </span>
  )
}
