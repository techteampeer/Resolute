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
import { resolveCharge } from '../src/repositories/charges.js'
import { HttpError } from '../src/errors.js'

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

// Resolve wiring (spec B1 §6). The decision itself is the database's
// (gcp_resolve_order_charge -> resolve_order_charge); what is pinned here is that
// the GCP API calls the procedure that ALSO enqueues the admin notification --
// resolve_order_charge alone mails nobody on resolute_live -- and that each
// refusal maps to the right status instead of a 500 or a false success.
// The notification rows themselves are asserted against a real database in
// charges.integration.mjs and gcp-migration.integration.mjs.

const fakeClient = ({ pending = true, visible = true, fail } = {}) => {
  const calls = []
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params })
      if (/^select workflow from public\.orders/.test(sql)) {
        return { rows: visible ? [{ workflow: { pendingCharges: [{ id: 'chg_1', status: pending ? 'pending' : 'approved' }] } }] : [] }
      }
      if (/order_charge\(/.test(sql)) {
        if (fail) throw Object.assign(new Error(fail.message || 'db error'), { code: fail.code })
        return { rows: [{}] }
      }
      return { rows: [{ id: 'RTS-1', client_code: 'CL01', workflow: {} }] } // getOrder
    },
  }
}
const statusOf = (p) => p.then(() => 200, (e) => (e instanceof HttpError ? e.status : 'unmapped'))

describe('resolveCharge (repository wiring)', () => {
  it('approve and decline go through gcp_resolve_order_charge, never resolve_order_charge alone', async () => {
    for (const decision of ['approved', 'declined']) {
      const c = fakeClient()
      const order = await resolveCharge(c, 'RTS-1', 'chg_1', decision)
      const calls = c.calls.filter((x) => /order_charge\(/.test(x.sql))
      expect(calls).toHaveLength(1)
      expect(calls[0].sql).toBe('select public.gcp_resolve_order_charge($1, $2, $3)')
      expect(calls[0].params).toEqual(['RTS-1', 'chg_1', decision])
      expect(order.id).toBe('RTS-1')
    }
  })
  it('a duplicate/replayed resolve is a 409 and never reaches the procedure', async () => {
    const c = fakeClient({ pending: false })
    expect(await statusOf(resolveCharge(c, 'RTS-1', 'chg_1', 'approved'))).toBe(409)
    expect(c.calls.some((x) => /order_charge\(/.test(x.sql))).toBe(false)
  })
  it('a concurrent loser (no pending charge left) maps to 409', async () => {
    const c = fakeClient({ fail: { code: 'P0001', message: 'resolve_order_charge: order not found, not owned, or no pending charge chg_1' } })
    expect(await statusOf(resolveCharge(c, 'RTS-1', 'chg_1', 'approved'))).toBe(409)
  })
  it('maps the procedure refusals: 42501 -> 403, 22023 -> 422; an invisible order is 404', async () => {
    expect(await statusOf(resolveCharge(fakeClient({ fail: { code: '42501' } }), 'RTS-1', 'chg_1', 'approved'))).toBe(403)
    expect(await statusOf(resolveCharge(fakeClient({ fail: { code: '22023' } }), 'RTS-1', 'chg_1', 'approved'))).toBe(422)
    expect(await statusOf(resolveCharge(fakeClient({ visible: false }), 'RTS-1', 'chg_1', 'approved'))).toBe(404)
  })
  it('a missing procedure or notification type is NOT turned into success', async () => {
    expect(await statusOf(resolveCharge(fakeClient({ fail: { code: '42883' } }), 'RTS-1', 'chg_1', 'approved'))).toBe('unmapped')
    expect(await statusOf(resolveCharge(fakeClient({ fail: { code: '55000' } }), 'RTS-1', 'chg_1', 'approved'))).toBe('unmapped')
  })
})
