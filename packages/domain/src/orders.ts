// Pure order transitions — the state machine's moves. Each takes an order and
// returns the NEXT order; no setState, no persistence, no logging. The React
// context (and, later, the server RPCs and mobile) wrap these with their own
// side effects. Extracted verbatim from OrderContext.jsx to keep behavior
// identical; the only change is that the logic now lives in one portable place.
import {
  StageRole, Order, StagePlan,
  roleAfterFor, nextRoleFor, statusForRole, progressFor, todayISO, stagePlanOf, stageSequence,
} from './pipeline'

const STAGES: string[] = ['screener', 'searchqc', 'examiner', 'typer', 'qc', 'delivery']

// Where each QC stage sends a rejected order for re-work: Search QC back to the
// screener, Typing QC back to the typer — always the plan's OWN owner of that
// stage (never a free choice), so the anti-bias rule holds.
const QC_REWORK: Record<string, StageRole> = { searchqc: 'screener', qc: 'typer' }

export interface AssignParams { queue: string; personName?: string; userId?: string | null }

// Admin routes an order to a queue. Routing to the consolidated production desk
// ('user') claims it end-to-end (single seating); routing to a stage role
// releases it back into the pipeline. Status follows the owning role. When
// routing to 'user', `userId` records the specific production owner (A1/A2); any
// other queue clears the owner (the order has left the user pool).
export function applyAssign(order: Order, { queue, personName, userId }: AssignParams): Order {
  const next: Order = { ...order, assignedTo: queue }
  if (queue === 'user') {
    next.workflow = { ...order.workflow, singleSeating: true }
    next.assignedUserId = userId !== undefined ? userId : (order.assignedUserId ?? null)
  } else {
    if (STAGES.includes(queue)) next.workflow = { ...order.workflow, singleSeating: false }
    next.assignedUserId = null
  }
  if (personName) next[queue] = personName
  next.status = statusForRole((STAGES.includes(queue) ? (queue as StageRole) : nextRoleFor(order)))
  next.progress = progressFor(next.status as string)
  return next
}

// Admin moves an order to a DIFFERENT production user, keeping its pipeline
// position (cover an absence, rebalance load). Admin writes bypass the handoff
// guard, so this may set the owner directly — a production user cannot; they hand
// the order back to Admin (applyPartialHandoff) instead.
export function applyReassign(order: Order, toUserId: string): Order {
  return {
    ...order,
    assignedTo: 'user',
    assignedUserId: toUserId,
    workflow: { ...order.workflow, singleSeating: true },
    status: statusForRole(nextRoleFor(order)),
  }
}

// A production user hands a PARTIALLY-completed order back to Admin, with an
// internal note, instead of finishing it — Admin then reassigns it. Stamps no
// stage (no completion); clears the owner and parks with Admin. Handoffs route
// through Admin, never user-to-user (the DB guard enforces the same).
export function applyPartialHandoff(order: Order, note: string, fromName: string): Order {
  return {
    ...order,
    assignedTo: 'admin',
    assignedUserId: null,
    status: statusForRole(nextRoleFor(order)),
    workflow: { ...order.workflow, handoff: { note, from: fromName, at: todayISO() } },
  }
}

export interface StagePlanParams { singleSeating: boolean; plan: StagePlan }

// Admin sets an order's COURSE OF FLOW once (E2): which production user owns each
// stage. Writes the plan + the single-seating flag, routes the order to the owner
// of the stage currently due (into the `user` pool), and derives the status. If
// that stage has no owner the order parks with Admin. Admin writes bypass the
// handoff guard, so this sets the owner directly — which is exactly why a plan,
// set here, is the only way an order's owner ever moves forward.
export function applyStagePlan(order: Order, { singleSeating, plan }: StagePlanParams): Order {
  // The due stage is derived from the NEW plan's effective sequence (so an
  // unassigned optional QC slot is skipped here too), not the order's old plan.
  const due = stageSequence(plan).find(r => !(order.completedDates && order.completedDates[r])) || null
  const owner = due ? (plan[due] ?? null) : null
  const status = statusForRole(due)
  return {
    ...order,
    assignedTo: owner ? 'user' : 'admin',
    assignedUserId: owner,
    status,
    progress: Math.max(order.progress || 0, progressFor(status as string)),
    workflow: { ...order.workflow, singleSeating: !!singleSeating, stagePlan: plan },
  }
}

export interface StepResult { next: Order; advancedTo: StageRole | null }

export interface RoutedResult extends StepResult { routedTo: 'user' | 'admin' | null; nextOwnerId: string | null }

// A PLANNED order's stage completes and the order routes to the pre-assigned
// owner of the next stage (E2): in-pool to that owner (no Admin gate), or to
// Admin when the next stage has no owner to receive it, or delivered when this
// was the final stage. The patch mirrors exactly what the DB guard accepts for a
// planned order — the owner only ever advances to the plan's next-stage person.
export function applyRoutedStep(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): RoutedResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfterFor(order, role)
  const allDone = nextRole === null
  const nextStatus = statusForRole(nextRole)
  const nextOwner = nextRole ? (stagePlanOf(order)[nextRole] || null) : null
  let assignedTo: Order['assignedTo']; let assignedUserId: string | null; let routedTo: 'user' | 'admin' | null
  if (allDone) { assignedTo = null; assignedUserId = null; routedTo = null }
  else if (nextOwner) { assignedTo = 'user'; assignedUserId = nextOwner; routedTo = 'user' }
  else { assignedTo = 'admin'; assignedUserId = order.assignedUserId ?? null; routedTo = 'admin' }
  const next: Order = {
    ...order,
    status: nextStatus,
    assignedTo,
    assignedUserId,
    progress: allDone ? 100 : Math.max(order.progress || 0, progressFor(nextStatus)),
    completed: allDone ? (order.completed || todayISO()) : order.completed,
    completedDates: newDates,
    completedBy: { ...order.completedBy, [role]: userName },
    workflow: { ...order.workflow, ...extra },
  }
  return { next, advancedTo: nextRole, routedTo, nextOwnerId: nextOwner }
}

