// Pure unit tests for the portable admin-user logic (B4), no DB / no auth
// provider. Runs in the root vitest (CI build job).
import { describe, it, expect } from 'vitest'
import { cleanPermissions, touchesElevated, buildProfilePatch, ELEVATED } from '../src/adminUsers.js'

describe('cleanPermissions', () => {
  it('treats undefined as "not provided"', () => {
    expect(cleanPermissions(undefined)).toEqual({ ok: true, value: undefined })
  })
  it('rejects a non-array', () => {
    expect(cleanPermissions('nope').ok).toBe(false)
  })
  it('requires a capability string + grant|revoke effect', () => {
    expect(cleanPermissions([{ capability: 'x', effect: 'maybe' }]).ok).toBe(false)
    expect(cleanPermissions([{ effect: 'grant' }]).ok).toBe(false)
  })
  it('keeps only string stages in a scope', () => {
    expect(cleanPermissions([{ capability: 'orders.work', effect: 'grant', scope: { stages: ['screener', 3, 'typer'] } }]))
      .toEqual({ ok: true, value: [{ capability: 'orders.work', effect: 'grant', scope: { stages: ['screener', 'typer'] } }] })
  })
})

describe('touchesElevated', () => {
  it('is true when super_admin / billing toggles are present', () => {
    expect(touchesElevated({ superAdmin: true }, undefined)).toBe(true)
    expect(touchesElevated({ canConfirmPayments: false }, undefined)).toBe(true)
  })
  it('is true when granting an elevated capability', () => {
    const cap = [...ELEVATED][0]
    expect(touchesElevated({}, [{ capability: cap, effect: 'grant' }])).toBe(true)
  })
  it('is false for a plain name/role edit or a revoke', () => {
    expect(touchesElevated({ name: 'x', role: 'user' }, undefined)).toBe(false)
    expect(touchesElevated({}, [{ capability: [...ELEVATED][0], effect: 'revoke' }])).toBe(false)
  })
})

describe('buildProfilePatch', () => {
  it('sets client_code only for a client role', () => {
    expect(buildProfilePatch({ role: 'client', clientCode: 'CL01' }, undefined)).toMatchObject({ role: 'client', client_code: 'CL01' })
    expect(buildProfilePatch({ role: 'user', clientCode: 'CL01' }, undefined)).toMatchObject({ role: 'user', client_code: null })
  })
  it('clears super_admin + billing on demotion from admin', () => {
    const p = buildProfilePatch({ role: 'user', superAdmin: true, canConfirmPayments: true }, undefined)
    expect(p.super_admin).toBe(false)
    expect(p.can_confirm_payments).toBe(false)
  })
  it('keeps super_admin + billing for an admin role', () => {
    const p = buildProfilePatch({ role: 'admin', superAdmin: true, canConfirmPayments: true }, undefined)
    expect(p.super_admin).toBe(true)
    expect(p.can_confirm_payments).toBe(true)
  })
  it('omits permissions when not provided, includes them when given', () => {
    expect('permissions' in buildProfilePatch({ name: 'x' }, undefined)).toBe(false)
    expect(buildProfilePatch({ name: 'x' }, []).permissions).toEqual([])
  })
})
