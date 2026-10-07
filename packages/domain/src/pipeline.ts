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
// the consolidated end-to-end production desk ('user' — the generalized Single
// Seating role), or nobody (completed / unassigned).
export type Assignee = StageRole | 'admin' | 'user' | null

export type Status =
  | 'received' | 'screening' | 'searching' | 'examining'
  | 'typing' | 'delivery' | 'delivered' | 'onhold' | 'cancelled'

// A single property covered by an order. An order may span several (the bulk
// "combine into one order" import); a plain single-property order carries one
// entry, or the equivalent fields at the intake root. Lives at
// workflow.intake.properties on the order.
export interface PropertyItem {
  address?: string
  city?: string
  state?: string
  county?: string
  zip?: string
  parcelId?: string
}

// A sub-order (line item) inside a GROUPED bulk order. The order moves through
// the pipeline as ONE unit owned by ONE production user (see the
// "combine into one order" bulk import), but each line is an individually
// identified search — its display id is `${orderId}-${n}` (see lineSubId).
// Lives at workflow.intake.lineItems on the parent order. A plain single-search
// order carries no lineItems (or one) and weighs 1.
export interface LineItem extends PropertyItem {
  n: number            // 1-based position; the sub-id suffix
  searchType?: string
  propertyType?: string | null
  buyer?: string
  seller?: string
  borrower?: string
  clientFileNo?: string | null
  notes?: string
}

// The line items of a grouped order (empty for a plain order). Falls back to the
// older `properties` array so orders placed before line items still read.
export const lineItemsOf = (order?: Order | null): LineItem[] => {
  const w = order?.workflow?.intake
  const items = w?.lineItems ?? w?.properties
  return Array.isArray(items) ? items : []
}

// The display id of a sub-order: parent id + 1-based position, e.g. RTS-10110-3.
export const lineSubId = (orderId: string, n: number): string => `${orderId}-${n}`

// How much an order counts toward a production user's workload. A grouped order
// of N sub-searches is N units of work; every plain order is 1. This is what
// makes the assign picker and Team Workload reflect the TRUE load, not an
// order count.
export const workloadWeight = (order?: Order | null): number => {
  const len = lineItemsOf(order).length
  return len > 1 ? len : 1
}

// The internal note attached when a partially-completed single-seating order is
// handed back to Admin for reassignment. Lives at workflow.handoff on the order.
export interface HandoffNote {
  note: string
  from?: string        // the user handing it off
  at?: string          // ISO date (todayISO)
}

// The order shape the state machine reads/writes. Deliberately permissive: an
// app order row carries many more fields, which pass through untouched.
export interface Order {
  id: string
  status: Status | string
  assignedTo: Assignee | string
  // The specific production user responsible for the order (F1's
  // assigned_user_id). null = unassigned / pool / delivered. Complements
  // assignedTo, which stays the role queue.
  assignedUserId?: string | null
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

// A production user's LIVE workload: orders they currently own that are neither
// delivered nor cancelled. Drives workload-based assignment (suggest the
// lightest queue) and admin rebalancing. Pure — the caller passes the roster of
// orders it already holds.
export const activeCountForUser = (orders: Order[] | null | undefined, userId: string): number =>
  !userId ? 0 : (orders || [])
    .filter(o => o.assignedUserId === userId && !isOrderComplete(o) && o.status !== 'cancelled')
    // Weighted: a grouped order of N sub-searches counts as N, a plain order as 1,
    // so the number reflects real work, not order count (the "correct load").
    .reduce((sum, o) => sum + workloadWeight(o), 0)

export const todayISO = (): string => new Date().toISOString().slice(0, 10)
