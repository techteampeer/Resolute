// Canonical per-status presentation — ONE clean colour per pipeline stage.
// Single source of truth for the status badge across Admin, the Client view and
// the orders tables (Phase 2 consumes the same map, so stage colours never drift
// between screens). Hex + inline styles to match the existing table styling.
//
// Ordered to read as progression: cool at intake → warm toward delivery → green
// when done. On-hold and clarification are MODIFIERS on the badge, never stages
// of their own, so they live in their own maps below.
export const STATUS_META = {
  received:  { label: 'Received',         color: '#475569', bg: '#F1F5F9' }, // slate
  screening: { label: 'Screening',        color: '#2563EB', bg: '#EFF6FF' }, // blue
  searching: { label: 'Searching',        color: '#0369A1', bg: '#F0F9FF' }, // sky
  searchqc:  { label: 'Search QC',        color: '#7C3AED', bg: '#F5F3FF' }, // violet
  examining: { label: 'Examining',        color: '#4338CA', bg: '#EEF2FF' }, // indigo
  typing:    { label: 'Typing',           color: '#0891B2', bg: '#ECFEFF' }, // cyan
  qc:        { label: 'Typing QC',         color: '#9333EA', bg: '#FAF5FF' }, // purple
  delivery:  { label: 'Out for Delivery', color: '#0E7C90', bg: '#E4F7FB' }, // teal
  delivered: { label: 'Delivered',        color: '#15803D', bg: '#F0FDF4' }, // green
  cancelled: { label: 'Cancelled',        color: '#6B7280', bg: '#F3F4F6' }, // grey
}

// An order parked with Admin between stages: shown in place of the raw stage, so
// the column says what is actually true (nobody is "examining" it yet).
export const AWAITING_META = { label: 'Awaiting Approval', color: '#B45309', bg: '#FFFBEB' }

// Badge MODIFIERS — ride on the single stage badge, never add a second pill.
// Hold wins over clarification when (rarely) both apply.
export const HOLD_META    = { label: 'On hold',       color: '#B91C1C', bg: '#FEF2F2', ring: '#FECACA' }
export const CLARIFY_META = { label: 'Clarification', color: '#B45309', bg: '#FFFBEB', ring: '#FDE68A' }

export function statusMeta(status) {
  return STATUS_META[status] || STATUS_META.received
}
