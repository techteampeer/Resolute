import { describe, it, expect } from 'vitest'
import {
  ROLE_SEQUENCE, nextRoleFor, roleAfter, statusForRole, progressFor, orderProgress, isOrderComplete,
  activeCountForUser, workloadWeight, lineItemsOf, lineSubId,
} from './pipeline'
import {
  applyAssign, applyCompleteStep, applyReturnToAdmin, applyClientCancel, applyResolveCancel,
  applySingleSeatStep, applyReassign, applyPartialHandoff,
} from './orders'

const order = (o: Record<string, any> = {}) => ({
  id: 'RTS-1', status: 'received', assignedTo: 'admin', progress: 5,
  completedDates: {}, completedBy: {}, workflow: {}, ...o,
})

describe('pipeline primitives', () => {
  it('roleAfter follows the fixed sequence, null after delivery', () => {
    expect(roleAfter('screener')).toBe('examiner')
    expect(roleAfter('examiner')).toBe('typer')
    expect(roleAfter('typer')).toBe('delivery')
    expect(roleAfter('delivery')).toBeNull()
  })
  it('nextRoleFor returns the first incomplete stage', () => {
    expect(nextRoleFor({ completedDates: {} })).toBe('screener')
    expect(nextRoleFor({ completedDates: { screener: 'x', examiner: 'x' } })).toBe('typer')
    expect(nextRoleFor({ completedDates: Object.fromEntries(ROLE_SEQUENCE.map(r => [r, 'x'])) })).toBeNull()
  })
  it('statusForRole maps role -> status; null -> delivered', () => {
    expect(statusForRole('screener')).toBe('screening')
    expect(statusForRole('examiner')).toBe('examining')
    expect(statusForRole('delivery')).toBe('delivery')
    expect(statusForRole(null)).toBe('delivered')
  })
  it('progressFor: received=5, ramps to 100 at delivered', () => {
    expect(progressFor('received')).toBe(5)
    expect(progressFor('screening')).toBe(20)
    expect(progressFor('delivered')).toBe(100)
    expect(progressFor('unknown')).toBe(0)
  })
  it('orderProgress derives terminal state; ignores a lagging column', () => {
    expect(orderProgress({ id: 'x', status: 'delivery', assignedTo: null, progress: 80 } as any)).toBe(80)
    expect(orderProgress({ id: 'x', status: 'delivered', assignedTo: null, progress: 80 } as any)).toBe(100)
    expect(orderProgress({ id: 'x', status: 'typing', assignedTo: null, completed: '2026-01-01' } as any)).toBe(100)
    expect(orderProgress({ id: 'x', status: 'cancelled', assignedTo: null, progress: 60 } as any)).toBe(0)
  })
  it('isOrderComplete', () => {
    expect(isOrderComplete({ id: 'x', status: 'delivered', assignedTo: null } as any)).toBe(true)
    expect(isOrderComplete({ id: 'x', status: 'typing', assignedTo: 'typer', completed: '2026-01-01' } as any)).toBe(true)
    expect(isOrderComplete({ id: 'x', status: 'typing', assignedTo: 'typer' } as any)).toBe(false)
  })
})

describe('applyAssign', () => {
  it('user (single seating) claims the order end-to-end', () => {
    const next = applyAssign(order(), { queue: 'user' })
    expect(next.assignedTo).toBe('user')
    expect(next.workflow!.singleSeating).toBe(true)
    expect(next.status).toBe('screening') // nextRoleFor of a fresh order
  })
  it('a stage role releases into the pipeline and sets status from the role', () => {
    const next = applyAssign(order(), { queue: 'examiner', personName: 'Jordan' })
    expect(next.assignedTo).toBe('examiner')
    expect(next.workflow!.singleSeating).toBe(false)
    expect(next.status).toBe('examining')
    expect(next.examiner).toBe('Jordan')
    expect(next.progress).toBe(progressFor('examining'))
  })
})

