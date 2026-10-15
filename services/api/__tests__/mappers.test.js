// Unit tests for the DB-row -> app-shape mapper (ADR 0002, B2). Pure — the API
// returns objects identical to the Supabase provider's, so the frontend can't
// tell which backend served a request.
import { test } from 'vitest'
import assert from 'node:assert/strict'
import { toAppOrder } from '../src/mappers.js'

test('toAppOrder maps snake_case columns to the app shape', () => {
  const o = toAppOrder({
    id: 'RTS-1', client_code: 'CL01', client_name: 'Acme', state: 'OH',
    assigned_user_id: null, workflow: null,
  })
  assert.equal(o.id, 'RTS-1')
  assert.equal(o.clientCode, 'CL01')
  assert.equal(o.client, 'Acme')
  assert.equal(o.state, 'OH')
  assert.deepEqual(o.workflow, {})
  assert.equal(o.assignedUserId, null)
})

test('toAppOrder falls back to the client code when the name is RLS-masked (null)', () => {
  const o = toAppOrder({ id: 'RTS-2', client_code: 'CL02', client_name: null })
  assert.equal(o.client, 'CL02')
})
