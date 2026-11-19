// Pure unit tests for the charge domain + request validation (no DB). These run
// in the root `npm test` (vitest) because charges.js imports nothing I/O-bound —
// the same reason claims.test.js / mappers.test.js run there. The DB-backed
// behaviour (RLS, the resolve_order_charge reuse, notifications) is covered by
// __tests__/charges.integration.mjs in the db-integrity CI lane.
import { describe, it, expect } from 'vitest'
import {
  AMOUNT_LIMIT, isAmountInRange, money, raiseEventAction,
  buildPendingCharge, validateRaise, validateDecision,
} from '../src/charges.js'

describe('money / isAmountInRange', () => {
  it('formats like money.ts (en-US USD)', () => {
    expect(money(100)).toBe('$100.00')
    expect(money('45')).toBe('$45.00')
    expect(money(null)).toBe('$0.00')
  })
  it('bounds magnitude at AMOUNT_LIMIT', () => {
    expect(isAmountInRange(AMOUNT_LIMIT)).toBe(true)
    expect(isAmountInRange(AMOUNT_LIMIT + 1)).toBe(false)
    expect(isAmountInRange('abc')).toBe(false)
  })
})

describe('raiseEventAction', () => {
  it('matches the Supabase activity wording byte-for-byte (em dash)', () => {
    expect(raiseEventAction('RTS-1', 100)).toBe(
      'Additional fee of $100.00 requested on RTS-1 — awaiting approval')
  })
})

describe('validateRaise', () => {
  it('accepts a valid label + amount and coerces them', () => {
    expect(validateRaise({ label: '  extra county ', amount: '60' }))
      .toEqual({ ok: true, label: 'extra county', amount: 60 })
  })
  it('rejects an empty or whitespace label (422)', () => {
    expect(validateRaise({ label: '', amount: 10 }).ok).toBe(false)
    expect(validateRaise({ label: '   ', amount: 10 }).ok).toBe(false)
  })
  it('rejects a label over 120 chars', () => {
    expect(validateRaise({ label: 'x'.repeat(121), amount: 10 }).ok).toBe(false)
    expect(validateRaise({ label: 'x'.repeat(120), amount: 10 }).ok).toBe(true)
  })
  it('requires a positive, in-range, numeric amount', () => {
    expect(validateRaise({ label: 'a', amount: 0 }).ok).toBe(false)
    expect(validateRaise({ label: 'a', amount: -5 }).ok).toBe(false)
    expect(validateRaise({ label: 'a', amount: AMOUNT_LIMIT + 1 }).ok).toBe(false)
    expect(validateRaise({ label: 'a', amount: 'nope' }).ok).toBe(false)
    expect(validateRaise({ label: 'a', amount: 125 }).ok).toBe(true)
  })
})

describe('validateDecision', () => {
  it('accepts only approved / declined', () => {
    expect(validateDecision('approved')).toBe(true)
    expect(validateDecision('declined')).toBe(true)
    expect(validateDecision('maybe')).toBe(false)
    expect(validateDecision(undefined)).toBe(false)
  })
})

describe('buildPendingCharge', () => {
  it('owns id, status, raisedAt; coerces label + amount', () => {
    const c = buildPendingCharge({ label: '  big one  ', amount: '75', raisedBy: 'Rajni', raisedByRole: 'admin' })
    expect(c.id).toMatch(/^chg_/)
    expect(c.status).toBe('pending')
    expect(c.resolvedAt).toBeNull()
    expect(c.label).toBe('big one')
    expect(c.amount).toBe(75)
    expect(c.raisedBy).toBe('Rajni')
    expect(c.raisedByRole).toBe('admin')
    expect(c.raisedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('zeroes an out-of-range amount (mirrors money.ts buildCharge)', () => {
    expect(buildPendingCharge({ label: 'x', amount: AMOUNT_LIMIT + 1 }).amount).toBe(0)
  })
  it('falls back to a default label', () => {
    expect(buildPendingCharge({ label: '', amount: 1 }).label).toBe('Additional fee')
  })
})
