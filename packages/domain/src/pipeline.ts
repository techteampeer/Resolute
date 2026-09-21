// Portable order pipeline + state machine.
//
// No React, no I/O, no Supabase — pure functions and types only, so this module
// is shared unchanged by the web app today and by the ops/client apps and the
// mobile client later, and it survives the GCP move. This is the extraction of
// the logic that used to live inside src/context/OrderContext.jsx and
// src/data/mockData.js (see docs/ARCHITECTURE-ROADMAP.md, workstream B).

// The four pipeline stages, in fixed order. Admin chooses WHO performs each
// role; the order of the roles themselves never changes.
export type StageRole = 'screener' | 'examiner' | 'typer' | 'delivery'

// Who an order can be assigned to: a pipeline stage, the Admin approval queue,
// the end-to-end single-seating desk ('operator' today; being renamed 'user'),
// or nobody (completed / unassigned).
export type Assignee = StageRole | 'admin' | 'operator' | 'user' | null

export type Status =
  | 'received' | 'screening' | 'searching' | 'examining'
  | 'typing' | 'delivery' | 'delivered' | 'onhold' | 'cancelled'

// The order shape the state machine reads/writes. Deliberately permissive: an
// app order row carries many more fields, which pass through untouched.
export interface Order {
  id: string
  status: Status | string
  assignedTo: Assignee | string
  progress?: number
  completed?: string | null
  completedDates?: Record<string, string>
  completedBy?: Record<string, string>
  workflow?: Record<string, any>
  [k: string]: any
}

export const ROLE_SEQUENCE: StageRole[] = ['screener', 'examiner', 'typer', 'delivery']

// The next role that still needs to act on an order (null once all four done).
export const nextRoleFor = (order: Pick<Order, 'completedDates'>): StageRole | null =>
  ROLE_SEQUENCE.find(r => !(order.completedDates && order.completedDates[r])) || null

// The role that FOLLOWS a just-completed stage (null after delivery). Distinct
// from nextRoleFor: handoffs follow the fixed sequence, so they only ever move
// forward — using the first-incomplete stage here would route an order backwards.
export const roleAfter = (role: StageRole): StageRole | null => {
  const i = ROLE_SEQUENCE.indexOf(role)
  return i === -1 || i === ROLE_SEQUENCE.length - 1 ? null : ROLE_SEQUENCE[i + 1]
}

// The single source of truth for status: it follows the owning role.
// null role (all stages done) -> 'delivered'.
export const statusForRole = (role: StageRole | null): Status =>
  role === null
    ? 'delivered'
    : (({ screener: 'screening', examiner: 'examining', typer: 'typing', delivery: 'delivery' } as const)[role] || 'received')

// The 0-100 progress ramp. 'received' shows a token 5%.
export const PIPELINE: string[] = ['received', 'screening', 'examining', 'typing', 'delivery', 'delivered']
export const progressFor = (status: string): number => {
  const i = PIPELINE.indexOf(status)
  return i <= 0 ? (status === 'received' ? 5 : 0) : Math.round((i / (PIPELINE.length - 1)) * 100)
}

// Human stage label for the activity log (examiner -> 'examination', distinct
// from the 'examining' status).
export const STAGE_BY_ROLE: Record<StageRole, string> =
  { screener: 'screening', examiner: 'examination', typer: 'typing', delivery: 'delivery' }

// Progress DERIVED from terminal state rather than trusting the stored column,
// which can lag: a delivered order must never read "80% complete".
export const orderProgress = (order?: Order | null): number => {
  if (!order) return 0
  if (order.status === 'cancelled') return 0
  if (order.status === 'delivered' || order.completed) return 100
  return Math.min(100, Math.max(0, Number(order.progress) || 0))
}

export const isOrderComplete = (order?: Order | null): boolean =>
  !!order && (order.status === 'delivered' || !!order.completed)

export const todayISO = (): string => new Date().toISOString().slice(0, 10)
