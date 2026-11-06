import React from 'react'
import { Clock } from 'lucide-react'
import { CHARGE_APPROVAL_META as M } from '../lib/orderStatus'
import { hasPendingCharges } from '../lib/billing'

// One attention chip, rendered identically everywhere: it appears only while the
// order has a fee the client still has to approve/decline, and disappears on its
// own once none is pending (hasPendingCharges is derived — nothing to clear).
// Shown ALONGSIDE the normal status badge, never replacing it.
export default function ChargeApprovalChip({ order, compact = false }) {
  if (!hasPendingCharges(order)) return null
  return (
    <span title="An additional fee is awaiting approval" style={{
      display: 'inline-flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap',
      padding: compact ? '2px 7px' : '3px 10px', borderRadius: 99,
      fontSize: compact ? 10.5 : 12, fontWeight: 600,
      background: M.bg, color: M.color, border: `1px solid ${M.ring}`,
    }}>
      <Clock style={{ width: compact ? 10 : 12, height: compact ? 10 : 12 }} /> {M.label}
    </span>
  )
}