// A stage completes and the order moves forward to the next stage's owner.
// Terminal (delivery) marks the order delivered. Used for the final stage and
// for the single-seating desk continuing within itself.
export function applyCompleteStep(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): StepResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfterFor(order, role)
  const allDone = nextRole === null
  const nextStatus = statusForRole(nextRole)
  const next: Order = {
    ...order,
    status: nextStatus,
    assignedTo: nextRole,
    progress: allDone ? 100 : Math.max(order.progress || 0, progressFor(nextStatus)),
    completed: allDone ? (order.completed || todayISO()) : order.completed,
    completedDates: newDates,
    completedBy: { ...order.completedBy, [role]: userName },
    workflow: { ...order.workflow, ...extra },
  }
  return { next, advancedTo: nextRole }
}

// Single-seating: the OWNER completes a stage and CONTINUES on the same order
// with no Admin gate (A1). A non-final stage stays assigned to the same user in
// the pool; the final (delivery) stage is the terminal completion (desk cleared).
// The DB guard permits this only for a single-seated order held by its owner.
export function applySingleSeatStep(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): StepResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfterFor(order, role)
  const allDone = nextRole === null
  const nextStatus = statusForRole(nextRole)
  const next: Order = {
    ...order,
    status: nextStatus,
    assignedTo: allDone ? null : 'user',
    assignedUserId: allDone ? null : (order.assignedUserId ?? null),
    progress: allDone ? 100 : Math.max(order.progress || 0, progressFor(nextStatus)),
    completed: allDone ? (order.completed || todayISO()) : order.completed,
    completedDates: newDates,
    completedBy: { ...order.completedBy, [role]: userName },
    workflow: { ...order.workflow, ...extra },
  }
  return { next, advancedTo: nextRole }
}

// A stage completes and hands the order BACK to Admin for the next assignment —
// the approval gate between every stage. Does not stamp `completed` (only the
// terminal delivery does).
export function applyReturnToAdmin(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): StepResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfterFor(order, role)
  const nextStatus = statusForRole(nextRole)
  const next: Order = {
    ...order,
    status: nextStatus,
    assignedTo: 'admin',
    progress: nextRole === null ? 100 : Math.max(order.progress || 0, progressFor(nextStatus)),
    completedDates: newDates,
    completedBy: { ...order.completedBy, [role]: userName },
    workflow: { ...order.workflow, ...extra },
  }
  return { next, advancedTo: nextRole }
}

// QC REJECTION (corrections required). The QC reviewer sends the package back for
// re-work to the owner of the stage it checks: Search QC → the plan's SCREENER,
// Typing QC → the plan's TYPER (QC_REWORK). Always the plan's own owner, never a
// free choice, so the anti-bias rule holds. Clears that stage's stamp AND the QC
// stamp so the order is due at the re-work stage again, records the note (with the
// QC stage), and routes to the re-work owner (or Admin if the plan has none). The
// DB guard permits exactly these two shapes (see the qc-rejection allowance).
// `stage` defaults to 'qc' (Typing QC) so existing callers keep their behaviour.
export function applyQcReject(order: Order, note: string, byName: string, stage: StageRole = 'qc'): Order {
  const reworkRole = QC_REWORK[stage] || 'typer'
  const reworkOwner = stagePlanOf(order)[reworkRole] || null
  const dates = { ...order.completedDates }
  delete dates[stage]
  delete dates[reworkRole]
  const reworkStatus = statusForRole(reworkRole)
  return {
    ...order,
    status: reworkStatus,
    assignedTo: reworkOwner ? 'user' : 'admin',
    assignedUserId: reworkOwner,
    progress: progressFor(reworkStatus as string),
    completed: null,
    completedDates: dates,
    workflow: { ...order.workflow, qcReview: { result: 'rejected', note: note || '', by: byName, at: todayISO(), stage } },
  }
}

export type CancelMode = 'cancelled' | 'requested'
export interface CancelResult { next: Order; mode: CancelMode }

// Client-initiated cancellation. Policy: free until screening starts. While the
// order is still 'received' it cancels outright; once any stage is underway it
// becomes a request parked for Admin approval.
export function applyClientCancel(order: Order, actor = 'Client'): CancelResult {
  if (order.status === 'received') {
    return {
      mode: 'cancelled',
      next: { ...order, status: 'cancelled', assignedTo: null, progress: 0, workflow: { ...order.workflow, cancelRequested: null } },
    }
  }
  return {
    mode: 'requested',
    next: { ...order, workflow: { ...order.workflow, cancelRequested: { by: actor, at: todayISO() } } },
  }
}

// Admin resolves a pending cancellation request (approve = cancel the order).
export function applyResolveCancel(order: Order, approve: boolean): Order {
  return approve
    ? { ...order, status: 'cancelled', assignedTo: null, progress: 0, workflow: { ...order.workflow, cancelRequested: null } }
    : { ...order, workflow: { ...order.workflow, cancelRequested: null } }
}
