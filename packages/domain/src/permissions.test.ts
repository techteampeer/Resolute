import { describe, it, expect } from 'vitest'
import { can, effectiveCapabilities, workableStages } from './permissions'

const caps = (p: any) => effectiveCapabilities(p).map(h => h.capability).sort()

describe('role defaults', () => {
  it('production user: work + read + note, nothing admin/money', () => {
    const u = { role: 'user' }
    expect(can(u, 'orders.work')).toBe(true)
    expect(can(u, 'orders.read')).toBe(true)
    expect(can(u, 'support.note')).toBe(true)
    expect(can(u, 'orders.assign')).toBe(false)
    expect(can(u, 'payments.confirm')).toBe(false)
    expect(can(u, 'clients.view_pii')).toBe(false)
  })
  it('plain admin: ops + users + reply, but NOT pii / payouts / money', () => {
    const a = { role: 'admin' }
    expect(can(a, 'orders.assign')).toBe(true)
    expect(can(a, 'users.manage')).toBe(true)
    expect(can(a, 'support.reply_client')).toBe(true)
    expect(can(a, 'clients.view_pii')).toBe(false)
    expect(can(a, 'payouts.view')).toBe(false)
    expect(can(a, 'payments.confirm')).toBe(false)
    expect(can(a, 'users.grant_super')).toBe(false)
  })
  it('client: only the portal', () => {
    expect(caps({ role: 'client' })).toEqual(['client.portal'])
  })
})

describe('super-admin flag', () => {
  it('adds pii + payouts + elevate, still not money', () => {
    const s = { role: 'admin', superAdmin: true }
    expect(can(s, 'clients.view_pii')).toBe(true)
    expect(can(s, 'payouts.view')).toBe(true)
    expect(can(s, 'payouts.manage')).toBe(true)
    expect(can(s, 'users.grant_super')).toBe(true)
    expect(can(s, 'payments.confirm')).toBe(false)   // money is a separate grant
  })
  it('super-admin only matters for an admin, not a production user', () => {
    expect(can({ role: 'user', superAdmin: true }, 'clients.view_pii')).toBe(false)
  })
})

describe('money gate (payments.confirm)', () => {
  it('granted by the explicit flag', () => {
    expect(can({ role: 'admin', superAdmin: true, canConfirmPayments: true }, 'payments.confirm')).toBe(true)
  })
  it('falls back to the seeded billing address when the flag is absent (mock mode)', () => {
    expect(can({ role: 'admin', email: 'vivek@resolute.com' }, 'payments.confirm')).toBe(true)
    expect(can({ role: 'admin', email: 'rajni@resolute.com' }, 'payments.confirm')).toBe(false)
  })
  it('an explicit false beats the email fallback', () => {
    expect(can({ role: 'admin', email: 'vivek@resolute.com', canConfirmPayments: false }, 'payments.confirm')).toBe(false)
  })
})

describe('per-user grants and revokes', () => {
  it('grant adds a capability to one account (e.g. billing to a super admin)', () => {
    const u = { role: 'admin', superAdmin: true, permissions: [{ capability: 'payments.confirm', effect: 'grant' }] }
    expect(can(u, 'payments.confirm')).toBe(true)
  })
  it('revoke removes a role-default capability from one account', () => {
    const u = { role: 'admin', permissions: [{ capability: 'users.manage', effect: 'revoke' }] }
    expect(can(u, 'users.manage')).toBe(false)
    expect(can(u, 'orders.assign')).toBe(true)   // others intact
  })
})

describe('stage-scoped work (the trainee case)', () => {
  const trainee = { role: 'user', permissions: [
    { capability: 'orders.work', effect: 'revoke' },                               // drop the all-stages default
    { capability: 'orders.work', effect: 'grant', scope: { stages: ['screener'] } }, // re-grant, screener only
  ] }
  it('may work the allowed stage only', () => {
    expect(can(trainee, 'orders.work', { stage: 'screener' })).toBe(true)
    expect(can(trainee, 'orders.work', { stage: 'examiner' })).toBe(false)
    expect(can(trainee, 'orders.work', { stage: 'typer' })).toBe(false)
  })
  it('workableStages reports the subset for a trainee, null for an unscoped worker', () => {
    expect(workableStages(trainee)).toEqual(['screener'])
    expect(workableStages({ role: 'user' })).toBeNull()         // all stages
    expect(workableStages({ role: 'client' })).toEqual([])      // none
  })
  it('an unscoped production user may work any stage', () => {
    const u = { role: 'user' }
    expect(can(u, 'orders.work', { stage: 'delivery' })).toBe(true)
  })
})

describe('backward compatibility', () => {
  it('with no grants, the set is exactly role+flags (nothing changes)', () => {
    expect(caps({ role: 'admin', superAdmin: true, canConfirmPayments: true })).toEqual([
      'clients.view_pii', 'orders.assign', 'orders.clarify', 'orders.hold',
      'orders.read', 'orders.work', 'payments.confirm', 'payouts.manage',
      'payouts.view', 'support.note', 'support.reply_client', 'users.grant_super', 'users.manage',
    ])
  })
  it('null / unknown principal holds nothing', () => {
    expect(can(null, 'orders.read')).toBe(false)
    expect(caps(undefined)).toEqual([])
  })
})