describe('applyCompleteStep', () => {
  it('mid-pipeline moves forward to the next owner', () => {
    const { next, advancedTo } = applyCompleteStep(order({ status: 'screening', assignedTo: 'screener' }), 'screener', 'Sam')
    expect(advancedTo).toBe('examiner')
    expect(next.assignedTo).toBe('examiner')
    expect(next.status).toBe('examining')
    expect(next.completedBy!.screener).toBe('Sam')
    expect(next.completed).toBeFalsy()
  })
  it('delivery is terminal: delivered, 100%, unassigned, stamped complete', () => {
    const { next, advancedTo } = applyCompleteStep(order({ status: 'delivery', assignedTo: 'delivery' }), 'delivery', 'Morgan')
    expect(advancedTo).toBeNull()
    expect(next.status).toBe('delivered')
    expect(next.assignedTo).toBeNull()
    expect(next.progress).toBe(100)
    expect(next.completed).toBeTruthy()
  })
  it('merges extra into workflow in the same write', () => {
    const { next } = applyCompleteStep(order({ status: 'screening', assignedTo: 'screener', workflow: { a: 1 } }), 'screener', 'Sam', { searchAssignment: 'abs' })
    expect(next.workflow).toEqual({ a: 1, searchAssignment: 'abs' })
  })
})

describe('applyReturnToAdmin', () => {
  it('parks the order with Admin and never stamps completed mid-pipeline', () => {
    const { next } = applyReturnToAdmin(order({ status: 'screening', assignedTo: 'screener' }), 'screener', 'Sam', { screenerDoc: { id: 'd1' } })
    expect(next.assignedTo).toBe('admin')
    expect(next.status).toBe('examining')       // status of the next stage's owner
    expect(next.completedBy!.screener).toBe('Sam')
    expect(next.completed).toBeFalsy()
    expect(next.workflow!.screenerDoc).toEqual({ id: 'd1' })
  })
})

describe('cancellation', () => {
  it('fresh order cancels outright', () => {
    const { mode, next } = applyClientCancel(order({ status: 'received' }))
    expect(mode).toBe('cancelled')
    expect(next.status).toBe('cancelled')
    expect(next.assignedTo).toBeNull()
    expect(next.progress).toBe(0)
  })
  it('in-flight order becomes an Admin-parked request', () => {
    const { mode, next } = applyClientCancel(order({ status: 'examining', assignedTo: 'examiner' }), 'Acme')
    expect(mode).toBe('requested')
    expect(next.status).toBe('examining')        // unchanged
    expect(next.workflow!.cancelRequested).toMatchObject({ by: 'Acme' })
  })
  it('resolveCancel approve cancels; decline clears the request', () => {
    const req = order({ status: 'examining', workflow: { cancelRequested: { by: 'Acme' } } })
    expect(applyResolveCancel(req, true).status).toBe('cancelled')
    expect(applyResolveCancel(req, false).workflow!.cancelRequested).toBeNull()
    expect(applyResolveCancel(req, false).status).toBe('examining')
  })
})

describe('A3 — assignment, single-seating, reassign, handoff', () => {
  it('applyAssign to a user records the owner + single-seating', () => {
    const n = applyAssign(order(), { queue: 'user', userId: 'u1', personName: 'Priya' })
    expect(n.assignedTo).toBe('user')
    expect(n.assignedUserId).toBe('u1')
    expect(n.workflow!.singleSeating).toBe(true)
  })
  it('applyAssign to a non-user queue clears the owner', () => {
    const n = applyAssign(order({ assignedUserId: 'u1' }), { queue: 'admin' })
    expect(n.assignedTo).toBe('admin')
    expect(n.assignedUserId).toBeNull()
  })
  it('single-seat step keeps the same owner in-seat, no Admin gate', () => {
    const o = order({ assignedTo: 'user', assignedUserId: 'u1', status: 'screening', workflow: { singleSeating: true } })
    const { next, advancedTo } = applySingleSeatStep(o, 'screener', 'Priya')
    expect(advancedTo).toBe('examiner')
    expect(next.assignedTo).toBe('user')          // stays in the pool, same seat
    expect(next.assignedUserId).toBe('u1')        // same owner
    expect(next.status).toBe('examining')
    expect(next.completedDates!.screener).toBeTruthy()
    expect(next.completedBy!.screener).toBe('Priya')
  })
  it('single-seat step on delivery completes the order + clears the desk', () => {
    const o = order({ assignedTo: 'user', assignedUserId: 'u1', status: 'delivery',
      completedDates: { screener: '2026-06-01', examiner: '2026-06-02', typer: '2026-06-03' } })
    const { next, advancedTo } = applySingleSeatStep(o, 'delivery', 'Priya')
    expect(advancedTo).toBeNull()
    expect(next.assignedTo).toBeNull()
    expect(next.assignedUserId).toBeNull()
    expect(next.status).toBe('delivered')
    expect(next.completed).toBeTruthy()
    expect(next.progress).toBe(100)
  })
  it('applyReassign moves the owner, keeps the pipeline position', () => {
    const o = order({ assignedTo: 'user', assignedUserId: 'u1', status: 'examining',
      completedDates: { screener: '2026-06-01' } })
    const n = applyReassign(o, 'u2')
    expect(n.assignedUserId).toBe('u2')
    expect(n.assignedTo).toBe('user')
    expect(n.status).toBe('examining')            // unchanged — screener done, examiner next
    expect(n.completedDates!.screener).toBe('2026-06-01')
  })
  it('applyPartialHandoff parks with Admin, clears owner, records the note, stamps nothing', () => {
    const o = order({ assignedTo: 'user', assignedUserId: 'u1', status: 'examining',
      completedDates: { screener: '2026-06-01' } })
    const n = applyPartialHandoff(o, 'stuck on legal description', 'Priya')
    expect(n.assignedTo).toBe('admin')
    expect(n.assignedUserId).toBeNull()
    expect(n.status).toBe('examining')            // no stamp, position unchanged
    expect(n.completedDates!.examiner).toBeUndefined()
    expect(n.workflow!.handoff).toMatchObject({ note: 'stuck on legal description', from: 'Priya' })
  })
})

