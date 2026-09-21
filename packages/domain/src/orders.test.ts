import { describe, it, expect } from 'vitest'
import {
  ROLE_SEQUENCE, nextRoleFor, roleAfter, statusForRole, progressFor, orderProgress, isOrderComplete,
} from './pipeline'
import {
  applyAssign, applyCompleteStep, applyReturnToAdmin, applyClientCancel, applyResolveCancel,
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
  it('operator claims the order end-to-end (singleSeating)', () => {
    const next = applyAssign(order(), { queue: 'operator' })
    expect(next.assignedTo).toBe('operator')
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
