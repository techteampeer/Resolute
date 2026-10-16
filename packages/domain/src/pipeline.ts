// Portable order pipeline + state machine.
//
// No React, no I/O, no Supabase — pure functions and types only, so this module
// is shared unchanged by the web app today and by the ops/client apps and the
// mobile client later, and it survives the GCP move. This is the extraction of
// the logic that used to live inside src/context/OrderContext.jsx and
// src/data/mockData.js (see docs/ARCHITECTURE-ROADMAP.md, workstream B).

// The pipeline stages, in fixed order. Admin chooses WHO performs each role; the
// order of the roles themselves never changes. `qc` (Quality Check) is OPTIONAL
// — see OPTIONAL_STAGES / stageSequence: an order includes it only when its plan
// assigns a QC reviewer, otherwise it skips straight from typer to delivery.
export type StageRole = 'screener' | 'examiner' | 'typer' | 'qc' | 'delivery'

// Who an order can be assigned to: a pipeline stage, the Admin approval queue,
// the consolidated end-to-end production desk ('user' — the generalized Single
// Seating role), or nobody (completed / unassigned).
export type Assignee = StageRole | 'admin' | 'user' | null

export type Status =
  | 'received' | 'screening' | 'searching' | 'examining'
  | 'typing' | 'qc' | 'delivery' | 'delivered' | 'onhold' | 'cancelled'

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

export const ROLE_SEQUENCE: StageRole[] = ['screener', 'examiner', 'typer', 'qc', 'delivery']

// Stages an order includes ONLY when its stage plan assigns an owner to them.
// QC is optional: with no QC reviewer the order skips it (Typer → Delivery)
// rather than parking with Admin. A legacy order (no plan) has no QC owner, so
// it keeps the original four-stage flow unchanged.
export const OPTIONAL_STAGES: readonly StageRole[] = ['qc']

// The stages that actually apply to a given plan: the fixed sequence minus any
// optional stage left unassigned. This is the one place the "skip an empty
// optional stage" rule lives on the client; the DB guard mirrors it exactly.
export const stageSequence = (plan: StagePlan): StageRole[] =>
  ROLE_SEQUENCE.filter(r => !OPTIONAL_STAGES.includes(r) || !!plan[r])

// The effective sequence for a specific order (its plan's stageSequence).
export const stageSequenceFor = (order?: Order | null): StageRole[] =>
  stageSequence(stagePlanOf(order))

// The next role that still needs to act on an order (null once all done). Skips
// an optional stage the plan did not assign, so a QC-less order never sits at QC.
export const nextRoleFor = (order?: Order | null): StageRole | null =>
  stageSequenceFor(order).find(r => !(order?.completedDates && order.completedDates[r])) || null

// The role that FOLLOWS a just-completed stage in the ORDER's effective sequence
// (null after the final stage). Skips an unassigned optional stage, so completing
// typer on a QC-less order routes to delivery, not QC. Only ever moves forward.
export const roleAfterFor = (order: Order | null | undefined, role: StageRole): StageRole | null => {
  const seq = stageSequenceFor(order)
  const i = seq.indexOf(role)
  return i === -1 || i === seq.length - 1 ? null : seq[i + 1]
}

// The raw next role in the FULL fixed sequence, ignoring the plan / optional
// skipping. Kept for callers reasoning about the pipeline shape itself; routing
// uses roleAfterFor so optional stages skip correctly.
export const roleAfter = (role: StageRole): StageRole | null => {
  const i = ROLE_SEQUENCE.indexOf(role)
  return i === -1 || i === ROLE_SEQUENCE.length - 1 ? null : ROLE_SEQUENCE[i + 1]
}

// ── Stage plan (E2) ─────────────────────────────────────────────────────────
// The admin's routing plan for an order: WHICH production user (by id) owns each
// stage. The admin sets it ONCE at intake (workflow.stagePlan) and no production
// user can change it. Single-seating = the same id in every slot. A missing /
// empty slot parks that stage with Admin to fill. Completing a stage routes the
// order straight to the next stage's owner — no Admin gate in between. The DB
// guard (guard_order_handoff, migration 20261012000000) enforces every bit of
// this server-side; these helpers are the read model the UI shares with it.
export type StagePlan = Partial<Record<StageRole, string | null>>

export const stagePlanOf = (order?: Order | null): StagePlan => {
  const p = order?.workflow?.stagePlan
  return p && typeof p === 'object' ? (p as StagePlan) : {}
}

// A plan is "set" once any stage names an owner.
export const hasStagePlan = (order?: Order | null): boolean =>
  ROLE_SEQUENCE.some(r => !!stagePlanOf(order)[r])

// The production user the admin pre-assigned to a given stage (null if none).
export const ownerForStage = (order: Order | null | undefined, role: StageRole | null): string | null =>
  role ? (stagePlanOf(order)[role] || null) : null

// The owner of the next stage still due — who a completion routes the order to.
export const nextOwnerFor = (order?: Order | null): string | null =>
  ownerForStage(order, nextRoleFor(order ?? ({ completedDates: {} } as Order)))

// True when the plan sends the order to the same person for every remaining
// stage (single seating, whether set by the toggle or by picking one person for
// all four). Used only for labelling — routing is driven by the plan itself.
export const isSingleSeatingPlan = (order?: Order | null): boolean => {
  const plan = stagePlanOf(order)
  const seq = stageSequence(plan)           // effective stages (unassigned optional ones excluded)
  const owners = seq.map(r => plan[r]).filter(Boolean)
  return owners.length > 0 && owners.length === seq.length && new Set(owners).size === 1
}

// The single source of truth for status: it follows the owning role.
// null role (all stages done) -> 'delivered'.
export const statusForRole = (role: StageRole | null): Status =>
  role === null
    ? 'delivered'
    : (({ screener: 'screening', examiner: 'examining', typer: 'typing', qc: 'qc', delivery: 'delivery' } as const)[role] || 'received')

// The 0-100 progress ramp. 'received' shows a token 5%.
export const PIPELINE: string[] = ['received', 'screening', 'examining', 'typing', 'qc', 'delivery', 'delivered']
export const progressFor = (status: string): number => {
  const i = PIPELINE.indexOf(status)
  return i <= 0 ? (status === 'received' ? 5 : 0) : Math.round((i / (PIPELINE.length - 1)) * 100)
}

// Human stage label for the activity log (examiner -> 'examination', distinct
// from the 'examining' status).
export const STAGE_BY_ROLE: Record<StageRole, string> =
  { screener: 'screening', examiner: 'examination', typer: 'typing', qc: 'quality check', delivery: 'delivery' }

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
