import { describe, it, expect } from 'vitest'
import {
  money, invoiceTotal, invoiceNumber, termByKey, cycleByKey, addDays,
  paymentOf, payStatusOf, isBillable, dueDate, isOverdue,
  buildPayment, confirmPayment, bouncePayment,
  isAbsAssigned, payoutOf, needsFee, buildPayout, payPayout,
  subscriptionNextDue, isSubscriptionDue,
  AMOUNT_LIMIT, isAmountInRange,
} from './money'

const CATALOGUE = { 'Full Search': 150, 'Two Owner Search': 100 }
const order = (o: Record<string, any> = {}) => ({
  id: 'RTS-1', status: 'delivered', assignedTo: null, workflow: {}, ...o,
})

describe('money formatter', () => {
  it('formats USD and coerces junk to $0.00', () => {
    expect(money(150)).toBe('$150.00')
    expect(money('150')).toBe('$150.00')
    expect(money(undefined)).toBe('$0.00')
  })
})

describe('invoiceTotal', () => {
  it('uses an explicit workflow.invoiceAmount when present', () => {
    expect(invoiceTotal(order({ type: 'Full Search', workflow: { invoiceAmount: 175 } }), { catalogue: CATALOGUE })).toBe(175)
  })
  it('coerces a stringy stored amount instead of concatenating', () => {
    expect(invoiceTotal(order({ type: 'Full Search', workflow: { invoiceAmount: '175' } }), { catalogue: CATALOGUE })).toBe(175)
  })
  it('falls back to the catalogue price, then the flat fallback', () => {
    expect(invoiceTotal(order({ type: 'Full Search' }), { catalogue: CATALOGUE })).toBe(150)
    expect(invoiceTotal(order({ type: 'Tax Search' }), { catalogue: CATALOGUE })).toBe(125)
  })
  it('adds the rush surcharge', () => {
    expect(invoiceTotal(order({ type: 'Full Search', priority: 'rush' }), { catalogue: CATALOGUE })).toBe(200)
  })
  it('invoiceNumber', () => expect(invoiceNumber({ id: 'RTS-9' })).toBe('INV-RTS-9'))
})

describe('terms / cycles defaults', () => {
  it('termByKey falls back to per_order', () => {
    expect(termByKey('net30').days).toBe(30)
    expect(termByKey(undefined).key).toBe('per_order')
    expect(termByKey('nope').key).toBe('per_order')
  })
  it('cycleByKey falls back to days30', () => {
    expect(cycleByKey('weekly').days).toBe(7)
    expect(cycleByKey('nope').key).toBe('days30')
  })
})

describe('dates / due / overdue', () => {
  it('addDays', () => expect(addDays('2026-01-01', 15)).toBe('2026-01-16'))
  it('addDays null-safe', () => expect(addDays(null, 5)).toBeNull())
  it('confirmed is never overdue', () => {
    const o = order({ completed: '2000-01-01', workflow: { payment: { status: 'confirmed' } } })
    expect(isOverdue(o, 'net30')).toBe(false)
  })
  it('a long-past due date is overdue when unpaid', () => {
    expect(isOverdue(order({ completed: '2000-01-01' }), 'net30')).toBe(true)
  })
  it('dueDate = completed + term days', () => {
    expect(dueDate(order({ completed: '2026-01-01' }), 'net15')).toBe('2026-01-16')
  })
})

describe('payment state', () => {
  it('normalizes legacy submitted -> marked', () => {
    expect(paymentOf(order({ workflow: { payment: { status: 'submitted' } } }))!.status).toBe('marked')
  })
  it('payStatusOf defaults to unpaid', () => {
    expect(payStatusOf(order())).toBe('unpaid')
  })
  it('isBillable only when delivered', () => {
    expect(isBillable(order({ status: 'delivered' }))).toBe(true)
    expect(isBillable(order({ status: 'typing' }))).toBe(false)
  })
  it('builders set the right status + fields', () => {
    const p = buildPayment({ method: 'ACH', reference: 'TR1' })
    expect(p).toMatchObject({ method: 'ACH', reference: 'TR1', status: 'marked' })
    expect(confirmPayment(p, 'Vivek')).toMatchObject({ status: 'confirmed', confirmedBy: 'Vivek' })
    expect(bouncePayment(p, 'Vivek')).toMatchObject({ status: 'bounced', confirmedBy: 'Vivek' })
  })
})

describe('vendor payouts', () => {
  it('isAbsAssigned / needsFee', () => {
    expect(isAbsAssigned(order({ workflow: { searchAssignment: 'abs' } }))).toBe(true)
    expect(isAbsAssigned(order({ workflow: { searchAssignment: 'inhouse' } }))).toBe(false)
    expect(needsFee(order({ workflow: { searchAssignment: 'both' } }))).toBe(true)
    expect(needsFee(order({ workflow: { searchAssignment: 'both', abstractorFee: { amount: 40 } } }))).toBe(false)
  })
  it('buildPayout coerces amount and accrues; payPayout marks paid', () => {
    const p = buildPayout({ vendor: 'VN01', amount: '40', userName: 'Rajni' })
    expect(p).toMatchObject({ vendor: 'VN01', amount: 40, status: 'accrued', setBy: 'Rajni' })
    expect(payPayout(p, 'Vivek', 'CHK9')).toMatchObject({ status: 'paid', paidBy: 'Vivek', reference: 'CHK9' })
  })
})

describe('isAmountInRange (F3 bound)', () => {
  it('accepts normal and negative (discount) amounts within magnitude', () => {
    expect(isAmountInRange(150)).toBe(true)
    expect(isAmountInRange(-50)).toBe(true)       // a credit / discount is legitimate
    expect(isAmountInRange(0)).toBe(true)
    expect(isAmountInRange(AMOUNT_LIMIT)).toBe(true)
  })
  it('rejects absurd magnitude and non-numbers', () => {
    expect(isAmountInRange(AMOUNT_LIMIT + 1)).toBe(false)
    expect(isAmountInRange(-AMOUNT_LIMIT - 1)).toBe(false)
    expect(isAmountInRange('lots')).toBe(false)
    expect(isAmountInRange(Infinity)).toBe(false)
  })
})

describe('subscriptions', () => {
  it('never-paid is due today; paid rolls forward one cycle', () => {
    const s = { id: 's1', name: 'x', amount: 10, cycle: 'days30' as const, lastPaidAt: null }
    expect(isSubscriptionDue(s)).toBe(true)
    expect(subscriptionNextDue({ ...s, lastPaidAt: '2026-01-01' })).toBe('2026-01-31')
  })
})
