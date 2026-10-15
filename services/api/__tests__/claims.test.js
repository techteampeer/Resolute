// Unit tests for the per-transaction JWT claims builder (ADR 0002, B2).
// Pure — no database, no Firebase. Run: npm test
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { claimsForUser } from '../src/claims.js'

const UUID = '11111111-1111-4111-8111-111111111111'

test('claimsForUser puts profiles.id in sub and marks role authenticated', () => {
  const c = JSON.parse(claimsForUser({ id: UUID, email: 'a@b.com' }))
  assert.equal(c.sub, UUID)
  assert.equal(c.role, 'authenticated')
  assert.equal(c.email, 'a@b.com')
})

test('claimsForUser rejects a missing id', () => {
  assert.throws(() => claimsForUser({}), /profiles\.id/)
})

test('claimsForUser rejects a Firebase UID (non-uuid) in sub — the gcp/README trap', () => {
  assert.throws(() => claimsForUser({ id: 'aZ09FirebaseUid28charstringxx' }), /UUID/)
})

test('claimsForUser serializes a missing email to null', () => {
  const c = JSON.parse(claimsForUser({ id: UUID }))
  assert.equal(c.email, null)
})