describe('activeCountForUser (F2 — workload)', () => {
  const roster = [
    order({ id: 'A', assignedUserId: 'u1', status: 'screening' }),
    order({ id: 'B', assignedUserId: 'u1', status: 'typing' }),
    order({ id: 'C', assignedUserId: 'u1', status: 'delivered', completed: '2026-09-01' }), // done — excluded
    order({ id: 'D', assignedUserId: 'u1', status: 'cancelled' }),                          // cancelled — excluded
    order({ id: 'E', assignedUserId: 'u2', status: 'examining' }),
    order({ id: 'F', assignedUserId: null, status: 'received' }),                           // unassigned
  ]
  it('counts only live orders owned by the user', () => {
    expect(activeCountForUser(roster, 'u1')).toBe(2)
    expect(activeCountForUser(roster, 'u2')).toBe(1)
  })
  it('excludes delivered and cancelled', () => {
    expect(activeCountForUser([order({ assignedUserId: 'u1', status: 'delivered' })], 'u1')).toBe(0)
    expect(activeCountForUser([order({ assignedUserId: 'u1', completed: '2026-09-01' })], 'u1')).toBe(0)
  })
  it('is safe with an empty/absent list or empty user id', () => {
    expect(activeCountForUser([], 'u1')).toBe(0)
    expect(activeCountForUser(null, 'u1')).toBe(0)
    expect(activeCountForUser(roster, '')).toBe(0)
  })
  it('weights a grouped order by its sub-order count (true load)', () => {
    const grouped = order({ id: 'G', assignedUserId: 'u3', status: 'screening',
      workflow: { intake: { lineItems: [{ n: 1 }, { n: 2 }, { n: 3 }] } } })
    const plain = order({ id: 'H', assignedUserId: 'u3', status: 'typing' })
    expect(activeCountForUser([grouped, plain], 'u3')).toBe(4) // 3 sub-searches + 1 plain
  })
})

describe('grouped bulk orders (line items + weight)', () => {
  it('lineSubId builds parent-n display ids', () => {
    expect(lineSubId('RTS-10110', 1)).toBe('RTS-10110-1')
    expect(lineSubId('RTS-10110', 3)).toBe('RTS-10110-3')
  })
  it('workloadWeight is N for a grouped order, 1 for a plain one', () => {
    expect(workloadWeight(order({ workflow: { intake: { lineItems: [{ n: 1 }, { n: 2 }] } } }))).toBe(2)
    expect(workloadWeight(order())).toBe(1)
    expect(workloadWeight(order({ workflow: { intake: { lineItems: [{ n: 1 }] } } }))).toBe(1)
  })
  it('lineItemsOf falls back to the older properties array', () => {
    expect(lineItemsOf(order({ workflow: { intake: { properties: [{ address: 'a' }, { address: 'b' }] } } })).length).toBe(2)
    expect(lineItemsOf(order()).length).toBe(0)
  })
})
