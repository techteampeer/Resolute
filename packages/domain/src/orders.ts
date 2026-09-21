// Pure order transitions — the state machine's moves. Each takes an order and
// returns the NEXT order; no setState, no persistence, no logging. The React
// context (and, later, the server RPCs and mobile) wrap these with their own
// side effects. Extracted verbatim from OrderContext.jsx to keep behavior
// identical; the only change is that the logic now lives in one portable place.
import {
  StageRole, Order,
  roleAfter, nextRoleFor, statusForRole, progressFor, todayISO,
} from './pipeline'

const STAGES: string[] = ['screener', 'examiner', 'typer', 'delivery']

export interface AssignParams { queue: string; personName?: string }

// Admin routes an order to a queue. Routing to the single-seating desk
// ('operator') claims it end-to-end; routing to a stage role releases it back
// into the pipeline. Status follows the owning role.
export function applyAssign(order: Order, { queue, personName }: AssignParams): Order {
  const next: Order = { ...order, assignedTo: queue }
  if (queue === 'operator') next.workflow = { ...order.workflow, singleSeating: true }
  else if (STAGES.includes(queue)) next.workflow = { ...order.workflow, singleSeating: false }
  if (personName) next[queue] = personName
  next.status = statusForRole((STAGES.includes(queue) ? (queue as StageRole) : nextRoleFor(order)))
  next.progress = progressFor(next.status as string)
  return next
}

export interface StepResult { next: Order; advancedTo: StageRole | null }

// A stage completes and the order moves forward to the next stage's owner.
// Terminal (delivery) marks the order delivered. Used for the final stage and
// for the single-seating desk continuing within itself.
export function applyCompleteStep(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): StepResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfter(role)
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

// A stage completes and hands the order BACK to Admin for the next assignment —
// the approval gate between every stage. Does not stamp `completed` (only the
// terminal delivery does).
export function applyReturnToAdmin(
  order: Order, role: StageRole, userName: string, extra: Record<string, any> = {},
): StepResult {
  const newDates = { ...order.completedDates, [role]: todayISO() }
  const nextRole = roleAfter(role)
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
